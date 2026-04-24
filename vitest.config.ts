import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        pool: "forks",
        maxWorkers: 3,
        maxConcurrency: 3,
        testTimeout: 120_000,
        hookTimeout: 60_000,
        teardownTimeout: 10_000,
        fileParallelism: true,
        exclude: ["**/node_modules/**", "**/dist/**"],
    },
});
