import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        pool: "forks",
        poolOptions: {
            forks: {
                singleFork: false,
            },
        },
        testTimeout: 120_000,
        hookTimeout: 30_000,
        teardownTimeout: 10_000,
        fileParallelism: true,
    },
});
