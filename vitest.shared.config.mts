import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The same suites as vitest.config.mts, against the hosted demo's shared store (RedisStore over an
// in-process MemoryKv that interleaves like separate server instances). See tests/helpers/store.ts.
export default defineConfig({
  resolve: {
    alias: {
      "@": here("./src"),
      "server-only": here("./tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    restoreMocks: true,
    env: { EMPLOYAI_TEST_STORE: "shared" },
  },
});
