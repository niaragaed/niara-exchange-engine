import { defineConfig } from "vitest/config";

// One worker process: the dev machine has 8 GB of RAM (see CLAUDE.md).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    // PGlite (Postgres in WASM) takes about a minute to start in a vitest worker on
    // this machine; each test file that needs it starts one instance in beforeAll.
    hookTimeout: 240_000,
  },
});
