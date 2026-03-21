/**
 * Security Gate Extension
 *
 * Runs automated security scanning after every BDD cycle completes (IDLE
 * transition) and on demand. Three automated layers plus manual review
 * detection for sensitive changes.
 *
 * Automated layers:
 *   1. Secrets detection  — gitleaks / trufflehog / grep fallback
 *   2. Dependency scanning — npm audit / pip-audit / bundler-audit / govulncheck
 *   3. SAST               — semgrep with security-audit ruleset
 *
 * Manual review detection:
 *   Scans the diff for patterns (auth, payment, crypto, PII, etc.) and
 *   flags changes that need a human security review before deployment.
 *
 * Config: .pi/security.config.json (optional — sensible defaults used without it)
 * Emits:  security:scan_complete { findings, severity, needsManualReview }
 *         so the release-gate extension can integrate when built.
 *
 * Design: does NOT block the IDLE transition. BDD discipline (write gate)
 * and security discipline are orthogonal concerns. Security findings are
 * surfaced as blockers to DEPLOYMENT, not to completing the development cycle.
 *
 * Pre-commit hook:
 *   Use setup_precommit to install a git pre-commit hook that runs secrets
 *   detection before every commit — catching secrets at the earliest possible
 *   point rather than waiting for the post-IDLE scan.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity = "critical" | "high" | "medium" | "low" | "info";

interface SecurityFinding {
  layer: "secrets" | "dependencies" | "sast" | "manual-review";
  severity: Severity;
  title: string;
  detail: string;
  file?: string;
  remediation?: string;
}

interface ScanResult {
  findings: SecurityFinding[];
  layersRun: string[];
  layersSkipped: string[];
  needsManualReview: boolean;
  manualReviewReasons: string[];
  maxSeverity: Severity | "none";
}

interface SecurityConfig {
  secrets?: "gitleaks" | "trufflehog" | "grep" | "none";
  sast?: "semgrep" | "none";
  dependencies?: boolean;
  manualReviewPatterns?: string[];
  // Severity threshold above which findings are treated as deployment blockers
  blockingThreshold?: Severity;
  // Run automatically after every IDLE transition (default: true)
  autoRunOnIdle?: boolean;
}

const DEFAULT_CONFIG: SecurityConfig = {
  secrets: "gitleaks",
  sast: "semgrep",
  dependencies: true,
  blockingThreshold: "high",
  autoRunOnIdle: true,
  manualReviewPatterns: [
    "auth", "authoris", "authoriz", "authenticat",
    "payment", "billing", "stripe", "checkout",
    "crypto", "encrypt", "decrypt", "cipher", "hash",
    "password", "passwd", "credential",
    "pii", "gdpr", "personal_data", "ssn", "dob",
    "session", "cookie", "jwt", "token",
    "admin", "privilege", "permission", "role",
    "secret", "private_key", "certificate",
    "mcp", "tool.*register", "register.*tool",
  ],
};

const SEVERITY_ORDER: Record<Severity | "none", number> = {
  critical: 5, high: 4, medium: 3, low: 2, info: 1, none: 0,
};

// ─── Config loading ───────────────────────────────────────────────────────────

function loadConfig(cwd: string): SecurityConfig {
  const candidates = [
    path.join(cwd, ".pi", "security.config.json"),
    path.join(cwd, "security.config.json"),
  ];
  for (const c of candidates) {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(c, "utf8")) };
    } catch { /* try next */ }
  }
  return DEFAULT_CONFIG;
}

// ─── Tool availability ────────────────────────────────────────────────────────

async function isAvailable(pi: ExtensionAPI, cmd: string): Promise<boolean> {
  try {
    const r = await pi.exec("bash", ["-c", `which ${cmd} 2>/dev/null`], { timeout: 5_000 });
    return r.code === 0 && r.stdout.trim().length > 0;
  } catch { return false; }
}

async function detectStack(cwd: string): Promise<string[]> {
  const stacks: string[] = [];
  const checks: [string, string][] = [
    ["package.json",     "npm"],
    ["Gemfile.lock",     "bundler"],
    ["requirements.txt", "pip"],
    ["pyproject.toml",   "pip"],
    ["go.mod",           "go"],
    ["Cargo.toml",       "cargo"],
    ["pom.xml",          "maven"],
    ["build.gradle",     "gradle"],
  ];
  for (const [file, stack] of checks) {
    if (fs.existsSync(path.join(cwd, file))) stacks.push(stack);
  }
  return stacks;
}

// ─── Secrets scanning ─────────────────────────────────────────────────────────

async function scanSecrets(
  pi: ExtensionAPI,
  cfg: SecurityConfig,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ findings: SecurityFinding[]; skipped: boolean; reason?: string }> {
  const tool = cfg.secrets ?? "gitleaks";

  if (tool === "none") return { findings: [], skipped: true, reason: "disabled" };

  // Try gitleaks
  if (tool === "gitleaks" || tool === "grep") {
    if (tool === "gitleaks" && await isAvailable(pi, "gitleaks")) {
      try {
        const r = await pi.exec("bash", ["-c",
          "gitleaks detect --source . --report-format json --no-git --exit-code 1 2>/dev/null || gitleaks detect --source . --report-format json --exit-code 1 2>/dev/null"
        ], { signal, timeout: 60_000 });

        if (r.code === 0) return { findings: [], skipped: false };

        const raw = r.stdout.trim() || r.stderr.trim();
        try {
          const parsed = JSON.parse(raw);
          const leaks = Array.isArray(parsed) ? parsed : [parsed];
          return {
            findings: leaks.slice(0, 20).map((l: { Description?: string; RuleID?: string; File?: string; Secret?: string }) => ({
              layer: "secrets" as const,
              severity: "critical" as const,
              title: `Secret detected: ${l.Description ?? l.RuleID ?? "unknown"}`,
              detail: `Found in ${l.File ?? "unknown file"}. Secret value redacted.`,
              file: l.File,
              remediation:
                "Remove the secret immediately. Rotate the credential — assume it is compromised. " +
                "Add the pattern to .gitleaks.toml to prevent recurrence. " +
                "Use environment variables or a secrets manager instead.",
            })),
            skipped: false,
          };
        } catch {
          // gitleaks found something but output wasn't parseable JSON
          if (r.code !== 0 && raw.length > 0) {
            return {
              findings: [{
                layer: "secrets",
                severity: "critical",
                title: "Secret(s) detected by gitleaks",
                detail: raw.slice(0, 500),
                remediation: "Run `gitleaks detect` manually for details. Remove and rotate any exposed secrets.",
              }],
              skipped: false,
            };
          }
          return { findings: [], skipped: false };
        }
      } catch { /* fall through to grep */ }
    }
  }

  // Try trufflehog
  if (tool === "trufflehog" && await isAvailable(pi, "trufflehog")) {
    try {
      const r = await pi.exec("bash", ["-c",
        "trufflehog filesystem . --json --no-update 2>/dev/null | head -20"
      ], { signal, timeout: 60_000 });

      const lines = r.stdout.trim().split("\n").filter(Boolean);
      if (lines.length === 0) return { findings: [], skipped: false };

      return {
        findings: lines.slice(0, 10).map((line) => {
          try {
            const parsed = JSON.parse(line);
            return {
              layer: "secrets" as const,
              severity: "critical" as const,
              title: `Secret detected: ${parsed.DetectorName ?? "unknown"}`,
              detail: `Found in ${parsed.SourceMetadata?.Data?.Filesystem?.file ?? "unknown file"}`,
              remediation: "Remove and rotate the exposed credential immediately.",
            };
          } catch {
            return {
              layer: "secrets" as const,
              severity: "critical" as const,
              title: "Secret detected by trufflehog",
              detail: line.slice(0, 200),
              remediation: "Remove and rotate the exposed credential immediately.",
            };
          }
        }),
        skipped: false,
      };
    } catch { /* fall through */ }
  }

  // Grep fallback — catches the most common patterns
  try {
    const patterns = [
      "AKIA[0-9A-Z]{16}",              // AWS key
      "sk-[a-zA-Z0-9]{32,}",           // OpenAI / Stripe / Anthropic-style
      "ghp_[a-zA-Z0-9]{36}",           // GitHub token
      "xox[baprs]-[0-9a-zA-Z-]{10,}",  // Slack token
      "password\\s*=\\s*[\"'][^\"']{8,}[\"']",
      "secret\\s*=\\s*[\"'][^\"']{8,}[\"']",
      "private_key\\s*=\\s*[\"'][^\"']{8,}[\"']",
    ].join("\\|");

    const r = await pi.exec("bash", ["-c",
      `git diff HEAD~1 HEAD 2>/dev/null | grep -E "${patterns}" | head -5 || ` +
      `grep -r -E "${patterns}" --include="*.ts" --include="*.js" --include="*.py" --include="*.rb" --include="*.env" . 2>/dev/null | grep -v ".git" | head -5`
    ], { signal, timeout: 20_000 });

    if (r.stdout.trim()) {
      return {
        findings: [{
          layer: "secrets",
          severity: "critical",
          title: "Possible secrets detected (grep pattern match)",
          detail: "Pattern matches found — review manually:\n" + r.stdout.slice(0, 400),
          remediation: "Install gitleaks for more accurate detection: https://github.com/gitleaks/gitleaks",
        }],
        skipped: false,
      };
    }
    return { findings: [], skipped: false };
  } catch {
    return { findings: [], skipped: true, reason: "No secrets scanning tool available. Install gitleaks: brew install gitleaks" };
  }
}

// ─── Dependency scanning ──────────────────────────────────────────────────────

async function scanDependencies(
  pi: ExtensionAPI,
  cfg: SecurityConfig,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ findings: SecurityFinding[]; skipped: boolean; reason?: string }> {
  if (!cfg.dependencies) return { findings: [], skipped: true, reason: "disabled" };

  const stacks = await detectStack(cwd);
  if (stacks.length === 0) return { findings: [], skipped: true, reason: "no recognised package manager" };

  const findings: SecurityFinding[] = [];
  const skippedStacks: string[] = [];

  for (const stack of stacks) {
    try {
      if (stack === "npm" && await isAvailable(pi, "npm")) {
        const r = await pi.exec("bash", ["-c", "npm audit --json 2>/dev/null"], { signal, timeout: 60_000 });
        try {
          const parsed = JSON.parse(r.stdout);
          const vulns = parsed.vulnerabilities ?? {};
          for (const [pkg, info] of Object.entries(vulns) as [string, { severity: string; via: unknown[] }][]) {
            if (["critical", "high"].includes(info.severity)) {
              findings.push({
                layer: "dependencies",
                severity: info.severity as Severity,
                title: `${info.severity.toUpperCase()} vulnerability in ${pkg}`,
                detail: `Package: ${pkg}. Run \`npm audit\` for full details.`,
                remediation: `Run \`npm audit fix\` or update ${pkg} to a patched version.`,
              });
            }
          }
        } catch {
          // npm audit returned non-zero with non-JSON output — vulnerabilities found
          if (r.code !== 0) {
            findings.push({
              layer: "dependencies",
              severity: "high",
              title: "npm audit found vulnerabilities",
              detail: r.stdout.slice(0, 400),
              remediation: "Run `npm audit` for details and `npm audit fix` to remediate.",
            });
          }
        }
      } else if (stack === "pip") {
        if (await isAvailable(pi, "pip-audit")) {
          const r = await pi.exec("bash", ["-c", "pip-audit --format json 2>/dev/null"], { signal, timeout: 60_000 });
          try {
            const parsed = JSON.parse(r.stdout);
            for (const dep of (parsed.dependencies ?? []) as { name: string; version: string; vulns: { id: string; fix_versions: string[] }[] }[]) {
              for (const vuln of dep.vulns ?? []) {
                findings.push({
                  layer: "dependencies",
                  severity: "high",
                  title: `Vulnerability in ${dep.name} ${dep.version}: ${vuln.id}`,
                  detail: `Fix versions: ${vuln.fix_versions?.join(", ") ?? "unknown"}`,
                  remediation: `Upgrade ${dep.name} to ${vuln.fix_versions?.[0] ?? "a patched version"}.`,
                });
              }
            }
          } catch { /* proceed */ }
        } else {
          skippedStacks.push("pip (pip-audit not installed: pip install pip-audit)");
        }
      } else if (stack === "bundler") {
        if (await isAvailable(pi, "bundle")) {
          const r = await pi.exec("bash", ["-c", "bundle exec bundle-audit check --update 2>&1 | head -30"], { signal, timeout: 60_000 });
          if (r.code !== 0 && r.stdout.includes("Vulnerability found")) {
            findings.push({
              layer: "dependencies",
              severity: "high",
              title: "bundler-audit found vulnerabilities",
              detail: r.stdout.slice(0, 400),
              remediation: "Run `bundle exec bundle-audit` for details and update affected gems.",
            });
          }
        } else {
          skippedStacks.push("bundler (bundler-audit not installed: gem install bundler-audit)");
        }
      } else if (stack === "go") {
        if (await isAvailable(pi, "govulncheck")) {
          const r = await pi.exec("bash", ["-c", "govulncheck -json ./... 2>/dev/null"], { signal, timeout: 60_000 });
          if (r.stdout.includes('"osv"')) {
            findings.push({
              layer: "dependencies",
              severity: "high",
              title: "govulncheck found vulnerabilities",
              detail: r.stdout.slice(0, 400),
              remediation: "Run `govulncheck ./...` for details.",
            });
          }
        } else {
          skippedStacks.push("go (govulncheck not installed: go install golang.org/x/vuln/cmd/govulncheck@latest)");
        }
      }
    } catch { skippedStacks.push(stack); }
  }

  const skipped = findings.length === 0 && skippedStacks.length === stacks.length;
  return {
    findings,
    skipped,
    reason: skippedStacks.length > 0 ? `Skipped: ${skippedStacks.join("; ")}` : undefined,
  };
}

// ─── SAST scanning ────────────────────────────────────────────────────────────

async function scanSAST(
  pi: ExtensionAPI,
  cfg: SecurityConfig,
  _cwd: string,
  signal?: AbortSignal,
): Promise<{ findings: SecurityFinding[]; skipped: boolean; reason?: string }> {
  const tool = cfg.sast ?? "semgrep";
  if (tool === "none") return { findings: [], skipped: true, reason: "disabled" };

  if (!await isAvailable(pi, "semgrep")) {
    return {
      findings: [],
      skipped: true,
      reason: "semgrep not installed. Install: brew install semgrep  or  pip install semgrep",
    };
  }

  try {
    const r = await pi.exec("bash", ["-c",
      "semgrep --config=p/security-audit --json --quiet 2>/dev/null"
    ], { signal, timeout: 120_000 });

    const raw = r.stdout.trim();
    if (!raw) return { findings: [], skipped: false };

    const parsed = JSON.parse(raw);
    const semgrepResults: { check_id: string; path: string; extra?: { severity?: string; message?: string; metadata?: { cwe?: string[] } } }[] =
      parsed.results ?? [];

    const findings: SecurityFinding[] = semgrepResults
      .filter((result) => {
        const sev = result.extra?.severity?.toLowerCase() ?? "medium";
        return ["error", "warning", "high", "critical", "medium"].includes(sev);
      })
      .slice(0, 15)
      .map((result) => {
        const rawSev = result.extra?.severity?.toLowerCase() ?? "medium";
        const severity: Severity =
          rawSev === "error" || rawSev === "critical" ? "high"
            : rawSev === "warning" ? "medium" : "low";
        return {
          layer: "sast" as const,
          severity,
          title: result.check_id.split(".").slice(-2).join("."),
          detail: `${result.path}: ${result.extra?.message?.slice(0, 150) ?? ""}`,
          file: result.path,
          remediation: result.extra?.metadata?.cwe
            ? `CWE reference: ${result.extra.metadata.cwe.join(", ")}`
            : "Review and remediate the identified pattern.",
        };
      });

    return { findings, skipped: false };
  } catch (err) {
    return {
      findings: [],
      skipped: true,
      reason: `semgrep error: ${String(err).slice(0, 100)}`,
    };
  }
}

// ─── Manual review detection ──────────────────────────────────────────────────

async function detectManualReview(
  pi: ExtensionAPI,
  cfg: SecurityConfig,
  _cwd: string,
  signal?: AbortSignal,
): Promise<{ needed: boolean; reasons: string[] }> {
  const patterns = cfg.manualReviewPatterns ?? DEFAULT_CONFIG.manualReviewPatterns ?? [];
  const reasons: string[] = [];

  try {
    const r = await pi.exec("bash", ["-c",
      "git diff HEAD~1 HEAD --name-only 2>/dev/null || git diff --cached --name-only 2>/dev/null"
    ], { signal, timeout: 10_000 });

    const changedFiles = r.stdout.trim().split("\n").filter(Boolean);
    const diffR = await pi.exec("bash", ["-c",
      "git diff HEAD~1 HEAD 2>/dev/null | head -200 || git diff --cached 2>/dev/null | head -200"
    ], { signal, timeout: 15_000 });
    const diffContent = diffR.stdout.toLowerCase();

    for (const pattern of patterns) {
      const regex = new RegExp(pattern, "i");
      const matchingFiles = changedFiles.filter((f) => regex.test(f));
      if (matchingFiles.length > 0) {
        reasons.push(`Files matching '${pattern}': ${matchingFiles.slice(0, 3).join(", ")}`);
        continue;
      }
      if (regex.test(diffContent)) {
        reasons.push(`Code changes matching '${pattern}' detected in diff`);
      }
    }
  } catch { /* no git, skip */ }

  // Deduplicate and limit
  const unique = [...new Set(reasons)].slice(0, 8);
  return { needed: unique.length > 0, reasons: unique };
}

// ─── Severity helpers ─────────────────────────────────────────────────────────

function maxSeverity(findings: SecurityFinding[]): Severity | "none" {
  if (findings.length === 0) return "none";
  return findings.reduce<Severity | "none">((max, f) => {
    return SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[max] ? f.severity : max;
  }, "none");
}

function isBlocking(severity: Severity | "none", threshold: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold];
}

// ─── Main extension ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config: SecurityConfig = DEFAULT_CONFIG;

  // ── Pre-commit hook content ───────────────────────────────────────────────

  const PRECOMMIT_HOOK = `#!/bin/sh
# Pre-commit secrets detection — installed by pi-bdd security-gate
# Catches secrets before they reach the repository.
# To bypass in an emergency: git commit --no-verify (use sparingly)

echo "🔍 Scanning staged files for secrets..."

if command -v gitleaks >/dev/null 2>&1; then
  if ! gitleaks protect --staged --exit-code 1 2>/dev/null; then
    echo ""
    echo "❌ Secrets detected in staged files. Commit blocked."
    echo "   Fix: remove the secret, then rotate the credential immediately."
    echo "   Bypass (emergency only): git commit --no-verify"
    exit 1
  fi
else
  # Grep fallback — catches the most common credential formats
  PATTERN='AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{32,}|ghp_[a-zA-Z0-9]{36}|xox[baprs]-[0-9a-zA-Z-]{10,}|password[[:space:]]*=[[:space:]]*["\'][^"'"'"']{8,}["\']|secret[[:space:]]*=[[:space:]]*["\'][^"'"'"']{8,}["\']'
  if git diff --cached | grep -E "$PATTERN" >/dev/null 2>&1; then
    echo ""
    echo "⚠️  Possible secrets detected (grep pattern match). Commit paused."
    echo "   Review staged changes carefully before proceeding."
    echo "   Install gitleaks for accurate detection: brew install gitleaks"
    echo "   Bypass if false positive: git commit --no-verify"
    exit 1
  fi
fi

echo "✅ No secrets detected in staged files"
exit 0
`;

  // ── Session start: check pre-commit hook ─────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);

    // Check if pre-commit hook is installed; notify if not
    const hookPath = path.join(ctx.cwd, ".git", "hooks", "pre-commit");
    const gitExists = fs.existsSync(path.join(ctx.cwd, ".git"));
    if (gitExists && !fs.existsSync(hookPath)) {
      ctx.ui.notify(
        "⚠️  No git pre-commit hook detected. Secrets will only be scanned after IDLE.\n" +
        "Run setup_precommit to install pre-commit secrets detection.",
        "warning",
      );
    } else if (gitExists && fs.existsSync(hookPath)) {
      const hookContent = fs.readFileSync(hookPath, "utf8");
      if (!hookContent.includes("pi-bdd") && !hookContent.includes("gitleaks")) {
        ctx.ui.notify(
          "ℹ️  A pre-commit hook exists but does not include secrets detection. " +
          "Run setup_precommit to add it.",
          "info",
        );
      }
    }
  });

  // ── Auto-run after every IDLE transition ──────────────────────────────────

  pi.events.on("bdd:phase_change", async (data: unknown) => {
    const event = data as { from?: string; to?: string };
    if (event.to !== "IDLE" || event.from === "IDLE") return;
    if (!config.autoRunOnIdle) return;

    // Run in background — don't block the IDLE transition
    // The results surface as notifications
    setTimeout(async () => {
      try {
        // We need a ctx here but events don't carry one.
        // Emit a user message that triggers the scan tool instead.
        pi.sendUserMessage(
          "The BDD cycle just completed. Please run security_scan now to check for secrets, " +
          "vulnerable dependencies, and SAST issues before this is deployed.",
          { deliverAs: "followUp" }
        );
      } catch { /* silent */ }
    }, 500);
  });

  // ── security_scan tool ────────────────────────────────────────────────────

  pi.registerTool({
    name: "security_scan",
    label: "Security Scan",
    description:
      "Run automated security scanning against the current codebase. Three layers: " +
      "secrets detection (gitleaks/trufflehog), dependency scanning (npm audit/pip-audit/bundler-audit/govulncheck), " +
      "and SAST (semgrep with security-audit ruleset). " +
      "Also detects changes that need manual security review (auth, payments, crypto, PII, etc.). " +
      "Run after every BDD cycle completes, before deployment. " +
      "High/critical findings should block deployment (Gate 2 of release readiness).",
    promptSnippet: "Run security scan: secrets, dependencies, SAST, manual review detection",
    promptGuidelines: [
      "Run security_scan after every set_bdd_phase('IDLE') before deployment.",
      "Critical or high findings must be resolved before the feature is deployed.",
      "If manual review is flagged, a human with security awareness must review the diff before deployment.",
      "Secrets findings are always critical — rotate the credential immediately even if it was accidental.",
      "Medium/low SAST findings are informational — review but do not necessarily block.",
      "If tools are not installed, note what needs installing and proceed with what's available.",
    ],
    parameters: Type.Object({
      layer: Type.Optional(Type.Union([
        Type.Literal("all"),
        Type.Literal("secrets"),
        Type.Literal("dependencies"),
        Type.Literal("sast"),
      ], { description: "Which layer to run. Default: all" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const layer = params.layer ?? "all";
      const runAll = layer === "all";

      const layersRun: string[] = [];
      const layersSkipped: string[] = [];
      const allFindings: SecurityFinding[] = [];

      if (runAll || layer === "secrets") {
        onUpdate?.({ content: [{ type: "text", text: "🔍 Scanning for secrets..." }] });
        const { findings, skipped, reason } = await scanSecrets(pi, config, ctx.cwd, signal);
        allFindings.push(...findings);
        skipped ? layersSkipped.push(`secrets (${reason ?? "skipped"})`) : layersRun.push("secrets");
      }

      if (runAll || layer === "dependencies") {
        onUpdate?.({ content: [{ type: "text", text: "📦 Scanning dependencies..." }] });
        const { findings, skipped, reason } = await scanDependencies(pi, config, ctx.cwd, signal);
        allFindings.push(...findings);
        skipped ? layersSkipped.push(`dependencies (${reason ?? "skipped"})`) : layersRun.push("dependencies");
      }

      if (runAll || layer === "sast") {
        onUpdate?.({ content: [{ type: "text", text: "🔬 Running SAST (semgrep)..." }] });
        const { findings, skipped, reason } = await scanSAST(pi, config, ctx.cwd, signal);
        allFindings.push(...findings);
        skipped ? layersSkipped.push(`sast (${reason ?? "skipped"})`) : layersRun.push("sast");
      }

      onUpdate?.({ content: [{ type: "text", text: "👁 Detecting manual review requirements..." }] });
      const { needed: needsManualReview, reasons: manualReviewReasons } =
        await detectManualReview(pi, config, ctx.cwd, signal);

      const severity = maxSeverity(allFindings);
      const blocking = severity !== "none" && isBlocking(severity, config.blockingThreshold ?? "high");

      // Emit for release-gate integration
      const result: ScanResult = {
        findings: allFindings,
        layersRun,
        layersSkipped,
        needsManualReview,
        manualReviewReasons,
        maxSeverity: severity,
      };
      pi.events.emit("security:scan_complete", result);

      // Format output
      const lines: string[] = [`## Security Scan Results\n`];

      if (allFindings.length === 0 && !needsManualReview) {
        lines.push("✅ No security issues detected.");
      } else {
        // Critical and high first
        const critical = allFindings.filter((f) => f.severity === "critical");
        const high = allFindings.filter((f) => f.severity === "high");
        const medium = allFindings.filter((f) => f.severity === "medium");
        const low = allFindings.filter((f) => ["low", "info"].includes(f.severity));

        if (critical.length > 0) {
          lines.push(`### 🔴 CRITICAL — MUST FIX BEFORE DEPLOYMENT (${critical.length})\n`);
          for (const f of critical) {
            lines.push(`**[${f.layer}]** ${f.title}`);
            lines.push(`  ${f.detail}`);
            if (f.remediation) lines.push(`  → ${f.remediation}`);
            lines.push("");
          }
        }

        if (high.length > 0) {
          lines.push(`### 🟠 HIGH — Should fix before deployment (${high.length})\n`);
          for (const f of high) {
            lines.push(`**[${f.layer}]** ${f.title}`);
            lines.push(`  ${f.detail}`);
            if (f.remediation) lines.push(`  → ${f.remediation}`);
            lines.push("");
          }
        }

        if (medium.length > 0) {
          lines.push(`### 🟡 MEDIUM — Review recommended (${medium.length})\n`);
          for (const f of medium) {
            lines.push(`**[${f.layer}]** ${f.title}: ${f.detail.slice(0, 100)}`);
          }
          lines.push("");
        }

        if (low.length > 0) {
          lines.push(`### ⚪ LOW / INFO (${low.length}) — informational`);
          lines.push("");
        }
      }

      if (needsManualReview) {
        lines.push(`### 👤 Manual Security Review Required\n`);
        lines.push("This change touches sensitive areas. A human with security awareness must review the diff before deployment:\n");
        for (const reason of manualReviewReasons) {
          lines.push(`  - ${reason}`);
        }
        lines.push("");
        lines.push("Load the `security-review` skill for guidance on what to check.");
        lines.push("");
      }

      lines.push("─────");
      lines.push(`Layers run: ${layersRun.join(", ") || "none"}`);
      if (layersSkipped.length > 0) {
        lines.push(`Layers skipped: ${layersSkipped.join(" | ")}`);
      }

      if (blocking) {
        lines.push(`\n⛔ DEPLOYMENT BLOCKED: ${severity.toUpperCase()} severity findings must be resolved first.`);
        ctx.ui.notify(`⛔ Security scan: ${severity.toUpperCase()} findings — deployment blocked`, "warning");
      } else if (allFindings.length > 0 || needsManualReview) {
        lines.push(`\n⚠ Security review recommended before deployment.`);
        ctx.ui.notify(`⚠ Security scan complete: ${allFindings.length} finding(s)`, "info");
      } else {
        ctx.ui.notify("✅ Security scan: no issues found", "info");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  });

  // ── setup_precommit tool ─────────────────────────────────────────────────

  pi.registerTool({
    name: "setup_precommit",
    label: "Setup Pre-commit Hook",
    description:
      "Install a git pre-commit hook that runs secrets detection before every commit. " +
      "This catches secrets at the earliest possible point — before they enter the repository — " +
      "rather than waiting for the post-IDLE security scan. " +
      "Uses gitleaks if installed, falls back to grep pattern matching. " +
      "If a pre-commit hook already exists, appends the secrets check to it.",
    promptSnippet: "Install pre-commit secrets detection hook",
    promptGuidelines: [
      "Run setup_precommit once when setting up a new project with pi-bdd.",
      "The hook runs automatically on every git commit — no manual action needed after setup.",
      "Developers can bypass with git commit --no-verify in genuine emergencies.",
      "The hook does not replace the post-IDLE security_scan — it's an additional early layer.",
    ],
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({
        description: "Replace an existing pre-commit hook entirely rather than checking for conflicts.",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const gitDir = path.join(ctx.cwd, ".git");
      if (!fs.existsSync(gitDir)) {
        return {
          content: [{ type: "text", text: "No .git directory found. Not a git repository." }],
          details: { installed: false },
        };
      }

      const hooksDir = path.join(gitDir, "hooks");
      if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });

      const hookPath = path.join(hooksDir, "pre-commit");
      const hookExists = fs.existsSync(hookPath);

      if (hookExists && !params.force) {
        const existing = fs.readFileSync(hookPath, "utf8");
        if (existing.includes("pi-bdd") || existing.includes("gitleaks protect")) {
          return {
            content: [{ type: "text", text: "Pre-commit secrets hook is already installed." }],
            details: { installed: true, alreadyPresent: true },
          };
        }

        // Append to existing hook rather than replace
        const appended = existing.trimEnd() + "\n\n# --- pi-bdd secrets detection ---\n" +
          PRECOMMIT_HOOK.replace("#!/bin/sh\n", "");
        fs.writeFileSync(hookPath, appended, { mode: 0o755 });
        ctx.ui.notify("✅ Secrets detection appended to existing pre-commit hook", "info");
        return {
          content: [{ type: "text", text: "Secrets detection appended to existing pre-commit hook at .git/hooks/pre-commit" }],
          details: { installed: true, appended: true },
        };
      }

      // Install fresh hook
      fs.writeFileSync(hookPath, PRECOMMIT_HOOK, { mode: 0o755 });
      ctx.ui.notify("✅ Pre-commit secrets hook installed at .git/hooks/pre-commit", "info");

      return {
        content: [{
          type: "text",
          text: [
            "✅ Pre-commit hook installed at .git/hooks/pre-commit",
            "",
            "The hook will now run secrets detection before every git commit.",
            "Uses gitleaks if available (brew install gitleaks), falls back to grep patterns.",
            "Bypass in emergencies: git commit --no-verify",
            "",
            "Test it: git diff --cached | head -1  # then try: git commit -m 'test'",
          ].join("\n"),
        }],
        details: { installed: true, hookPath },
      };
    },
  });

  // ── /security command ─────────────────────────────────────────────────────

  pi.registerCommand("security", {
    description: "Show security scan status and run a scan",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Security gate configured. Run security_scan to scan the current codebase.\n\n" +
        `Config: secrets=${config.secrets ?? "gitleaks"}, sast=${config.sast ?? "semgrep"}, ` +
        `deps=${config.dependencies !== false}, autoRunOnIdle=${config.autoRunOnIdle !== false}`,
        "info",
      );
    },
  });
}
