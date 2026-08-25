import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // *.vcr.test.ts only runs under `bside replay` / `bside record`.
    // `pnpm test:vcr` engages them explicitly during development.
    exclude: ["**/*.vcr.test.ts", "**/node_modules/**", "**/dist/**"],
    environment: "node",
  },
});
