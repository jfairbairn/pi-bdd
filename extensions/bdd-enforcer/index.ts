/**
 * BDD Enforcer Extension
 *
 * Implements the outside-in BDD state machine and enforces red-green-refactor.
 *
 * State machine:
 *   IDLE → AWAITING_RED → RED → GREEN → REFACTOR → IDLE (or back to RED)
 *
 * Enforcement:
 *   - Blocks write/edit to production paths when phase is IDLE or AWAITING_RED
 *   - Parses test output from bash and run_tests tool to drive phase transitions
 *   - Injects current phase context into every agent turn
 *   - Shows phase prominently in footer status
 *
 * Config (.pi/bdd.config.json or project root bdd.config.json):
 *   productionPaths, testPaths, testFilePatterns, testCommand
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type BDDPhase = "IDLE" | "AWAITING_RED" | "RED" | "GREEN" | "REFACTOR";

interface BDDConfig {
  productionPaths: string[];
  testPaths: string[];
  testFilePatterns: string[];
  testCommand: string;
}

interface TestResult {
  passed: number;
  failed: number;
  total: number;
  exitCode: number;
  raw: string;
}

export type BugType = "gap" | "spec-defect" | "requirements" | "non-functional";
export type CycleType = "feature" | "bug";

interface BDDStateDetails {
  _tool: "bdd_state";
  phase: BDDPhase;
  cycleType?: CycleType;
  featureName?: string;
  layer?: string;
  testResult?: TestResult;
  // Bug-specific
  bugType?: BugType;
  bugDescription?: string;
  bugExpected?: string;
  issueRef?: string;
  // Refactor boundary
  boundarySpecs?: string[];
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: BDDConfig = {
  productionPaths: ["src/", "lib/", "app/", "pkg/", "cmd/", "server/", "client/"],
  testPaths: [
    "test/", "tests/", "spec/", "specs/",
    "__tests__/", "features/", "step_definitions/",
    "__mocks__/", "fixtures/", "support/",
  ],
  testFilePatterns: [
    "\\.test\\.", "\\.spec\\.", "\\.feature$",
    "_test\\.go$", "_spec\\.rb$", "_test\\.py$",
  ],
  testCommand: "npm test",
};

const PHASE_LABELS: Record<BDDPhase, string> = {
  IDLE:         "⚪ IDLE",
  AWAITING_RED: "🟡 AWAITING RED",
  RED:          "🔴 RED",
  GREEN:        "🟢 GREEN",
  REFACTOR:     "🔵 REFACTOR",
};

const BUG_TYPE_LABELS: Record<BugType, string> = {
  "gap":             "Gap (unspecified behaviour)",
  "spec-defect":     "Spec Defect (test was wrong)",
  "requirements":    "Requirements Misunderstanding",
  "non-functional":  "Non-Functional (perf/security/concurrency)",
};

const PHASE_INSTRUCTIONS: Record<BDDPhase, string> = {
  IDLE: `No active BDD cycle. Use /feature or /scenario to begin, or describe what you want to build.`,

  AWAITING_RED: `A spec has been written but not yet confirmed failing.
REQUIRED: Run the tests now to confirm they fail before writing any production code.
Use the run_tests tool (preferred) or bash to run the test suite.
DO NOT write to production code paths until you have confirmed red.
For bug cycles (spec-defect type): correct the existing test until it fails, then run_tests.`,

  RED: `A failing test is confirmed. ✓
You may now write the MINIMUM production code to make the test pass.
- Write only what is needed to satisfy the spec — nothing more
- Do not anticipate future requirements
- Do not refactor yet
- When done, run run_tests to confirm green`,

  GREEN: `All tests are passing. ✓
You have two options:
1. Enter REFACTOR phase: clean up the code you just wrote (set_bdd_phase → REFACTOR)
2. Begin the next inner layer: write a spec for a dependency, then run_tests to confirm red`,

  REFACTOR: `Refactoring phase.
- Boundary specs are write-locked — they define the public behavioural contract that must be preserved
- You may freely create, edit, or delete any production file or non-boundary test file
- Run tests before and after every change to confirm they stay green
- If tests go red: revert immediately — the change altered observable behaviour
- No new externally-visible behaviour — if you spot a missing case, write a spec for it in the next cycle
- When complete: set_bdd_phase → IDLE (or AWAITING_RED for the next scenario)`,
};

// ─── Config loading ───────────────────────────────────────────────────────────

function loadConfig(cwd: string): BDDConfig {
  const candidates = [
    path.join(cwd, ".pi", "bdd.config.json"),
    path.join(cwd, "bdd.config.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      // not found or invalid — try next
    }
  }
  return DEFAULT_CONFIG;
}

// ─── Path classification ──────────────────────────────────────────────────────

/** Normalise a file path to a cwd-relative string with no leading "./". */
function normalisePath(filePath: string, cwd: string): string {
  const rel = filePath.startsWith("/") ? path.relative(cwd, filePath) : filePath;
  return rel.startsWith("./") ? rel.slice(2) : rel;
}

function classifyPath(
  filePath: string,
  config: BDDConfig,
  cwd: string,
): "production" | "test" | "unknown" {
  const rel = normalisePath(filePath, cwd);

  // Check test file name patterns first (e.g. *.test.ts)
  for (const pattern of config.testFilePatterns) {
    if (new RegExp(pattern).test(rel)) return "test";
  }


  // Check path prefixes
  for (const p of config.testPaths) {
    if (rel.startsWith(p) || rel.includes(`/${p}`)) return "test";
  }
  for (const p of config.productionPaths) {
    if (rel.startsWith(p) || rel.includes(`/${p}`)) return "production";
  }

  return "unknown";
}

// ─── Test output parsing ──────────────────────────────────────────────────────

function parseTestOutput(stdout: string, stderr: string, exitCode: number): TestResult | null {
  const output = `${stdout}\n${stderr}`;

  // Only attempt to parse if this looks like test output
  const testRunnerSignals = [
    /vitest/i, /jest/i, /rspec/i, /cucumber/i, /pytest/i,
    /✓|✗|PASS|FAIL|passed|failed|pending|examples|scenarios/i,
  ];
  if (!testRunnerSignals.some((r) => r.test(output))) return null;

  let passed = 0;
  let failed = 0;

  // Vitest / Jest style: "X passed", "X failed"
  const passMatch = output.match(/(\d+)\s+passed/i);
  const failMatch = output.match(/(\d+)\s+failed/i);
  if (passMatch) passed = parseInt(passMatch[1], 10);
  if (failMatch) failed = parseInt(failMatch[1], 10);

  // RSpec style: "X examples, Y failures"
  const rspecMatch = output.match(/(\d+)\s+examples?,\s*(\d+)\s+failures?/i);
  if (rspecMatch) {
    passed = parseInt(rspecMatch[1], 10) - parseInt(rspecMatch[2], 10);
    failed = parseInt(rspecMatch[2], 10);
  }

  // Cucumber style: "X scenarios (Y failed, Z passed)"
  const cucumberMatch = output.match(/(\d+)\s+scenarios?\s*\(([^)]+)\)/i);
  if (cucumberMatch) {
    const parts = cucumberMatch[2];
    const cf = parts.match(/(\d+)\s+failed/i);
    const cp = parts.match(/(\d+)\s+passed/i);
    if (cf) failed = parseInt(cf[1], 10);
    if (cp) passed = parseInt(cp[1], 10);
  }

  // Pytest style: "X passed, Y failed"
  const pytestMatch = output.match(/=+\s*(.*?)\s*=+\s*$/m);
  if (pytestMatch) {
    const summary = pytestMatch[1];
    const pf = summary.match(/(\d+)\s+passed/i);
    const pfl = summary.match(/(\d+)\s+failed/i);
    if (pf) passed = parseInt(pf[1], 10);
    if (pfl) failed = parseInt(pfl[1], 10);
  }

  // Go test style: look for FAIL/ok lines
  if (/^(ok|FAIL)\s+/m.test(output)) {
    failed = (output.match(/^FAIL\s+/gm) || []).length;
    passed = (output.match(/^ok\s+/gm) || []).length;
  }

  // Fallback: trust exit code
  if (passed === 0 && failed === 0) {
    if (exitCode === 0) passed = 1;
    else failed = 1;
  }

  return {
    passed,
    failed,
    total: passed + failed,
    exitCode,
    raw: output.slice(0, 500), // truncate for storage
  };
}

// ─── State reconstruction ─────────────────────────────────────────────────────

function reconstructState(ctx: ExtensionContext): BDDStateDetails {
  let state: BDDStateDetails = { _tool: "bdd_state", phase: "IDLE" };

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult") continue;
    // All three tools store BDDStateDetails in their result — scan all of them.
    // report_bug must be included so bug-cycle state survives session resume.
    if (
      msg.toolName !== "run_tests" &&
      msg.toolName !== "set_bdd_phase" &&
      msg.toolName !== "report_bug"
    ) continue;
    const details = msg.details as BDDStateDetails | undefined;
    if (details?._tool === "bdd_state") {
      state = details;
    }
  }

  return state;
}

// ─── Main extension ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config: BDDConfig = DEFAULT_CONFIG;
  let state: BDDStateDetails = { _tool: "bdd_state", phase: "IDLE" };

  // ── Helpers ──────────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext) {
    const label = PHASE_LABELS[state.phase];
    const cycleIcon = state.cycleType === "bug" ? "🐛 " : "";
    let status = cycleIcon + label;
    if (state.featureName) status += `  |  ${state.featureName}`;
    if (state.layer) status += `  [${state.layer}]`;
    if (state.issueRef) status += `  (${state.issueRef})`;
    if (state.testResult) {
      const r = state.testResult;
      status += `  |  ${r.passed} passed, ${r.failed} failed`;
    }
    ctx.ui.setStatus("bdd-phase", status);
  }

  function phaseContext(): string {
    const bugContext = state.cycleType === "bug" ? [
      `Cycle type: BUG FIX`,
      state.bugType ? `Bug type: ${BUG_TYPE_LABELS[state.bugType]}` : "",
      state.bugDescription ? `Reported behaviour: ${state.bugDescription}` : "",
      state.bugExpected ? `Expected behaviour: ${state.bugExpected}` : "",
      state.issueRef ? `Issue: ${state.issueRef}` : "",
      state.bugType === "spec-defect"
        ? `IMPORTANT: Fix the test first — correct it until it fails, then fix implementation.`
        : "",
      state.bugType === "requirements"
        ? `IMPORTANT: Revise the feature spec and get agreement before touching any test or code.`
        : "",
    ].filter(Boolean) : [];

    return [
      `\n=== BDD Phase: ${state.phase}${state.cycleType === "bug" ? " (BUG FIX)" : ""} ===`,
      PHASE_INSTRUCTIONS[state.phase],
      ...bugContext,
      state.featureName ? `Active feature: ${state.featureName}` : "",
      state.layer ? `Current layer: ${state.layer}` : "",
      state.boundarySpecs?.length
        ? `Boundary specs (write-locked): ${state.boundarySpecs.join(", ")}`
        : "",
      state.testResult
        ? `Last test run: ${state.testResult.passed} passed, ${state.testResult.failed} failed`
        : "",
      `===\n`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // ── Session events ────────────────────────────────────────────────────────

  // ── Lifecycle registration ────────────────────────────────────────────
  //
  // Register as a coding loop implementation in the pi-software-lifecycle
  // coordination layer (if installed). This is a fire-and-forget emit —
  // if pi-software-lifecycle is not installed, the event is simply ignored.

  pi.events.emit("lifecycle:register", {
    loop: "coding",
    name: "BDD",
    description: "Outside-in BDD with red-green-refactor enforcement",
  });

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    state = reconstructState(ctx);
    updateStatus(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    state = reconstructState(ctx);
    updateStatus(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    state = reconstructState(ctx);
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    state = reconstructState(ctx);
    updateStatus(ctx);
  });

  // ── Context injection ─────────────────────────────────────────────────────

  pi.on("before_agent_start", async (event, _ctx) => {
    return {
      systemPrompt: event.systemPrompt + phaseContext(),
    };
  });

  // ── Write gate ────────────────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    const filePath = (event.input as { path: string }).path;
    const kind = classifyPath(filePath, config, ctx.cwd);

    if (kind === "production" && (state.phase === "IDLE" || state.phase === "AWAITING_RED")) {
      const msg =
        `BLOCKED: Cannot write to production path "${filePath}" in phase ${state.phase}.\n` +
        `You must have a confirmed failing test before writing production code.\n` +
        (state.phase === "IDLE"
          ? `Start by writing a spec file, then use run_tests to confirm it fails.`
          : `Run run_tests now to confirm your spec is failing (red), then you may write production code.`);

      ctx.ui.notify(`🚫 BDD write blocked: ${state.phase}`, "warning");
      return { block: true, reason: msg };
    }

    // In REFACTOR, boundary spec files are write-locked.
    if (state.phase === "REFACTOR" && state.boundarySpecs?.length) {
      const rel = normalisePath(filePath, ctx.cwd);

      for (const spec of state.boundarySpecs) {
        const normSpec = normalisePath(spec, ctx.cwd);
        if (rel === normSpec) {
          const msg =
            `BLOCKED: Cannot write to boundary spec "${filePath}" during REFACTOR.\n` +
            `Boundary specs define the behavioural contract this refactor must preserve — they are write-locked.\n` +
            `If the behaviour itself needs to change, exit REFACTOR, update the spec (confirm RED), ` +
            `implement, return to GREEN, then refactor.`;
          ctx.ui.notify(`🚫 Boundary spec write blocked: ${path.basename(filePath)}`, "warning");
          return { block: true, reason: msg };
        }
      }
    }

    return undefined;
  });

  // ── Bash test detection ───────────────────────────────────────────────────

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    // Only process if this looks like a deliberate test run
    const cmd = (event.input as { command?: string }).command ?? "";
    const isTestCommand =
      /\b(vitest|jest|rspec|cucumber|pytest|go test|npm test|yarn test|pnpm test|bun test|rake spec)\b/i.test(cmd);
    if (!isTestCommand) return undefined;

    const content = event.content[0];
    const stdout = content?.type === "text" ? content.text : "";
    const exitCode = (event.details as { exitCode?: number })?.exitCode ?? (event.isError ? 1 : 0);

    const result = parseTestOutput(stdout, "", exitCode);
    if (!result) return undefined;

    const prevPhase = state.phase;

    if (result.failed > 0) {
      if (state.phase === "IDLE" || state.phase === "AWAITING_RED") {
        state = { ...state, phase: "RED", testResult: result };
        ctx.ui.notify(`🔴 RED confirmed — ${result.failed} failing. You may now write production code.`, "info");
      } else if (state.phase === "REFACTOR") {
        state = { ...state, phase: "RED", testResult: result };
        ctx.ui.notify(`🔴 Refactor broke tests — reverted to RED.`, "warning");
      } else if (state.phase === "GREEN") {
        // New spec written while in GREEN (skipping set_bdd_phase AWAITING_RED) —
        // tests confirm failure, so jump straight to RED.
        state = { ...state, phase: "RED", testResult: result };
        ctx.ui.notify(
          `🔴 RED — new failing spec detected from GREEN. ` +
          `Tip: call set_bdd_phase("AWAITING_RED") before writing inner-layer specs.`,
          "info",
        );
      }
    } else if (result.passed > 0 && result.failed === 0) {
      if (state.phase === "RED") {
        state = { ...state, phase: "GREEN", testResult: result };
        ctx.ui.notify(`🟢 GREEN — all tests passing. Refactor or begin next layer.`, "info");
      } else if (state.phase === "REFACTOR") {
        state = { ...state, testResult: result };
        ctx.ui.notify(`🔵 REFACTOR — tests still green.`, "info");
      } else if (state.phase === "AWAITING_RED" || state.phase === "IDLE") {
        ctx.ui.notify(
          `⚠️  Tests passed without ever being red. Did you write the spec correctly? ` +
          `Ensure the spec actually fails before implementing.`,
          "warning",
        );
      }
    }

    if (state.phase !== prevPhase) updateStatus(ctx);
    return undefined;
  });

  // ── run_tests tool ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "run_tests",
    label: "Run Tests",
    description:
      "Run the project test suite and update the BDD phase based on results. " +
      "Always use this tool (rather than raw bash) to run tests during a BDD cycle, " +
      "so that phase transitions are tracked correctly. " +
      "Optionally override the test command for a focused run (e.g. a single file or tag).",
    promptSnippet: "Run tests and advance BDD phase (red/green detection)",
    promptGuidelines: [
      "Use run_tests instead of raw bash when running tests during a BDD cycle.",
      "Always call run_tests after writing a spec to confirm it is red before writing production code.",
      "Always call run_tests after writing production code to confirm it is green.",
      "Always call run_tests during refactor to confirm tests remain green.",
    ],
    parameters: Type.Object({
      command: Type.Optional(
        Type.String({
          description:
            "Test command override (e.g. 'npx vitest run src/auth' for focused run). " +
            "Defaults to the configured test command.",
        }),
      ),
      layer: Type.Optional(
        Type.String({
          description:
            "Name of the layer or component being tested (e.g. 'LoginForm', 'AuthService', 'UserRepository'). " +
            "Used for status display and commit messages.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cmd = params.command ?? config.testCommand;
      if (params.layer) state = { ...state, layer: params.layer };

      onUpdate?.({ content: [{ type: "text", text: `Running: ${cmd}` }] });

      let stdout = "";
      let exitCode = 0;
      try {
        const result = await pi.exec("bash", ["-c", cmd], { signal, timeout: 120_000 });
        stdout = `${result.stdout}\n${result.stderr}`.trim();
        exitCode = result.code ?? 0;
      } catch (err: unknown) {
        exitCode = 1;
        stdout = err instanceof Error ? err.message : String(err);
      }

      const prevPhase = state.phase;
      // parseTestOutput returns null when output doesn't look like a test runner at all.
      // Fall back to exit code: 0 = pass, non-zero = fail.
      const result = parseTestOutput(stdout, "", exitCode) ?? {
        passed: exitCode === 0 ? 1 : 0,
        failed: exitCode === 0 ? 0 : 1,
        total: 1,
        exitCode,
        raw: stdout.slice(0, 500),
      };

      let phaseChanged = false;

      if (result.failed > 0) {
        if (state.phase === "IDLE" || state.phase === "AWAITING_RED") {
          state = { ...state, phase: "RED", testResult: result };
          phaseChanged = true;
        } else if (state.phase === "REFACTOR") {
          state = { ...state, phase: "RED", testResult: result };
          phaseChanged = true;
        } else if (state.phase === "GREEN") {
          // New failing spec written while in GREEN — jump straight to RED.
          state = { ...state, phase: "RED", testResult: result };
          phaseChanged = true;
        }
      } else if (result.passed > 0 && result.failed === 0) {
        if (state.phase === "RED") {
          state = { ...state, phase: "GREEN", testResult: result };
          phaseChanged = true;
        } else {
          state = { ...state, testResult: result };
        }
      }

      updateStatus(ctx);

      // Emit phase change on the events bus (for git-checkpoint and others)
      if (phaseChanged) {
        pi.events.emit("bdd:phase_change", {
          from: prevPhase,
          to: state.phase,
          cycleType: state.cycleType ?? "feature",
          featureName: state.featureName,
          layer: state.layer,
          issueRef: state.issueRef,
          testResult: result,
        });
      }

      const wasGreen = prevPhase === "GREEN";
      const phaseNote =
        state.phase === "RED" && wasGreen
          ? "\n🔴 RED — new failing spec detected from GREEN. You may now write production code.\n" +
            "Tip: next time call set_bdd_phase('AWAITING_RED') before writing inner-layer specs."
          : state.phase === "RED"
          ? "\n✓ RED confirmed. You may now write production code."
          : state.phase === "GREEN"
          ? "\n✓ GREEN. All tests passing. Refactor or begin next layer."
          : state.phase === "REFACTOR"
          ? "\n✓ Tests still green during refactor."
          : state.phase === "AWAITING_RED"
          ? "\n⚠ Tests passed without going red first — ensure your spec is correctly failing."
          : "";

      return {
        content: [{ type: "text", text: `${stdout}${phaseNote}` }],
        details: { ...state, _tool: "bdd_state" } satisfies BDDStateDetails,
      };
    },

    renderCall(args, theme) {
      const cmd = args.command ? theme.fg("muted", args.command) : theme.fg("dim", config.testCommand);
      return new Text(`${theme.bold("run_tests")} ${cmd}`, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as BDDStateDetails | undefined;
      if (!details) return new Text("", 0, 0);
      const label = PHASE_LABELS[details.phase];
      const tr = details.testResult;
      const counts = tr ? `  ${theme.fg("success", `${tr.passed} passed`)}  ${tr.failed > 0 ? theme.fg("error", `${tr.failed} failed`) : ""}` : "";
      return new Text(`${label}${counts}`, 0, 0);
    },
  });

  // ── set_bdd_phase tool ────────────────────────────────────────────────────

  pi.registerTool({
    name: "set_bdd_phase",
    label: "Set BDD Phase",
    description:
      "Manually advance or set the BDD phase. Use to signal intent: " +
      "moving from GREEN into REFACTOR, completing a refactor (back to IDLE), " +
      "or starting a new feature/scenario (IDLE → AWAITING_RED). " +
      "Do NOT use to bypass the RED requirement — run_tests must confirm red automatically.",
    promptSnippet: "Advance BDD phase (REFACTOR, IDLE, AWAITING_RED)",
    promptGuidelines: [
      "Call set_bdd_phase('REFACTOR') when tests are green and you are ready to clean up code.",
      "Call set_bdd_phase('IDLE') when a full cycle is complete and no further refactoring is needed.",
      "Call set_bdd_phase('AWAITING_RED') when starting a new scenario or inner-layer spec.",
      "NEVER call set_bdd_phase('RED') directly — RED must be confirmed by run_tests.",
      "NEVER call set_bdd_phase('GREEN') directly — GREEN must be confirmed by run_tests.",
    ],
    parameters: Type.Object({
      phase: StringEnum(["IDLE", "AWAITING_RED", "REFACTOR"] as const),
      featureName: Type.Optional(
        Type.String({ description: "Name of the feature or scenario being worked on." }),
      ),
      layer: Type.Optional(
        Type.String({ description: "Name of the layer or component (e.g. 'AuthService', 'LoginForm')." }),
      ),
      boundarySpecs: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Spec file paths that define the behavioural boundary of this refactor. " +
            "These files are write-locked during REFACTOR — they represent the public contract " +
            "that must be preserved. Required when phase is REFACTOR. " +
            "Typically the outermost spec(s) written before this implementation cycle: " +
            "acceptance tests, API contract tests, or integration tests for the scope being refactored.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Guard: cannot manually set RED or GREEN
      const prevPhase = state.phase;

      // Validate allowed transitions
      const allowed: Record<string, BDDPhase[]> = {
        IDLE:         ["IDLE", "AWAITING_RED"],
        AWAITING_RED: ["IDLE", "AWAITING_RED"],
        RED:          ["IDLE"], // can abandon
        GREEN:        ["REFACTOR", "IDLE", "AWAITING_RED"],
        REFACTOR:     ["IDLE", "AWAITING_RED"],
      };

      if (!allowed[state.phase]?.includes(params.phase)) {
        return {
          content: [{
            type: "text",
            text: `Cannot transition from ${state.phase} to ${params.phase}. ` +
              `Allowed from ${state.phase}: ${allowed[state.phase]?.join(", ")}.`,
          }],
          details: { ...state } satisfies BDDStateDetails,
        };
      }

      if (params.phase === "IDLE") {
        // Capture outgoing context BEFORE resetting state — the phase_change
        // event needs it for commit messages and downstream listeners.
        const outgoing = {
          cycleType: state.cycleType ?? "feature",
          featureName: state.featureName,
          layer: state.layer,
          issueRef: state.issueRef,
        };

        state = { _tool: "bdd_state", phase: "IDLE" };
        ctx.ui.notify("✅ BDD cycle complete.", "info");
        updateStatus(ctx);

        pi.events.emit("bdd:phase_change", {
          from: prevPhase,
          to: "IDLE",
          ...outgoing,
        });

        // Emit lifecycle handoff: coding → delivery
        // If pi-software-lifecycle is installed, delivery plugins will pick this up.
        pi.events.emit("lifecycle:coding_complete", {
          type: "lifecycle:coding_complete",
          artifact: outgoing.featureName ?? outgoing.layer ?? "cycle",
          testsPassing: true,
          meta: {
            cycleType: outgoing.cycleType,
            issueRef: outgoing.issueRef,
          },
        });
      } else if (params.phase === "REFACTOR") {
        state = {
          ...state,
          phase: "REFACTOR",
          boundarySpecs: params.boundarySpecs,
        };

        if (!params.boundarySpecs?.length) {
          ctx.ui.notify(
            "⚠️ No boundary specs declared for this refactor.\n" +
            "Pass boundarySpecs to write-lock the public behavioural contract.\n" +
            "Without a declared boundary the system cannot enforce that external behaviour is preserved.",
            "warning",
          );
        }

        updateStatus(ctx);

        pi.events.emit("bdd:phase_change", {
          from: prevPhase,
          to: "REFACTOR",
          cycleType: state.cycleType ?? "feature",
          featureName: state.featureName,
          layer: state.layer,
          issueRef: state.issueRef,
        });
      } else {
        // AWAITING_RED — clear boundary specs from the previous refactor cycle.
        state = {
          ...state,
          phase: params.phase,
          cycleType: "feature",
          featureName: params.featureName ?? state.featureName,
          layer: params.layer ?? state.layer,
          boundarySpecs: undefined,
        };

        updateStatus(ctx);

        pi.events.emit("bdd:phase_change", {
          from: prevPhase,
          to: state.phase,
          cycleType: state.cycleType ?? "feature",
          featureName: state.featureName,
          layer: state.layer,
          issueRef: state.issueRef,
        });
      }

      return {
        content: [{ type: "text", text: `BDD phase set to ${state.phase}.` }],
        details: { ...state, _tool: "bdd_state" } satisfies BDDStateDetails,
      };
    },
  });

  // ── report_bug tool ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "report_bug",
    label: "Report Bug",
    description:
      "Start a bug fix BDD cycle. Identifies the bug type, records what is wrong and " +
      "what the correct behaviour should be, and transitions to AWAITING_RED. " +
      "The first move after this depends on bug type — load bdd-bug-workflow for guidance. " +
      "Never write production code until a failing test confirms the bug.",
    promptSnippet: "Start a bug fix cycle (gap / spec-defect / requirements / non-functional)",
    promptGuidelines: [
      "Call report_bug before writing any test or code for a bug fix.",
      "Run the diagnostic flow from bdd-bug-workflow to identify the bug type first.",
      "For gap bugs: write a new failing regression test after calling report_bug.",
      "For spec-defect bugs: correct the existing (wrong) test until it fails.",
      "For requirements bugs: revise the spec and get user agreement before any test or code changes.",
      "For non-functional bugs: write a failing performance/security/load test.",
      "Always call run_tests to confirm RED before writing production code.",
    ],
    parameters: Type.Object({
      bugType: StringEnum(["gap", "spec-defect", "requirements", "non-functional"] as const),
      description: Type.String({
        description: "What is currently happening (the wrong behaviour).",
      }),
      expectedBehaviour: Type.String({
        description: "What should happen instead (the correct behaviour).",
      }),
      featureName: Type.Optional(
        Type.String({ description: "Parent feature this bug belongs to (e.g. 'user-login')." }),
      ),
      affectedComponent: Type.Optional(
        Type.String({ description: "Which component or layer is affected (e.g. 'AuthService')." }),
      ),
      issueRef: Type.Optional(
        Type.String({ description: "Issue tracker reference, e.g. 'GH-42', 'LINEAR-123'." }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const prevPhase = state.phase;

      state = {
        _tool: "bdd_state",
        phase: "AWAITING_RED",
        cycleType: "bug",
        bugType: params.bugType,
        bugDescription: params.description,
        bugExpected: params.expectedBehaviour,
        featureName: params.featureName,
        layer: params.affectedComponent,
        issueRef: params.issueRef,
      };

      updateStatus(ctx);

      pi.events.emit("bdd:phase_change", {
        from: prevPhase,
        to: "AWAITING_RED",
        cycleType: "bug",
        featureName: state.featureName,
        layer: state.layer,
        issueRef: state.issueRef,
      });

      pi.events.emit("bdd:bug_reported", {
        bugType: params.bugType,
        description: params.description,
        expectedBehaviour: params.expectedBehaviour,
        affectedComponent: params.affectedComponent,
        issueRef: params.issueRef,
      });

      const firstMove: Record<string, string> = {
        "gap":
          "Write a new regression test specifying the correct behaviour. " +
          "Then call run_tests to confirm RED.",
        "spec-defect":
          "Find the existing test that covers (or should cover) this behaviour. " +
          "Correct or strengthen it until it fails. Then call run_tests to confirm RED.",
        "requirements":
          "DO NOT write any test or code yet. First revise the feature description/scenario " +
          "to reflect the correct behaviour and get agreement. Then update the test, confirm RED.",
        "non-functional":
          "Write a failing non-functional spec (performance test, security test, load test). " +
          "Then call run_tests to confirm RED.",
      };

      return {
        content: [{
          type: "text",
          text: [
            `Bug registered: ${BUG_TYPE_LABELS[params.bugType]}`,
            `Reported: ${params.description}`,
            `Expected: ${params.expectedBehaviour}`,
            params.featureName ? `Feature: ${params.featureName}` : "",
            params.affectedComponent ? `Component: ${params.affectedComponent}` : "",
            params.issueRef ? `Issue: ${params.issueRef}` : "",
            ``,
            `Next step: ${firstMove[params.bugType]}`,
          ].filter(Boolean).join("\n"),
        }],
        details: { ...state, _tool: "bdd_state" } satisfies BDDStateDetails,
      };
    },
  });

  // ── /bdd-setup command ───────────────────────────────────────────────────

  pi.registerCommand("bdd-setup", {
    description: "First-run setup for a new project. Creates AGENTS.md, config files, and project templates.",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const created: string[] = [];

      // ── Helper: write file only if it doesn't exist ──────────────────────
      const ensure = (filePath: string, content: string, label: string) => {
        if (!fs.existsSync(filePath)) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content, "utf8");
          created.push(label);
        }
      };

      // ── Detect stack from project files ───────────────────────────────────
      const hasFile = (f: string) => fs.existsSync(path.join(cwd, f));
      let testCommand = "npm test";
      let testPaths = ["tests/", "__tests__/"];
      let testFilePatterns = ["\\.test\\.", "\\.spec\\."];
      let stackHint = "TypeScript/JavaScript (Vitest or Jest)";

      if (hasFile("Gemfile")) {
        testCommand = "bundle exec rspec";
        testPaths = ["spec/"];
        testFilePatterns = ["_spec\\.rb$"];
        stackHint = "Ruby (RSpec)";
      } else if (hasFile("pyproject.toml") || hasFile("requirements.txt")) {
        testCommand = "pytest";
        testPaths = ["tests/", "test/"];
        testFilePatterns = ["_test\\.py$", "test_.*\\.py$"];
        stackHint = "Python (pytest)";
      } else if (hasFile("go.mod")) {
        testCommand = "go test ./...";
        testPaths = [];
        testFilePatterns = ["_test\\.go$"];
        stackHint = "Go";
      } else if (hasFile("Cargo.toml")) {
        testCommand = "cargo test";
        testPaths = [];
        testFilePatterns = ["_test\\.rs$"];
        stackHint = "Rust (cargo)";
      }

      // ── Create AGENTS.md ──────────────────────────────────────────────────
      // Find the package root so we can reference templates
      const pkgRoot = path.resolve(__dirname, "..", "..");
      const agentsTmpl = path.join(pkgRoot, "AGENTS.md.template");
      const agentsContent = fs.existsSync(agentsTmpl)
        ? fs.readFileSync(agentsTmpl, "utf8")
            .replace("[npm test / bundle exec rspec / pytest / go test ./...]", testCommand)
        : `# Project Configuration\n\nStack: ${stackHint}\nTest command: ${testCommand}\n`;
      ensure(path.join(cwd, "AGENTS.md"), agentsContent, "AGENTS.md");

      // ── Create .pi/bdd.config.json ────────────────────────────────────────
      const bddConfig = {
        productionPaths: ["src/", "lib/", "app/"],
        testPaths: testPaths.length > 0 ? testPaths : ["tests/"],
        testFilePatterns,
        testCommand,
      };
      ensure(
        path.join(cwd, ".pi", "bdd.config.json"),
        JSON.stringify(bddConfig, null, 2),
        ".pi/bdd.config.json",
      );

      // ── Summary ───────────────────────────────────────────────────────────
      const lines = [
        `✅ pi-bdd setup complete. Detected stack: ${stackHint}`,
        "",
        created.length > 0
          ? `Created:\n${created.map((f) => `  • ${f}`).join("\n")}`
          : "All files already exist — nothing created.",
        "",
        "Next steps:",
        "  1. Review .pi/bdd.config.json — adjust paths if needed",
        "  2. Use /feature to begin your first BDD cycle",
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── Auto-detect first run ─────────────────────────────────────────────────
  // Happens in session_start — already defined above. We extend it here.

  // ── /bdd command ──────────────────────────────────────────────────────────

  pi.registerCommand("bdd", {
    description: "Show current BDD phase and state",
    handler: async (_args, ctx) => {
      const lines = [
        `Phase:   ${PHASE_LABELS[state.phase]}${state.cycleType === "bug" ? " (BUG FIX)" : ""}`,
        state.cycleType === "bug" && state.bugType
          ? `Bug type: ${BUG_TYPE_LABELS[state.bugType]}`
          : "",
        state.bugDescription ? `Reported: ${state.bugDescription}` : "",
        state.bugExpected ? `Expected: ${state.bugExpected}` : "",
        state.issueRef ? `Issue:   ${state.issueRef}` : "",
        state.featureName ? `Feature: ${state.featureName}` : "",
        state.layer ? `Layer:   ${state.layer}` : "",
        state.boundarySpecs?.length
          ? `Boundary: ${state.boundarySpecs.join(", ")}`
          : "",
        state.testResult
          ? `Tests:   ${state.testResult.passed} passed, ${state.testResult.failed} failed`
          : "",
        ``,
        PHASE_INSTRUCTIONS[state.phase],
        ``,
        `Config:`,
        `  Test command:  ${config.testCommand}`,
        `  Prod paths:    ${config.productionPaths.join(", ")}`,
        `  Test paths:    ${config.testPaths.join(", ")}`,
      ]
        .filter((l) => l !== undefined && l !== "")
        .join("\n");

      ctx.ui.notify(lines, "info");
    },
  });
}
