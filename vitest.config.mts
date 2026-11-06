import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Unit and route tests. They never touch the network: tests/setup.ts replaces fetch with a
// function that throws, so any accidental outbound call fails the test.
export default defineConfig({
  resolve: {
    alias: {
      "@": here("./src"),
      // `server-only` throws outside a React Server environment; tests run in plain Node.
      "server-only": here("./tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    restoreMocks: true,
  },
});
