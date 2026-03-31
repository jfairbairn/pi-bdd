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
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    registerTool: vi.fn((registration: any) => {
      tools[registration.name] = registration;
    }),
    registerCommand: vi.fn(),
    exec: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
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
