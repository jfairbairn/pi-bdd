/**
 * Integration test: doc consistency check runs on IDLE transition
 * and includes findings in the set_bdd_phase response.
 */
import { describe, it, expect, vi } from "vitest";
import extensionFactory from "../../extensions/bdd-enforcer/index.js";
import * as fs from "node:fs";

// ── Mock fs so we control what files the extension sees ─────────────────────

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    existsSync: vi.fn(actual.existsSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

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
  };

  return { mockPi, tools, handlers };
}

function makeMockCtx(cwd = "/project") {
  return {
    cwd,
    ui: { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn() },
    sessionManager: { getBranch: vi.fn(() => []) },
  };
}

async function driveToGreen(
  mockPi: any,
  tools: Record<string, any>,
  handlers: Record<string, Array<Function>>,
  ctx: ReturnType<typeof makeMockCtx>,
) {
  await handlers["session_start"][0]({}, ctx);

  // IDLE → RED
  mockPi.exec.mockResolvedValueOnce({ stdout: "1 failed\n", stderr: "", code: 1 });
  await tools["run_tests"].execute("t1", {}, undefined, undefined, ctx);

  // RED → GREEN
  mockPi.exec.mockResolvedValueOnce({ stdout: "3 passed\n", stderr: "", code: 0 });
  await tools["run_tests"].execute("t2", {}, undefined, undefined, ctx);
}

describe("doc consistency check on IDLE transition", () => {
  it("includes stale reference warnings in the IDLE transition response", async () => {
    const { mockPi, tools, handlers } = makeMockPi();
    const ctx = makeMockCtx("/project");
    extensionFactory(mockPi);
    await driveToGreen(mockPi, tools, handlers, ctx);

    // Mock git diff to report a deleted prompt
    mockPi.exec.mockImplementation(async (_cmd: string, args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("diff") && joined.includes("--name-only") && joined.includes("--diff-filter=D")) {
        return { stdout: "prompts/feature.md\n", stderr: "", code: 0 };
      }
      if (joined.includes("diff") && joined.includes("--name-only") && joined.includes("--diff-filter=A")) {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    // Mock filesystem: README references the deleted prompt
    const mockedFs = vi.mocked(fs);
    mockedFs.existsSync.mockImplementation((p: any) => {
      if (String(p).endsWith("README.md")) return true;
      if (String(p).endsWith("bdd.config.json")) return false;
      return false;
    });
    mockedFs.readFileSync.mockImplementation((p: any, _enc?: any) => {
      if (String(p).endsWith("README.md")) {
        return "Use `/feature` to start a new feature.";
      }
      return "";
    });
    mockedFs.readdirSync.mockImplementation((p: any) => {
      if (String(p).endsWith("prompts")) return [] as any;
      if (String(p).endsWith("skills")) return [] as any;
      return [] as any;
    });

    const result = await tools["set_bdd_phase"].execute(
      "t3", { phase: "IDLE" }, undefined, undefined, ctx,
    );

    const text = result.content[0].text;
    expect(text).toMatch(/feature/i);
    expect(text).toMatch(/README\.md|stale|inconsisten/i);
  });

  it("passes silently when no docs reference deleted files", async () => {
    const { mockPi, tools, handlers } = makeMockPi();
    const ctx = makeMockCtx("/project");
    extensionFactory(mockPi);
    await driveToGreen(mockPi, tools, handlers, ctx);

    // Mock git diff: deleted a file but no docs reference it
    mockPi.exec.mockImplementation(async (_cmd: string, args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("--diff-filter=D")) {
        return { stdout: "src/old-module.ts\n", stderr: "", code: 0 };
      }
      if (joined.includes("--diff-filter=A")) {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const mockedFs = vi.mocked(fs);
    mockedFs.existsSync.mockImplementation((p: any) => {
      if (String(p).endsWith("README.md")) return true;
      if (String(p).endsWith("bdd.config.json")) return false;
      return false;
    });
    mockedFs.readFileSync.mockImplementation((p: any, _enc?: any) => {
      if (String(p).endsWith("README.md")) return "Use `/build` to work through the roadmap.";
      return "";
    });
    mockedFs.readdirSync.mockImplementation((_p: any) => [] as any);

    const result = await tools["set_bdd_phase"].execute(
      "t3", { phase: "IDLE" }, undefined, undefined, ctx,
    );

    const text = result.content[0].text;
    // Should just be the normal IDLE message, no warnings
    expect(text).not.toMatch(/stale|inconsisten|warning/i);
  });

  it("passes silently when nothing was changed", async () => {
    const { mockPi, tools, handlers } = makeMockPi();
    const ctx = makeMockCtx("/project");
    extensionFactory(mockPi);
    await driveToGreen(mockPi, tools, handlers, ctx);

    // Mock git diff: nothing deleted, nothing added
    mockPi.exec.mockImplementation(async () => {
      return { stdout: "", stderr: "", code: 0 };
    });

    const mockedFs = vi.mocked(fs);
    mockedFs.existsSync.mockImplementation((p: any) => {
      if (String(p).endsWith("bdd.config.json")) return false;
      return false;
    });
    mockedFs.readdirSync.mockImplementation((_p: any) => [] as any);

    const result = await tools["set_bdd_phase"].execute(
      "t3", { phase: "IDLE" }, undefined, undefined, ctx,
    );

    const text = result.content[0].text;
    expect(text).toMatch(/IDLE/);
    expect(text).not.toMatch(/stale|inconsisten|warning/i);
  });
});
