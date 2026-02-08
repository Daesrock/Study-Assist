import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      // Alias .js imports to .ts files for vitest
    },
  },
});
