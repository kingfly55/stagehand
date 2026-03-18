import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@browserbasehq/stagehand": path.join(rootDir, "dist", "esm", "index.js"),
    },
  },
  test: {
    environment: "node",
    include: ["**/dist/esm/tests/native/**/*.test.js"],
    // Native tests launch real browsers — give them more time
    testTimeout: 30000,
    hookTimeout: 15000,
    // Run sequentially to avoid browser resource contention
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
