import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // plugins/claude-code has its own tests, run by Claude Code: `claude plugin test plugins/claude-code`.
  },
});
