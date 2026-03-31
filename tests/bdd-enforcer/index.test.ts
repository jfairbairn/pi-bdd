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

// ── REFACTOR boundary enforcement ───────────────────────────────────────

// A version of makeMockPi that captures event handlers for state-machine tests.
function makeMockPiWithHandlers() {
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
  };

  return { mockPi, tools, handlers };
}

function makeMockCtx(cwd = "/project") {
  return {
    cwd,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getBranch: vi.fn(() => []) },
  };
}

// Drive the state machine from IDLE through to REFACTOR.
async function driveToRefactor(
  mockPi: any,
  tools: Record<string, any>,
  handlers: Record<string, Array<Function>>,
  ctx: ReturnType<typeof makeMockCtx>,
  boundarySpecs: string[],
) {
  await handlers["session_start"][0]({}, ctx);

  // IDLE → RED
  mockPi.exec.mockResolvedValueOnce({ stdout: "1 failed\n", stderr: "", code: 1 });
  await tools["run_tests"].execute("t1", {}, undefined, undefined, ctx);

  // RED → GREEN
  mockPi.exec.mockResolvedValueOnce({ stdout: "3 passed\n", stderr: "", code: 0 });
  await tools["run_tests"].execute("t2", {}, undefined, undefined, ctx);

  // GREEN → REFACTOR
  await tools["set_bdd_phase"].execute(
    "t3",
    { phase: "REFACTOR", boundarySpecs },
    undefined,
    undefined,
    ctx,
  );
}

describe("REFACTOR boundary enforcement", () => {
  it("blocks write to a boundary spec file during REFACTOR", async () => {
    const { mockPi, tools, handlers } = makeMockPiWithHandlers();
    const ctx = makeMockCtx();
    extensionFactory(mockPi);

    await driveToRefactor(mockPi, tools, handlers, ctx, ["tests/api/users.test.ts"]);

    const result = await handlers["tool_call"][0](
      { toolName: "write", input: { path: "tests/api/users.test.ts" } },
      ctx,
    );

    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/boundary spec/i);
  });

  it("blocks edit to a boundary spec file during REFACTOR", async () => {
    const { mockPi, tools, handlers } = makeMockPiWithHandlers();
    const ctx = makeMockCtx();
    extensionFactory(mockPi);

    await driveToRefactor(mockPi, tools, handlers, ctx, ["tests/api/users.test.ts"]);

    const result = await handlers["tool_call"][0](
      { toolName: "edit", input: { path: "tests/api/users.test.ts" } },
      ctx,
    );

    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/boundary spec/i);
  });

  it("blocks write to a boundary spec given as absolute path", async () => {
    const { mockPi, tools, handlers } = makeMockPiWithHandlers();
    const ctx = makeMockCtx("/project");
    extensionFactory(mockPi);

    await driveToRefactor(mockPi, tools, handlers, ctx, ["tests/api/users.test.ts"]);

    // Absolute path that resolves to the same relative path
    const result = await handlers["tool_call"][0](
      { toolName: "write", input: { path: "/project/tests/api/users.test.ts" } },
      ctx,
    );

    expect(result?.block).toBe(true);
  });

  it("allows write to a non-boundary test file during REFACTOR", async () => {
    const { mockPi, tools, handlers } = makeMockPiWithHandlers();
    const ctx = makeMockCtx();
    extensionFactory(mockPi);

    await driveToRefactor(mockPi, tools, handlers, ctx, ["tests/api/users.test.ts"]);

    const result = await handlers["tool_call"][0](
      { toolName: "write", input: { path: "tests/helpers/setup.ts" } },
      ctx,
    );

    expect(result?.block).toBeUndefined();
  });

  it("allows write to a production file during REFACTOR", async () => {
    const { mockPi, tools, handlers } = makeMockPiWithHandlers();
    const ctx = makeMockCtx();
    extensionFactory(mockPi);

    await driveToRefactor(mockPi, tools, handlers, ctx, ["tests/api/users.test.ts"]);

    const result = await handlers["tool_call"][0](
      { toolName: "write", input: { path: "src/users/UserRepository.ts" } },
      ctx,
    );

    expect(result?.block).toBeUndefined();
  });

  it("warns when entering REFACTOR without declaring boundary specs", async () => {
    const { mockPi, tools, handlers } = makeMockPiWithHandlers();
    const ctx = makeMockCtx();
    extensionFactory(mockPi);

    await handlers["session_start"][0]({}, ctx);
    mockPi.exec.mockResolvedValueOnce({ stdout: "1 failed\n", stderr: "", code: 1 });
    await tools["run_tests"].execute("t1", {}, undefined, undefined, ctx);
    mockPi.exec.mockResolvedValueOnce({ stdout: "3 passed\n", stderr: "", code: 0 });
    await tools["run_tests"].execute("t2", {}, undefined, undefined, ctx);

    ctx.ui.notify.mockClear();
    await tools["set_bdd_phase"].execute("t3", { phase: "REFACTOR" }, undefined, undefined, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/boundary/i),
      "warning",
    );
  });

  it("rejects transition to REFACTOR from any phase other than GREEN", async () => {
    const { mockPi, tools, handlers } = makeMockPiWithHandlers();
    const ctx = makeMockCtx();
    extensionFactory(mockPi);

    await handlers["session_start"][0]({}, ctx);

    // Attempt from IDLE
    const result = await tools["set_bdd_phase"].execute(
      "t1",
      { phase: "REFACTOR", boundarySpecs: ["tests/something.test.ts"] },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toMatch(/cannot transition/i);
  });

  it("clears boundarySpecs when transitioning out of REFACTOR", async () => {
    const { mockPi, tools, handlers } = makeMockPiWithHandlers();
    const ctx = makeMockCtx();
    extensionFactory(mockPi);

    await driveToRefactor(mockPi, tools, handlers, ctx, ["tests/api/users.test.ts"]);

    // Exit REFACTOR to AWAITING_RED for the next cycle
    await tools["set_bdd_phase"].execute("t4", { phase: "AWAITING_RED" }, undefined, undefined, ctx);

    // Boundary spec should no longer be locked
    const result = await handlers["tool_call"][0](
      { toolName: "write", input: { path: "tests/api/users.test.ts" } },
      ctx,
    );

    // AWAITING_RED blocks production paths, not test paths — should be allowed
    expect(result?.block).toBeUndefined();
  });

  it("locks all files listed in boundarySpecs", async () => {
    const { mockPi, tools, handlers } = makeMockPiWithHandlers();
    const ctx = makeMockCtx();
    extensionFactory(mockPi);

    await driveToRefactor(mockPi, tools, handlers, ctx, [
      "tests/api/users.test.ts",
      "tests/acceptance/login.feature",
    ]);

    const r1 = await handlers["tool_call"][0](
      { toolName: "write", input: { path: "tests/api/users.test.ts" } },
      ctx,
    );
    const r2 = await handlers["tool_call"][0](
      { toolName: "edit", input: { path: "tests/acceptance/login.feature" } },
      ctx,
    );

    expect(r1?.block).toBe(true);
    expect(r2?.block).toBe(true);
  });
});
