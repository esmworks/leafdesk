// Unit tests: src/**/*.test.ts (and the browser extension's) in the node environment, with `@/db` mocked (no database).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts", "extension/**/*.test.ts"],
  },
});
