/**
 * Regression test: renderCall and renderResult must return proper Component objects.
 *
 * Previously both returned `{ toString: () => string } as never`, which has no
 * `.render(width)` method. The TUI crashes when it tries to render such an object.
 *
 * See bug: "crash when trying to render some other status line"
 */
import { describe, it, expect, vi } from "vitest";
import extensionFactory from "../../extensions/bdd-enforcer/index.js";

// ── Minimal mock of ExtensionAPI ─────────────────────────────────────────────

function makeMockPi() {
  const tools: Record<string, any> = {};

  const mockPi: any = {
    on: vi.fn(),
    registerTool: vi.fn((registration: any) => {
      tools[registration.name] = registration;
    }),
    registerCommand: vi.fn(),
    exec: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  };

  return { mockPi, tools };
}

const mockTheme: any = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("run_tests tool rendering", () => {
  it("renderCall returns a Component with a render() method", () => {
    const { mockPi, tools } = makeMockPi();
    extensionFactory(mockPi);

    const runTestsTool = tools["run_tests"];
    expect(runTestsTool, "run_tests tool was not registered").toBeDefined();

    const component = runTestsTool.renderCall({ command: "npm test" }, mockTheme, {});

    expect(typeof component?.render, "renderCall must return a Component with render()").toBe("function");
  });

  it("renderResult returns a Component with a render() method (with details)", () => {
    const { mockPi, tools } = makeMockPi();
    extensionFactory(mockPi);

    const runTestsTool = tools["run_tests"];
    const result = {
      details: {
        _tool: "bdd_state",
        phase: "GREEN",
        testResult: { passed: 3, failed: 0, total: 3, exitCode: 0, raw: "" },
      },
      content: [{ type: "text", text: "3 passed" }],
    };

    const component = runTestsTool.renderResult(result, {}, mockTheme, {});

    expect(typeof component?.render, "renderResult must return a Component with render()").toBe("function");
  });

  it("renderResult returns a Component with a render() method (no details)", () => {
    const { mockPi, tools } = makeMockPi();
    extensionFactory(mockPi);

    const runTestsTool = tools["run_tests"];
    const result = {
      content: [{ type: "text", text: "done" }],
    };

    const component = runTestsTool.renderResult(result, {}, mockTheme, {});

    expect(typeof component?.render, "renderResult (no details) must return a Component with render()").toBe("function");
  });

  it("renderCall component renders without throwing", () => {
    const { mockPi, tools } = makeMockPi();
    extensionFactory(mockPi);

    const component = tools["run_tests"].renderCall({}, mockTheme, {});
    expect(() => component.render(80)).not.toThrow();
  });

  it("renderResult component renders without throwing", () => {
    const { mockPi, tools } = makeMockPi();
    extensionFactory(mockPi);

    const result = {
      details: {
        _tool: "bdd_state",
        phase: "RED",
        testResult: { passed: 0, failed: 2, total: 2, exitCode: 1, raw: "" },
      },
      content: [],
    };
    const component = tools["run_tests"].renderResult(result, {}, mockTheme, {});
    expect(() => component.render(80)).not.toThrow();
  });
});
