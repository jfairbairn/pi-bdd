/**
 * Regression tests for the release-gate extension.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import extensionFactory from "../../extensions/release-gate/index.js";

// ── Minimal mock of ExtensionAPI ─────────────────────────────────────────────

function makeMockPi() {
  const tools: Record<string, any> = {};
  const handlers: Record<string, Array<Function>> = {};

  const mockPi: any = {
    on: vi.fn(),
    registerTool: vi.fn((registration: any) => {
      tools[registration.name] = registration;
    }),
    registerCommand: vi.fn(),
    exec: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: Function) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      }),
    },
    sendUserMessage: vi.fn(),
  };

  return { mockPi, tools, handlers };
}

function makeMockCtx(cwd: string) {
  return {
    cwd,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getBranch: vi.fn(() => []) },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// ── Helpers ─────────────────────────────────────────────────────

/** Fire the bdd:phase_change event to IDLE, initialising release state. */
async function fireIdleTransition(handlers: Record<string, Array<Function>>) {
  await handlers["bdd:phase_change"][0]({
    from: "REFACTOR",
    to: "IDLE",
    cycleType: "feature",
    featureName: "test-feature",
  });
}

/** Fire security:scan_complete with needsManualReview = true. */
function fireScanComplete(
  handlers: Record<string, Array<Function>>,
  needsManualReview = true,
) {
  handlers["security:scan_complete"][0]({
    findings: [],
    maxSeverity: "none",
    needsManualReview,
    layers: [],
  });
}

describe("security:scan_complete — gate 2 idempotency", () => {
  it("does not reset gate 2 to pending after it has been manually passed", async () => {
    const { mockPi, tools, handlers } = makeMockPi();
    extensionFactory(mockPi);

    await fireIdleTransition(handlers);

    // First scan: gate2 goes to pending (manual review required)
    fireScanComplete(handlers, true);
    expect(
      mockPi.sendUserMessage.mock.calls.some((c: any[]) =>
        c[0].includes("manual security review"),
      ),
    ).toBe(true);

    // Human passes gate 2
    const ctx = makeMockCtx("/project");
    await tools["mark_gate_passed"].execute(
      "t1",
      { gate: 2, notes: "reviewed" },
      undefined,
      vi.fn(),
      ctx,
    );

    // Second scan fires (same diff, loop scenario)
    mockPi.sendUserMessage.mockClear();
    fireScanComplete(handlers, true);

    // Gate 2 should remain passed — no new manual review prompt
    expect(
      mockPi.sendUserMessage.mock.calls.some((c: any[]) =>
        c[0].includes("manual security review"),
      ),
    ).toBe(false);
  });

  it("does not reset gate 2 after it passes cleanly (no manual review)", async () => {
    const { mockPi, tools, handlers } = makeMockPi();
    extensionFactory(mockPi);

    await fireIdleTransition(handlers);

    // Gate 2 passes cleanly
    fireScanComplete(handlers, false);

    mockPi.sendUserMessage.mockClear();

    // Second scan fires
    fireScanComplete(handlers, false);

    // Should not re-send the staging message
    expect(
      mockPi.sendUserMessage.mock.calls.some((c: any[]) =>
        c[0].includes("check_release_readiness"),
      ),
    ).toBe(false);
  });
});

describe("check_release_readiness — skipGates config reload", () => {
  it("re-applies skipGates from release.config.json written after the BDD cycle completed", async () => {
    const { mockPi, tools, handlers } = makeMockPi();
    const tmpDir = fs.mkdtempSync("/tmp/pi-bdd-test-");

    try {
      extensionFactory(mockPi);

      // Simulate BDD cycle completing (IDLE transition) with NO release.config.json
      await handlers["bdd:phase_change"][0]({
        from: "REFACTOR",
        to: "IDLE",
        cycleType: "feature",
        featureName: "test-feature",
      });

      // Now create release.config.json skipping gates 3, 4, 5
      fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".pi", "release.config.json"),
        JSON.stringify({ skipGates: [3, 4, 5] }),
      );

      const ctx = makeMockCtx(tmpDir);

      // Run check_release_readiness — gates 3, 4, 5 should be skipped
      const result = await tools["check_release_readiness"].execute(
        "t1",
        {},
        undefined,
        vi.fn(),
        ctx,
      );

      const text = result.content[0].text as string;
      expect(text).toMatch(/⏭.*Gate 3/);
      expect(text).toMatch(/⏭.*Gate 4/);
      expect(text).toMatch(/⏭.*Gate 5/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not skip a gate that is not in skipGates", async () => {
    const { mockPi, tools, handlers } = makeMockPi();
    const tmpDir = fs.mkdtempSync("/tmp/pi-bdd-test-");

    try {
      extensionFactory(mockPi);

      await handlers["bdd:phase_change"][0]({
        from: "REFACTOR",
        to: "IDLE",
        cycleType: "feature",
        featureName: "test-feature",
      });

      // Only skip gate 3
      fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".pi", "release.config.json"),
        JSON.stringify({ skipGates: [3] }),
      );

      const ctx = makeMockCtx(tmpDir);

      const result = await tools["check_release_readiness"].execute(
        "t1",
        {},
        undefined,
        vi.fn(),
        ctx,
      );

      const text = result.content[0].text as string;
      expect(text).toMatch(/⏭.*Gate 3/);
      // Gate 4 should still be pending or failed — not skipped
      expect(text).not.toMatch(/⏭.*Gate 4/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
