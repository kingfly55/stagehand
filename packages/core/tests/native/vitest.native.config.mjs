import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/dist/esm/tests/native/**/*.test.js"],
    testTimeout: 30000,
  },
});
