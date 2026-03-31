import { defineConfig } from "vitest/config";
import path from "node:path";

// Pi packages live inside the pi-coding-agent's own node_modules
const piModules = "/home/james/.nodenv/versions/24.14.0/lib/node_modules/@mariozechner/pi-coding-agent/node_modules";
const piRoot = "/home/james/.nodenv/versions/24.14.0/lib/node_modules/@mariozechner/pi-coding-agent";

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
