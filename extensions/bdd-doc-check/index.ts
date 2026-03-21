/**
 * BDD Documentation Check Extension
 *
 * Adds a check_docs tool to the BDD cycle that verifies minimum-viable
 * documentation at the IDLE phase transition. Soft enforcement: fills
 * what it can from context, surfaces gaps, asks when uncertain.
 *
 * Documentation model: six categories per component
 *   1. What it's for (purpose)
 *   2. What it does (behaviour, cross-refs tests)
 *   3. How it does it (design approach, key decisions)
 *   4. Current status (in the requirements→implementation→deployment loop)
 *   5. Roadmap (planned items — omit if empty)
 *   6. Decisions (non-obvious choices — omit if none)
 *
 * Project-level: ROADMAP.md tracking all features through the R→I→D loop.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DocStatus =
  | "specified"      // requirement documented, no implementation yet
  | "implementing"   // BDD cycle in progress
  | "implemented"    // tests pass, not yet deployed
  | "deployed"       // live in production/released
  | "deprecated";    // no longer maintained

interface DocGap {
  component: string;
  docFile: string;
  missing: string[];      // categories not present at all
  stale: string[];        // optional categories worth considering
  statusMismatch: boolean; // doc status vs. BDD phase disagree
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read git diff --name-only to find files touched since the last commit.
 *  Uses layered fallbacks so it works on fresh repos that have only one commit,
 *  where HEAD~1 does not exist and staged/unstaged diffs may also be empty.
 */
async function getTouchedFiles(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  const toFiles = (stdout: string) =>
    stdout.trim().split("\n").filter(Boolean).map((f) => path.join(cwd, f));

  // 1. Changes in the most recent commit (normal case)
  try {
    const { stdout } = await pi.exec("git", ["diff", "--name-only", "HEAD~1", "HEAD"], { timeout: 10_000 });
    const files = toFiles(stdout);
    if (files.length) return files;
  } catch { /* repo may have only one commit — fall through */ }

  // 2. Staged changes (first commit or after reset)
  try {
    const { stdout } = await pi.exec("git", ["diff", "--name-only", "--cached"], { timeout: 10_000 });
    const files = toFiles(stdout);
    if (files.length) return files;
  } catch { /* fall through */ }

  // 3. Unstaged working-tree changes
  try {
    const { stdout } = await pi.exec("git", ["diff", "--name-only"], { timeout: 10_000 });
    const files = toFiles(stdout);
    if (files.length) return files;
  } catch { /* fall through */ }

  // 4. All tracked files (absolute last resort for a brand-new repo)
  try {
    const { stdout } = await pi.exec("git", ["ls-files"], { timeout: 10_000 });
    return toFiles(stdout);
  } catch {
    return [];
  }
}

/** Derive the component directory from a file path */
function getComponentDir(filePath: string, cwd: string): string {
  const rel = path.relative(cwd, filePath);
  const parts = rel.split(path.sep);
  // For single-file modules at root, return root
  // For nested: src/auth/AuthService.ts → src/auth
  if (parts.length <= 1) return cwd;
  return path.join(cwd, ...parts.slice(0, -1));
}

/** Find the documentation file for a component.
 *  Walks UP from componentDir toward cwd, stopping at the first directory
 *  that already has a README or DESIGN file. This ensures deeply-nested files
 *  (e.g. src/auth/services/AuthService.ts) find the feature-level README
 *  (src/auth/README.md) rather than expecting one per subdirectory.
 *  Falls back to the expected creation path if no existing doc is found.
 */
function findDocFile(componentDir: string, cwd: string): string {
  let dir = componentDir;
  while (dir.startsWith(cwd)) {
    for (const name of ["README.md", "DESIGN.md"]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (dir === cwd) break;
    dir = path.dirname(dir);
  }
  // No existing doc found — return the expected creation path
  return componentDir === cwd
    ? path.join(cwd, "README.md")
    : path.join(componentDir, "README.md");
}

/** Parse a markdown doc and return which of the six categories are present */
function analyseDoc(content: string): {
  hasPurpose: boolean;
  hasBehaviour: boolean;
  hasDesign: boolean;
  hasStatus: boolean;
  hasRoadmap: boolean;
  hasDecisions: boolean;
  status: DocStatus | null;
} {
  const lower = content.toLowerCase();
  const statusMatch = content.match(/\*\*Status\*\*:\s*(\w+)/i);
  const status = (statusMatch?.[1]?.toLowerCase() as DocStatus) ?? null;

  return {
    hasPurpose: /^>\s+\S/m.test(content) || lower.includes("what it's for") || lower.includes("purpose"),
    hasBehaviour: lower.includes("what it does") || lower.includes("## behaviour") || lower.includes("## behavior"),
    hasDesign: lower.includes("how it does") || lower.includes("## design") || lower.includes("## implementation"),
    hasStatus: !!status,
    hasRoadmap: lower.includes("## roadmap"),
    hasDecisions: lower.includes("## decision"),
    status,
  };
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── check_docs tool ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "check_docs",
    label: "Check Documentation",
    description:
      "Check that documentation is 'done enough' for all components touched in this BDD cycle. " +
      "Called automatically at IDLE transition, but can also be called manually. " +
      "Returns a structured list of gaps: missing categories and stale sections. " +
      "Also reminds about ROADMAP.md at the IDLE transition. The agent should fill gaps from " +
      "context where confident, and ask the user where uncertain.",
    promptSnippet: "Verify minimum-viable documentation for touched components",
    promptGuidelines: [
      "Call check_docs(atIdle: true) before completing set_bdd_phase('IDLE') to verify documentation is done enough.",
      "Pass atIdle: true at the IDLE transition to enable status-mismatch detection, ROADMAP reminder, and PRODUCT.md check.",
      "PRODUCT.md must have measurable success conditions and a telemetry spec for the feature before deployment (Gate 5).",
      "Fill missing categories from context (code, tests, this conversation) where you are confident.",
      "For design decisions or roadmap items you are uncertain about, ask the user.",
      "A deliberate 'not yet documented' choice should be noted in the doc file itself.",
      "Tests are documentation of behaviour — only add prose where tests don't fully express intent.",
    ],
    parameters: Type.Object({
      components: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Specific component directories or files to check. " +
            "If omitted, checks all components touched since last commit.",
        }),
      ),
      atIdle: Type.Optional(
        Type.Boolean({
          description:
            "Pass true when calling at the IDLE transition. Enables the status-mismatch " +
            "check (doc still says 'implementing' when cycle is complete) and the ROADMAP reminder.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Reading git diff to find touched components..." }] });

      const cwd = ctx.cwd;
      const roadmapPath = path.join(cwd, "ROADMAP.md");

      // Determine which files to check
      let touchedFiles: string[];
      if (params.components?.length) {
        touchedFiles = params.components.map((c) =>
          path.isAbsolute(c) ? c : path.join(cwd, c),
        );
      } else {
        touchedFiles = await getTouchedFiles(pi, cwd);
      }

      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Aborted." }], details: {} };
      }

      // Build a map from resolved docFile → componentName.
      // Deduplicating by docFile (not by componentDir) is essential because
      // findDocFile walks up — multiple nested files can resolve to the same README.
      // The componentName is derived from the docFile's own directory, not the
      // original file's immediate parent, so "src/auth/README.md" → "src/auth"
      // rather than "src/auth/services" or "src/auth/models".
      const docFileMap = new Map<string, string>(); // docFilePath → componentName
      for (const f of touchedFiles) {
        // Skip test files, fixtures, config, node_modules
        if (
          f.includes("node_modules") ||
          f.includes(".git") ||
          /\.(test|spec)\.|fixtures|__mocks__|_spec\.|_test\./.test(f) ||
          /\/(spec|specs|features|step_definitions|support|__tests__)\//i.test(f)
        ) continue;
        // If the path is itself a directory, use it directly rather than
        // deriving the parent via getComponentDir (which is for file paths).
        const isDir = (() => { try { return fs.statSync(f).isDirectory(); } catch { return false; } })();
        const dir = isDir ? f : getComponentDir(f, cwd);
        const docFile = findDocFile(dir, cwd);
        if (!docFileMap.has(docFile)) {
          const docDir = path.dirname(docFile);
          const componentName = path.relative(cwd, docDir) || path.basename(cwd);
          docFileMap.set(docFile, componentName);
        }
      }

      if (docFileMap.size === 0) {
        return {
          content: [{ type: "text", text: "No production component files found in touched files — nothing to check." }],
          details: { gaps: [], checkedFiles: [] },
        };
      }

      const gaps: DocGap[] = [];
      const checkedFiles: string[] = [];

      for (const [docFile, componentName] of docFileMap.entries()) {
        checkedFiles.push(docFile);

        const content = fs.existsSync(docFile) ? fs.readFileSync(docFile, "utf8") : "";
        const analysis = content ? analyseDoc(content) : {
          hasPurpose: false, hasBehaviour: false, hasDesign: false,
          hasStatus: false, hasRoadmap: false, hasDecisions: false, status: null,
        };

        const missing: string[] = [];
        const stale: string[] = [];

        if (!analysis.hasPurpose) missing.push("purpose (what it's for — one sentence summary)");
        if (!analysis.hasBehaviour) missing.push("behaviour (what it does — cross-reference tests)");
        if (!analysis.hasDesign) missing.push("design (how it does it — key approach and structure)");
        if (!analysis.hasStatus) missing.push("status (specified | implementing | implemented | deployed | deprecated)");

        // Only prompt about optional sections when required sections are already present.
        // No point asking "did you document decisions?" on a component missing basic docs.
        const isWellDocumented =
          analysis.hasPurpose && analysis.hasBehaviour &&
          analysis.hasDesign && analysis.hasStatus;
        if (isWellDocumented && !analysis.hasRoadmap) {
          stale.push("roadmap (consider: are there known planned extensions? if none, omit section)");
        }
        if (isWellDocumented && !analysis.hasDecisions) {
          stale.push("decisions (consider: were any non-obvious choices made? if none, omit section)");
        }

        // Status mismatch check: doc still says "implementing" but cycle is completing
        const statusMismatch = !!params.atIdle && analysis.status === "implementing";

        if (missing.length > 0 || stale.length > 0 || statusMismatch) {
          gaps.push({ component: componentName, docFile, missing, stale, statusMismatch });
        }

      }

      // Build summary
      const lines: string[] = [];

      if (gaps.length === 0) {
        lines.push("✓ Documentation is done enough for all touched components.");
      } else {
        lines.push(`Documentation gaps in ${gaps.length} component(s):\n`);
        for (const gap of gaps) {
          lines.push(`## ${gap.component}`);
          lines.push(`Doc file: ${gap.docFile}`);
          if (!fs.existsSync(gap.docFile)) lines.push("  (file does not exist — needs to be created)");
          if (gap.missing.length > 0) {
            lines.push(`Missing:`);
            for (const m of gap.missing) lines.push(`  - ${m}`);
          }
          if (gap.stale.length > 0) {
            lines.push(`Consider:`);
            for (const s of gap.stale) lines.push(`  - ${s}`);
          }
          if (gap.statusMismatch) {
            lines.push(`  - Status field still says "implementing" — update to "implemented"`);
          }
          lines.push("");
        }
      }

      // Remind about ROADMAP and PRODUCT.md at every IDLE transition
      if (params.atIdle) {
        if (!fs.existsSync(roadmapPath)) {
          lines.push(`\nNo ROADMAP.md found — call update_roadmap to create it.`);
        } else {
          lines.push(`\nReminder: call update_roadmap to update feature status.`);
        }

        // Check that PRODUCT.md exists and has success conditions for this feature.
        // Without success conditions, Gate 5 (measurement readiness) cannot pass
        // and the feature cannot be validated in production.
        const productPath = path.join(cwd, "PRODUCT.md");
        if (!fs.existsSync(productPath)) {
          lines.push(
            `\n⚠ No PRODUCT.md found. Before deploying, define product success conditions ` +
            `and a telemetry spec so Gate 5 (measurement readiness) can be verified. ` +
            `See templates/PRODUCT.md for the format.`,
          );
        } else {
          const productContent = fs.readFileSync(productPath, "utf8").toLowerCase();
          const hasSuccessConditions =
            productContent.includes("success condition") ||
            productContent.includes("## success") ||
            productContent.includes("we will know");
          if (!hasSuccessConditions) {
            lines.push(
              `\n⚠ PRODUCT.md exists but no success conditions detected. ` +
              `Add measurable success conditions for this feature before deploying.`,
            );
          } else {
            lines.push(`\nReminder: verify PRODUCT.md success conditions have a telemetry spec that covers them.`);
          }
        }
      }

      lines.push(`\nChecked: ${checkedFiles.map((f) => path.relative(cwd, f)).join(", ") || "none"}`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { gaps, checkedFiles },
      };
    },
  });

  // ── update_doc_status tool ────────────────────────────────────────────────

  pi.registerTool({
    name: "update_doc_status",
    label: "Update Doc Status",
    description:
      "Update the Status field in a component's documentation file to reflect " +
      "its current position in the requirements→implementation→deployment loop. " +
      "Call when a component moves between phases (e.g. implemented→deployed).",
    promptSnippet: "Update documentation status to reflect R→I→D loop position",
    parameters: Type.Object({
      docFile: Type.String({ description: "Path to the documentation file (README.md or DESIGN.md)" }),
      status: StringEnum(["specified", "implementing", "implemented", "deployed", "deprecated"] as const),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absPath = path.isAbsolute(params.docFile)
        ? params.docFile
        : path.join(ctx.cwd, params.docFile);

      if (!fs.existsSync(absPath)) {
        return {
          content: [{ type: "text", text: `File not found: ${absPath}` }],
          details: { updated: false },
        };
      }

      let content = fs.readFileSync(absPath, "utf8");

      if (/\*\*Status\*\*:\s*\w+/i.test(content)) {
        content = content.replace(/\*\*Status\*\*:\s*\w+/i, `**Status**: ${params.status}`);
      } else {
        // Insert after the first heading
        content = content.replace(/^(#[^\n]+\n)/, `$1\n**Status**: ${params.status}\n`);
      }

      fs.writeFileSync(absPath, content, "utf8");

      return {
        content: [{ type: "text", text: `Updated status to "${params.status}" in ${params.docFile}` }],
        details: { updated: true, status: params.status },
      };
    },
  });

  // ── update_roadmap tool ───────────────────────────────────────────────────

  pi.registerTool({
    name: "update_roadmap",
    label: "Update Roadmap",
    description:
      "Update ROADMAP.md to reflect a feature's current position in the " +
      "requirements→implementation→deployment loop. " +
      "Moves entries between sections (Specified, Implementing, Implemented, Deployed, Deprecated).",
    promptSnippet: "Move a feature to its current R→I→D status in ROADMAP.md",
    parameters: Type.Object({
      feature: Type.String({ description: "Feature name as it appears (or should appear) in ROADMAP.md" }),
      status: StringEnum(["specified", "implementing", "implemented", "deployed", "deprecated"] as const),
      description: Type.Optional(Type.String({ description: "Brief description to add if the feature is new to ROADMAP.md" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const roadmapPath = path.join(ctx.cwd, "ROADMAP.md");

      let content = fs.existsSync(roadmapPath)
        ? fs.readFileSync(roadmapPath, "utf8")
        : ROADMAP_TEMPLATE;

      const sectionHeadings: Record<string, string> = {
        specified:     "## Specified",
        implementing:  "## Implementing",
        implemented:   "## Implemented",
        deployed:      "## Deployed",
        deprecated:    "## Deprecated",
      };

      const targetSection = sectionHeadings[params.status];
      const escapedFeature = params.feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // Capture existing description before removing the line, so we can preserve it
      const existingLineMatch = content.match(
        new RegExp(`^\\s*-\\s*\\[[ x]\\]\\s*${escapedFeature}([^\n]*)`, "im"),
      );
      const existingTrail = existingLineMatch?.[1]?.trim() ?? "";
      // existingTrail may be "— some description" or empty

      // Remove from any existing section
      const featurePattern = new RegExp(
        `^\\s*-\\s*\\[[ x]\\]\\s*${escapedFeature}[^\n]*\n?`,
        "gim",
      );
      content = content.replace(featurePattern, "");

      // Determine trailing description: explicit param wins, then existing, then nothing
      const trail = params.description
        ? ` — ${params.description}`
        : existingTrail
        ? ` ${existingTrail}`  // already includes the em-dash if original had one
        : "";

      // deployed, implemented, deprecated all get [x] — work is complete in each case
      const isDone =
        params.status === "deployed" ||
        params.status === "implemented" ||
        params.status === "deprecated";
      const checkbox = isDone ? "[x]" : "[ ]";
      const entry = `- ${checkbox} ${params.feature}${trail}`;

      // Add to target section
      if (content.includes(targetSection)) {
        content = content.replace(targetSection, `${targetSection}\n${entry}`);
      } else {
        content = `${content.trim()}\n\n${targetSection}\n${entry}\n`;
      }

      // Clean up multiple blank lines
      content = content.replace(/\n{3,}/g, "\n\n").trim() + "\n";

      fs.writeFileSync(roadmapPath, content, "utf8");

      return {
        content: [{ type: "text", text: `Moved "${params.feature}" to ${params.status} in ROADMAP.md` }],
        details: { feature: params.feature, status: params.status },
      };
    },
  });

  // ── /docs command ──────────────────────────────────────────────────────────

  pi.registerCommand("docs", {
    description: "Show documentation status for the current project",
    handler: async (_args, ctx) => {
      const roadmapPath = path.join(ctx.cwd, "ROADMAP.md");
      if (!fs.existsSync(roadmapPath)) {
        ctx.ui.notify("No ROADMAP.md found. Run check_docs to create one.", "warning");
        return;
      }
      const content = fs.readFileSync(roadmapPath, "utf8");
      ctx.ui.notify(content.slice(0, 2000), "info");
    },
  });
}

// ─── Templates ────────────────────────────────────────────────────────────────

const ROADMAP_TEMPLATE = `# Roadmap

## Deployed

## Implemented

## Implementing

## Specified

## Considering
`;
