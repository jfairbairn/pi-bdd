import { defineConfig } from "vitest/config";
import path from "node:path";
import { execSync } from "node:child_process";

// Find the global pi-coding-agent installation
function findPiRoot(): string {
  // Try global node_modules first
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  const candidate = path.join(globalRoot, "@mariozechner/pi-coding-agent");
  try {
    const { statSync } = require("node:fs");
    statSync(path.join(candidate, "dist/index.js"));
    return candidate;
  } catch {
    throw new Error(
      `Cannot find @mariozechner/pi-coding-agent. Looked in: ${candidate}`
    );
  }
}

const piRoot = findPiRoot();
const piModules = path.join(piRoot, "node_modules");

export default defineConfig({
  resolve: {
    alias: {
      "@mariozechner/pi-tui": path.join(piModules, "@mariozechner/pi-tui/dist/index.js"),
      "@mariozechner/pi-coding-agent": path.join(piRoot, "dist/index.js"),
      "@mariozechner/pi-ai": path.join(piModules, "@mariozechner/pi-ai/dist/index.js"),
      "@sinclair/typebox": path.join(piModules, "@sinclair/typebox/build/cjs/index.js"),
    },
  },
  test: {
    globals: true,
  },
});
