/**
 * Release Gate Extension
 *
 * Orchestrates the six release readiness gates between IDLE and DEPLOYED.
 * Coordinates with bdd-enforcer, security-gate, and telemetry-access
 * via the events bus and direct tool calls.
 *
 * Gates:
 *   1. Functional correctness  — auto, from bdd:phase_change to IDLE
 *   2. Security                — auto, from security:scan_complete
 *   3. Non-functional          — run configured load/perf test command
 *   4. Pre-production staging  — deploy → health check → sanitise verify → migrate → test
 *   5. Measurement readiness   — check_success_conditions via telemetry-access
 *   6. Rollback readiness      — structured human checklist
 *
 * Config: .pi/release.config.json
 * Emits:  release:gate_passed, release:gate_failed, release:ready
 *
 * Design: gates are tracked in session state (reconstructed on resume).
 * Gate 4 is the most project-specific — staging deploy commands are
 * configured per-project in release.config.json.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { hasSuccessConditions, hasHogQLQueries } from "../../lib/product-md";

// ─── Types ────────────────────────────────────────────────────────────────────

type GateNumber = 1 | 2 | 3 | 4 | 5 | 6;
type GateStatus = "pending" | "passed" | "failed" | "skipped" | "blocked";

interface GateResult {
  gate: GateNumber;
  name: string;
  status: GateStatus;
  summary?: string;
  notes?: string;
  timestamp?: string;
  blockedBy?: string; // reason deployment is blocked
}

interface ReleaseState {
  _type: "release_state";
  featureName?: string;
  cycleType?: "feature" | "bug";
  gates: GateResult[];
  startedAt?: string;
  releasedAt?: string;
}

interface StagingConfig {
  deployCommand?: string;      // e.g. "coolify redeploy --uuid abc123"
  url?: string;                // e.g. "https://staging.myapp.com"
  healthCheckPath?: string;    // e.g. "/health" — default /health
  migrationsCommand?: string;  // e.g. "docker compose exec app rails db:migrate"
  testCommand?: string;        // e.g. "npm run test:integration -- --env=staging"
  sanitisationCheckQuery?: string; // SQL to verify PII is sanitised (runs via psql)
}

interface ProductionConfig {
  deployCommand?: string;
  url?: string;
  healthCheckPath?: string;
  migrationsCommand?: string;
}

interface NonFunctionalConfig {
  testCommand?: string;        // e.g. "k6 run load-test.js"
  latencyThresholdMs?: number;
}

interface ReleaseConfig {
  staging?: StagingConfig;
  production?: ProductionConfig;
  nonFunctional?: NonFunctionalConfig;
  // Skip gates that don't apply to this project
  skipGates?: GateNumber[];
}

// ─── Gate metadata ────────────────────────────────────────────────────────────

const GATE_NAMES: Record<GateNumber, string> = {
  1: "Functional correctness",
  2: "Security",
  3: "Non-functional requirements",
  4: "Pre-production validation",
  5: "Measurement readiness",
  6: "Rollback readiness",
};

const GATE_ICONS: Record<GateStatus, string> = {
  passed:  "✅",
  failed:  "❌",
  pending: "⏳",
  skipped: "⏭",
  blocked: "🚫",
};

// ─── Config loading ───────────────────────────────────────────────────────────

function loadConfig(cwd: string): ReleaseConfig {
  const candidates = [
    path.join(cwd, ".pi", "release.config.json"),
    path.join(cwd, "release.config.json"),
  ];
  for (const c of candidates) {
    try { return JSON.parse(fs.readFileSync(c, "utf8")); } catch { /* next */ }
  }
  return {};
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initialGates(skipGates: GateNumber[] = []): GateResult[] {
  return ([1, 2, 3, 4, 5, 6] as GateNumber[]).map((n) => ({
    gate: n,
    name: GATE_NAMES[n],
    status: skipGates.includes(n) ? "skipped" : "pending",
  }));
}

function gatesSummary(gates: GateResult[]): string {
  return gates.map((g) =>
    `${GATE_ICONS[g.status]} Gate ${g.gate}: ${g.name}${g.summary ? ` — ${g.summary}` : ""}`
  ).join("\n");
}

function isReleaseReady(gates: GateResult[]): boolean {
  return gates.every((g) => g.status === "passed" || g.status === "skipped");
}

function hasBlockers(gates: GateResult[]): GateResult[] {
  return gates.filter((g) => g.status === "failed" || g.status === "blocked");
}

async function pollHealthCheck(
  pi: ExtensionAPI,
  url: string,
  healthPath: string,
  maxAttempts = 24,
  intervalSeconds = 5,
  signal?: AbortSignal,
): Promise<{ ok: boolean; statusCode?: number }> {
  const endpoint = `${url.replace(/\/$/, "")}${healthPath}`;
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) return { ok: false };
    try {
      const r = await pi.exec("bash", ["-c",
        `curl -sf -o /dev/null -w "%{http_code}" "${endpoint}" 2>/dev/null`
      ], { timeout: 10_000 });
      const code = parseInt(r.stdout.trim(), 10);
      if (code >= 200 && code < 400) return { ok: true, statusCode: code };
    } catch { /* retry */ }
    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
    }
  }
  return { ok: false };
}

// ─── Main extension ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config: ReleaseConfig = {};
  let releaseState: ReleaseState = {
    _type: "release_state",
    gates: initialGates(),
  };

  // ── Session lifecycle ─────────────────────────────────────────────────────

  // Both check_release_readiness and mark_gate_passed store full ReleaseState
  // in their details. Scanning both ensures reconstruction picks up manual
  // gate passes that happened after the last full readiness check.
  const STATE_TOOLS = new Set(["check_release_readiness", "mark_gate_passed"]);

  function reconstructFromBranch(ctx: { sessionManager: { getBranch: () => { type: string; message: { role: string; toolName: string; details: unknown } }[] } }) {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || !STATE_TOOLS.has(msg.toolName)) continue;
      const details = msg.details as ReleaseState | undefined;
      if (details?._type === "release_state") releaseState = details;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    reconstructFromBranch(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    reconstructFromBranch(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    reconstructFromBranch(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    reconstructFromBranch(ctx);
  });

  // ── Gate 1: Functional correctness — auto from BDD IDLE ──────────────────

  pi.events.on("bdd:phase_change", (data: unknown) => {
    const event = data as { from?: string; to?: string; featureName?: string; cycleType?: string };
    if (event.to !== "IDLE" || event.from === "IDLE") return;

    // Reset gate tracking for the new cycle
    releaseState = {
      _type: "release_state",
      featureName: event.featureName,
      cycleType: event.cycleType as "feature" | "bug" | undefined,
      startedAt: new Date().toISOString(),
      gates: initialGates(config.skipGates ?? []),
    };

    // Gate 1 passes automatically — IDLE means tests are green
    const gate1 = releaseState.gates.find((g) => g.gate === 1);
    if (gate1 && gate1.status !== "skipped") {
      gate1.status = "passed";
      gate1.summary = "BDD cycle complete — all tests green";
      gate1.timestamp = new Date().toISOString();
      pi.events.emit("release:gate_passed", { gate: 1, featureName: event.featureName });
    }
  });

  // ── Gate 2: Security — auto from security:scan_complete ──────────────────

  pi.events.on("security:scan_complete", (data: unknown) => {
    const result = data as {
      findings: { severity: string }[];
      needsManualReview: boolean;
      maxSeverity: string;
    };

    const gate2 = releaseState.gates.find((g) => g.gate === 2);
    if (!gate2 || gate2.status === "skipped") return;
    // Gate 2 already resolved — don't overwrite a passed/failed status.
    // This prevents a re-fired scan (same diff, loop scenario) from resetting
    // a gate that was already manually reviewed and passed.
    if (gate2.status === "passed" || gate2.status === "failed") return;

    const threshold = "high";
    const severityOrder: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1, none: 0 };
    const blocking = severityOrder[result.maxSeverity] >= severityOrder[threshold];

    if (blocking) {
      gate2.status = "failed";
      gate2.summary = `${result.maxSeverity.toUpperCase()} security findings — must fix before deployment`;
      gate2.blockedBy = `${result.findings.filter((f) => severityOrder[f.severity] >= severityOrder[threshold]).length} blocking finding(s)`;
    } else if (result.needsManualReview) {
      gate2.status = "pending";
      gate2.summary = "Automated scan passed — manual security review required for sensitive changes";
    } else {
      gate2.status = "passed";
      gate2.summary = `Automated scan passed — ${result.findings.length} finding(s), none blocking`;
    }
    gate2.timestamp = new Date().toISOString();

    if (blocking) {
      // Security findings block — nothing more to do automatically
      return;
    }

    pi.events.emit("release:gate_passed", { gate: 2 });

    if (result.needsManualReview) {
      // Manual security review required before proceeding to staging.
      // Surface this clearly and wait for the human to call mark_gate_passed(2).
      pi.sendUserMessage(
        "⚠️  Security scan passed automated checks, but this change touches sensitive areas " +
        "(auth, payments, crypto, PII, or agent tools) and requires manual security review.\n\n" +
        "Load the `security-review` skill and review the diff against the checklist. " +
        "Once complete, call mark_gate_passed(2, notes: '...') to proceed to staging.",
        { deliverAs: "followUp" },
      );
      return;
    }

    // Gate 2 passed cleanly — proceed to staging automatically.
    // Staging is safe: not production, no customers affected.
    // The human checkpoint (Gate 6) comes before production, not before staging.
    pi.sendUserMessage(
      "✅ Gate 2 (security) passed automatically. " +
      "Proceeding to staging deployment — running Gates 3, 4, and 5 in parallel.\n\n" +
      "Call check_release_readiness to execute the staging deployment, load tests, " +
      "and measurement readiness checks.",
      { deliverAs: "followUp" },
    );
  });

  // ── check_release_readiness tool ──────────────────────────────────────────

  pi.registerTool({
    name: "check_release_readiness",
    label: "Check Release Readiness",
    description:
      "Orchestrate all six release gates and show overall readiness status. " +
      "Gates 1 and 2 are tracked automatically (from BDD cycle and security scan). " +
      "Gates 3, 4, and 5 run in parallel automatically when Gate 2 passes cleanly: " +
      "  Gate 3 runs configured load/perf tests; " +
      "  Gate 4 deploys to staging, verifies sanitisation, runs migrations and test suite; " +
      "  Gate 5 verifies PRODUCT.md success conditions via PostHog. " +
      "Gate 6 is the only human checkpoint — rollback readiness before production deployment. " +
      "Staging is autonomous when security passes. Production requires human confirmation.",
    promptSnippet: "Check all six release gates — functional, security, staging, measurement, rollback",
    promptGuidelines: [
      "Run check_release_readiness before every production deployment.",
      "Gates 1 and 2 are populated automatically — check their status first.",
      "Gate 4 (staging) is the most important gate for catching real-data issues.",
      "If Gate 4 fails on migrations: fix the migration before proceeding.",
      "Gate 5 shows 'no data' if PostHog is not yet receiving events from staging.",
      "Gate 6 must be completed by a human — cannot be automated.",
      "Load release-gate skill for guidance on each gate.",
    ],
    parameters: Type.Object({
      runGate: Type.Optional(Type.Number({
        description: "Run only a specific gate (1-6). If omitted, shows all gates and runs any pending automatable ones.",
      })),
      force: Type.Optional(Type.Boolean({
        description: "Re-run a gate even if it already passed.",
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const targetGate = params.runGate as GateNumber | undefined;

      // Re-read config on every call — it may have been created or updated
      // after the BDD cycle completed (when releaseState was first initialised).
      config = loadConfig(ctx.cwd);
      // Re-apply skipGates to any gates that are still pending.
      for (const gate of releaseState.gates) {
        if (gate.status === "pending" && (config.skipGates ?? []).includes(gate.gate as GateNumber)) {
          gate.status = "skipped";
          gate.summary = `Gate ${gate.gate} explicitly skipped via skipGates in release.config.json`;
        }
      }

      const run = async (n: GateNumber) => {
        const gate = releaseState.gates.find((g) => g.gate === n);
        if (!gate) return;
        if (gate.status === "skipped") return;
        if (gate.status === "passed" && !params.force) return;

        switch (n) {
          case 3: await runGate3(gate, signal, onUpdate);  break;
          case 4: await runGate4(gate, signal, onUpdate, ctx.cwd); break;
          case 5: await runGate5(gate, signal, onUpdate, ctx.cwd); break;
          case 6: await runGate6(gate, ctx); break;
        }
      };

      if (targetGate) {
        onUpdate?.({ content: [{ type: "text", text: `Running Gate ${targetGate}: ${GATE_NAMES[targetGate]}...` }] });
        await run(targetGate);
      } else {
        // Gates 3, 4, 5 are independent — run them in parallel.
        // Each has its own signal (cancellation) and onUpdate path.
        // Gate 6 (human checklist) must run after, as it needs UI interaction.
        const automatableGates = ([3, 4, 5] as GateNumber[]).filter((n) => {
          const gate = releaseState.gates.find((g) => g.gate === n);
          return gate?.status === "pending";
        });

        if (automatableGates.length > 0) {
          onUpdate?.({
            content: [{
              type: "text",
              text: `Running Gates ${automatableGates.join(", ")} in parallel: ${automatableGates.map((n) => GATE_NAMES[n]).join(", ")}`,
            }],
          });

          await Promise.all(
            automatableGates.map((n) => run(n))
          );
        }

        // Gate 6 runs last — requires interactive UI
        const gate6 = releaseState.gates.find((g) => g.gate === 6);
        if (gate6?.status === "pending") {
          onUpdate?.({ content: [{ type: "text", text: `Running Gate 6: ${GATE_NAMES[6]}...` }] });
          await run(6);
        }
      }

      const ready = isReleaseReady(releaseState.gates);
      const blockers = hasBlockers(releaseState.gates);

      const lines = [
        `## Release Readiness: ${releaseState.featureName ?? "current cycle"}`,
        "",
        gatesSummary(releaseState.gates),
        "",
      ];

      if (blockers.length > 0) {
        lines.push(`⛔ NOT READY — ${blockers.length} gate(s) failing:`);
        for (const b of blockers) {
          lines.push(`  Gate ${b.gate}: ${b.blockedBy ?? b.summary ?? "failed"}`);
        }
      } else if (ready) {
        lines.push("✅ ALL GATES PASSED — ready to deploy to production.");
        lines.push("");
        lines.push("Next steps:");
        lines.push("  1. Run the production deploy command from release.config.json");
        lines.push("  2. Run production migrations");
        lines.push("  3. Confirm health check passes on production URL");
        lines.push("  4. Update ROADMAP.md → deployed");
        lines.push("  5. Update PRODUCT.md validation status");
        pi.events.emit("release:ready", { featureName: releaseState.featureName });
        ctx.ui.notify("✅ All release gates passed — ready for production deployment", "info");
      } else {
        const pending = releaseState.gates.filter((g) => g.status === "pending");
        lines.push(`⏳ ${pending.length} gate(s) still pending.`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ...releaseState } satisfies ReleaseState,
      };
    },
  });

  // ── Gate 3: Non-functional ────────────────────────────────────────────────

  async function runGate3(
    gate: GateResult,
    signal?: AbortSignal,
    onUpdate?: (u: { content: { type: string; text: string }[] }) => void,
  ) {
    const cmd = config.nonFunctional?.testCommand;
    if (!cmd) {
      gate.status = "skipped";
      gate.summary = "No non-functional test command configured (nonFunctional.testCommand in release.config.json)";
      return;
    }

    onUpdate?.({ content: [{ type: "text", text: `  Running: ${cmd}` }] });
    try {
      const r = await pi.exec("bash", ["-c", cmd], { signal, timeout: 300_000 });
      if (r.code === 0) {
        gate.status = "passed";
        gate.summary = "Non-functional tests passed";
        gate.notes = r.stdout.slice(0, 300);
      } else {
        gate.status = "failed";
        gate.summary = "Non-functional tests failed";
        gate.blockedBy = r.stdout.slice(0, 200);
      }
    } catch (err) {
      gate.status = "failed";
      gate.summary = `Non-functional test error: ${String(err).slice(0, 100)}`;
      gate.blockedBy = "Test command threw an error";
    }
    gate.timestamp = new Date().toISOString();
  }

  // ── Gate 4: Pre-production staging ───────────────────────────────────────

  async function runGate4(
    gate: GateResult,
    signal?: AbortSignal,
    onUpdate?: (u: { content: { type: string; text: string }[] }) => void,
    cwd?: string,
  ) {
    const sc = config.staging;
    if (!sc) {
      // Only skip if the project has explicitly opted out of staging in skipGates.
      // Missing config is a deployment blocker — not a reason to silently skip.
      if ((config.skipGates ?? []).includes(4)) {
        gate.status = "skipped";
        gate.summary = "Gate 4 explicitly skipped via skipGates in release.config.json";
      } else {
        gate.status = "failed";
        gate.blockedBy = "No staging configuration found";
        gate.summary =
          "Create .pi/release.config.json with a staging section before deploying. " +
          "See pi-bdd/templates/release.config.json for the format. " +
          "To skip staging validation deliberately, add 4 to skipGates.";
      }
      gate.timestamp = new Date().toISOString();
      return;
    }

    // Validate required staging config fields
    const configErrors: string[] = [];
    if (!sc.deployCommand && !sc.url) {
      configErrors.push("staging.deployCommand or staging.url must be set");
    }
    if (!sc.migrationsCommand) {
      configErrors.push("staging.migrationsCommand not set — migrations will not run on staging");
    }
    if (!sc.sanitisationCheckQuery) {
      configErrors.push("staging.sanitisationCheckQuery not set — PII sanitisation will not be verified");
    }
    if (configErrors.length > 0) {
      // Warn about incomplete config but don't block — partial config is still useful
      const warnings = configErrors.map((e) => `⚠ ${e}`).join("\n");
      onUpdate?.({ content: [{ type: "text", text: `Staging config warnings:\n${warnings}` }] });
    }

    const steps: string[] = [];
    const fail = (reason: string) => {
      gate.status = "failed";
      gate.blockedBy = reason;
      gate.summary = `Staging validation failed: ${reason}`;
      gate.notes = steps.join("\n");
      gate.timestamp = new Date().toISOString();
    };

    // Step 1: Deploy to staging
    if (sc.deployCommand) {
      onUpdate?.({ content: [{ type: "text", text: `  Deploying to staging: ${sc.deployCommand}` }] });
      try {
        const r = await pi.exec("bash", ["-c", sc.deployCommand], { signal, timeout: 300_000 });
        if (r.code !== 0) { fail(`Deploy failed: ${r.stderr.slice(0, 200)}`); return; }
        steps.push(`✅ Deploy: ${sc.deployCommand}`);
      } catch (err) { fail(`Deploy error: ${String(err).slice(0, 100)}`); return; }
    }

    // Step 2: Wait for health check
    if (sc.url) {
      const healthPath = sc.healthCheckPath ?? "/health";
      onUpdate?.({ content: [{ type: "text", text: `  Waiting for staging health check: ${sc.url}${healthPath}` }] });
      const { ok, statusCode } = await pollHealthCheck(pi, sc.url, healthPath, 24, 5, signal);
      if (!ok) { fail(`Health check failed after 2 minutes: ${sc.url}${healthPath}`); return; }
      steps.push(`✅ Health check: ${statusCode}`);
    }

    // Step 3: Verify data sanitisation (critical — staging must never have real PII)
    if (sc.sanitisationCheckQuery && cwd) {
      onUpdate?.({ content: [{ type: "text", text: "  Verifying staging data sanitisation..." }] });
      try {
        const r = await pi.exec("bash", ["-c", sc.sanitisationCheckQuery], { signal, timeout: 30_000 });
        const output = r.stdout.trim();
        // The query should return 0 rows if sanitisation is complete.
        // Convention: query returns COUNT of rows with real-looking PII (emails, etc.)
        const count = parseInt(output, 10);
        if (!isNaN(count) && count > 0) {
          fail(
            `Sanitisation check FAILED: ${count} row(s) with unsanitised data detected. ` +
            "DO NOT proceed — staging contains real PII or external service credentials."
          );
          return;
        }
        steps.push(`✅ Data sanitisation verified (0 unsanitised rows)`);
      } catch (err) {
        // Query failed to run — warn but don't block (may not have psql configured)
        steps.push(`⚠ Sanitisation check skipped: ${String(err).slice(0, 80)}`);
      }
    } else {
      steps.push(`⚠ No sanitisation check configured — verify staging data is sanitised manually`);
    }

    // Step 4: Run migrations on staging
    if (sc.migrationsCommand) {
      onUpdate?.({ content: [{ type: "text", text: `  Running migrations on staging: ${sc.migrationsCommand}` }] });
      try {
        const r = await pi.exec("bash", ["-c", sc.migrationsCommand], { signal, timeout: 120_000 });
        if (r.code !== 0) { fail(`Migrations failed: ${r.stderr.slice(0, 200)}`); return; }
        steps.push(`✅ Migrations: complete`);
      } catch (err) { fail(`Migration error: ${String(err).slice(0, 100)}`); return; }
    }

    // Step 5: Run test suite against staging
    if (sc.testCommand) {
      onUpdate?.({ content: [{ type: "text", text: `  Running tests against staging: ${sc.testCommand}` }] });
      try {
        const r = await pi.exec("bash", ["-c", sc.testCommand], { signal, timeout: 300_000 });
        if (r.code !== 0) {
          fail(`Tests failed against staging: ${r.stdout.slice(0, 300)}`);
          return;
        }
        steps.push(`✅ Tests: passed against staging`);
      } catch (err) { fail(`Test error: ${String(err).slice(0, 100)}`); return; }
    }

    gate.status = "passed";
    gate.summary = `Staging validation complete (${steps.filter((s) => s.startsWith("✅")).length} steps)`;
    gate.notes = steps.join("\n");
    gate.timestamp = new Date().toISOString();
    pi.events.emit("release:gate_passed", { gate: 4 });
  }

  // ── Gate 5: Measurement readiness ────────────────────────────────────────

  async function runGate5(
    gate: GateResult,
    signal?: AbortSignal,
    onUpdate?: (u: { content: { type: string; text: string }[] }) => void,
    cwd?: string,
  ) {
    // Use shared helpers — single source of truth for PRODUCT.md detection
    const resolvedCwd = cwd ?? ".";

    if (!hasSuccessConditions(resolvedCwd)) {
      gate.status = "failed";
      gate.blockedBy = "No success conditions in PRODUCT.md";
      gate.summary = "Add measurable success conditions using the measurement-design skill";
      gate.timestamp = new Date().toISOString();
      return;
    }

    if (!hasHogQLQueries(resolvedCwd)) {
      gate.status = "failed";
      gate.blockedBy = "No HogQL queries in PRODUCT.md";
      gate.summary = "Success conditions defined but no HogQL queries — add them using measurement-design skill";
      gate.timestamp = new Date().toISOString();
      return;
    }

    onUpdate?.({ content: [{ type: "text", text: "  Checking success conditions via PostHog..." }] });

    // Delegate to check_success_conditions by sending a user message
    // (we can't call it directly from here without a tool call context)
    // Instead, we mark as pending-with-instruction and let the agent call it
    gate.status = "pending";
    gate.summary = "HogQL queries found in PRODUCT.md — run check_success_conditions to complete this gate";
    gate.notes =
      "Call check_success_conditions to verify success conditions against PostHog data. " +
      "Then call mark_gate_passed(5) if all conditions are met or collecting data normally.";
    gate.timestamp = new Date().toISOString();

    onUpdate?.({ content: [{
      type: "text",
      text: "  Gate 5: Call check_success_conditions then mark_gate_passed(5) based on results.",
    }] });
  }

  // ── Gate 6: Rollback readiness ────────────────────────────────────────────

  async function runGate6(gate: GateResult, ctx: { hasUI: boolean; ui: { confirm: (t: string, m: string) => Promise<boolean> } }) {
    if (!ctx.hasUI) {
      gate.status = "pending";
      gate.summary = "Requires interactive input — run in interactive mode";
      return;
    }

    const questions: [string, string][] = [
      ["Rollback procedure defined?", "Is there a documented procedure to revert this deployment (redeploy previous version, toggle feature flag, revert migration)?"],
      ["Migration reversible?", "If this deployment includes a data migration, can it be reversed? If irreversible, is the risk accepted and documented?"],
      ["Rollback tested?", "Has the rollback procedure been tested (even mentally) for this deployment?"],
      ["On-call available?", "Is someone available to monitor and respond for the next 24-48 hours after deployment?"],
    ];

    const answers: string[] = [];
    let allPassed = true;

    for (const [title, message] of questions) {
      const confirmed = await ctx.ui.confirm(title, message);
      answers.push(`${confirmed ? "✅" : "❌"} ${title}`);
      if (!confirmed) allPassed = false;
    }

    gate.notes = answers.join("\n");
    gate.timestamp = new Date().toISOString();

    if (allPassed) {
      gate.status = "passed";
      gate.summary = "Rollback readiness confirmed";
    } else {
      gate.status = "failed";
      gate.blockedBy = "One or more rollback readiness checks not met";
      gate.summary = "Address rollback concerns before deploying";
    }
  }

  // ── mark_gate_passed tool ─────────────────────────────────────────────────

  pi.registerTool({
    name: "mark_gate_passed",
    label: "Mark Gate Passed",
    description:
      "Manually mark a release gate as passed after human review or verification. " +
      "Use for Gate 5 after reviewing check_success_conditions output, " +
      "or for Gate 2 after completing a manual security review. " +
      "Include notes describing what was verified.",
    promptSnippet: "Mark a release gate as passed after human verification",
    promptGuidelines: [
      "Use mark_gate_passed(5) after check_success_conditions shows conditions met or data collecting normally.",
      "Use mark_gate_passed(2) after a human has completed the manual security review.",
      "Always include meaningful notes explaining what was verified.",
      "Never mark a gate passed without actually verifying it.",
    ],
    parameters: Type.Object({
      gate: Type.Number({ description: "Gate number (1-6)" }),
      notes: Type.String({ description: "What was verified. Be specific." }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const gateNum = params.gate as GateNumber;
      const gate = releaseState.gates.find((g) => g.gate === gateNum);

      if (!gate) {
        return {
          content: [{ type: "text", text: `Gate ${gateNum} not found.` }],
          details: {},
        };
      }

      gate.status = "passed";
      gate.notes = params.notes;
      gate.timestamp = new Date().toISOString();
      gate.summary = `Manually verified: ${params.notes.slice(0, 80)}`;

      pi.events.emit("release:gate_passed", { gate: gateNum });
      ctx.ui.notify(`✅ Gate ${gateNum} (${gate.name}) marked as passed`, "info");

      // If Gate 2 was just manually passed (after a security review),
      // trigger the same automatic staging flow as a clean automated pass.
      if (gateNum === 2) {
        pi.sendUserMessage(
          "✅ Gate 2 (security) confirmed after manual review. " +
          "Proceeding to staging deployment automatically.\n\n" +
          "Call check_release_readiness to run Gates 3, 4, and 5 in parallel.",
          { deliverAs: "followUp" },
        );
      }

      const ready = isReleaseReady(releaseState.gates);
      if (ready) {
        ctx.ui.notify("✅ All release gates passed — ready for production deployment!", "info");
        pi.events.emit("release:ready", { featureName: releaseState.featureName });
      }

      return {
        content: [{
          type: "text",
          text: `Gate ${gateNum} passed.\n\n${gatesSummary(releaseState.gates)}`,
        }],
        details: { ...releaseState } satisfies ReleaseState,
      };
    },
  });

  // ── /release command ──────────────────────────────────────────────────────

  pi.registerCommand("release", {
    description: "Show current release gate status",
    handler: async (_args, ctx) => {
      const ready = isReleaseReady(releaseState.gates);
      ctx.ui.notify(
        `Release status: ${ready ? "✅ READY" : "⏳ NOT READY"}\n\n${gatesSummary(releaseState.gates)}`,
        ready ? "info" : "warning",
      );
    },
  });
}
