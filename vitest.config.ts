import { defineConfig } from "vitest/config";

// One worker process: the dev machine has 8 GB of RAM (see CLAUDE.md).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
