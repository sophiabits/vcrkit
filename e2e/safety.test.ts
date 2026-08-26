import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { VCRKIT_BIN, runVcrkit } from "./run-vcrkit.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("vcrkit CLI usage", () => {
  it.each(["--help", "-h"])("prints help to stdout and exits 0 for %s", async (flag) => {
    const result = await runVcrkit([flag]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  });

  it("prints usage to stderr and exits 2 when no command is provided", async () => {
    const result = await runVcrkit([]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects --usage as an unknown option", async () => {
    const result = await runVcrkit(["--usage"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown command: --usage");
    expect(result.stderr).toContain("Usage:");
  });
});

describe("vcrkit record — vitest context guard (bin/vcrkit.ts:35)", () => {
  it("exits 2 and explains itself when VITEST=true is in the environment", async () => {
    const result = await runVcrkit(["record"], {
      env: { VITEST: "true" },
      timeoutMs: 15_000,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/refusing to run inside an existing vitest context/);
  });
});

describe("vcrkit record — fixture context", () => {
  it("supports skip and only modifiers", async () => {
    const project = mkdtempSync(join(tmpdir(), "vcrkit-modifiers-"));
    temporaryDirectories.push(project);
    const vitestModule = pathToFileURL(resolve(dirname(VCRKIT_BIN), "../vitest.js")).href;
    writeFileSync(
      join(project, "modifiers.vcr.test.ts"),
      [
        `import { defineVcr } from ${JSON.stringify(vitestModule)};`,
        "const vcr = defineVcr({});",
        'vcr("not focused", () => { throw new Error("normal VCR test ran"); });',
        'vcr.skip("explicitly skipped", () => { throw new Error("skipped VCR test ran"); });',
        'vcr.only("focused", () => {});',
      ].join("\n"),
    );

    const result = await runVcrkit(["record"], {
      cwd: project,
      env: { VITEST: undefined, VITEST_WORKER_ID: undefined },
      timeoutMs: 15_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("VCR test ran");
  });

  it("injects an empty secrets object when no providers are configured", async () => {
    const project = mkdtempSync(join(tmpdir(), "vcrkit-no-secrets-"));
    temporaryDirectories.push(project);
    const vitestModule = pathToFileURL(resolve(dirname(VCRKIT_BIN), "../vitest.js")).href;
    writeFileSync(
      join(project, "empty.vcr.test.ts"),
      [
        `import { defineVcr } from ${JSON.stringify(vitestModule)};`,
        "const vcr = defineVcr({});",
        'vcr("has an empty secrets context", ({ secrets }) => {',
        '  if (secrets === null || typeof secrets !== "object" || Object.keys(secrets).length !== 0) {',
        "    throw new Error(`expected empty secrets object, received ${JSON.stringify(secrets)}`);",
        "  }",
        "});",
      ].join("\n"),
    );

    const result = await runVcrkit(["record"], {
      cwd: project,
      env: { VITEST: undefined, VITEST_WORKER_ID: undefined },
      timeoutMs: 15_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("accepts short secrets but rejects empty provider values before recording", async () => {
    const project = mkdtempSync(join(tmpdir(), "vcrkit-short-secrets-"));
    temporaryDirectories.push(project);
    const vitestModule = pathToFileURL(resolve(dirname(VCRKIT_BIN), "../vitest.js")).href;
    writeFileSync(
      join(project, "short.vcr.test.ts"),
      [
        `import { defineVcr } from ${JSON.stringify(vitestModule)};`,
        'const vcr = defineVcr({ secrets: { pin: async () => "12" } });',
        'vcr("accepts a short secret", ({ secrets }) => {',
        '  if (secrets.pin !== "12") throw new Error("short secret was not resolved");',
        "});",
      ].join("\n"),
    );

    const shortResult = await runVcrkit(["record"], {
      cwd: project,
      env: { VITEST: undefined, VITEST_WORKER_ID: undefined },
      timeoutMs: 15_000,
    });
    expect(shortResult.exitCode, shortResult.stderr).toBe(0);

    rmSync(join(project, "short.vcr.test.ts"));
    writeFileSync(
      join(project, "empty.vcr.test.ts"),
      [
        `import { defineVcr } from ${JSON.stringify(vitestModule)};`,
        'const vcr = defineVcr({ secrets: { emptyToken: async () => "" } });',
        'vcr("rejects an empty secret", () => { throw new Error("test body must not run"); });',
      ].join("\n"),
    );

    const emptyResult = await runVcrkit(["record"], {
      cwd: project,
      env: { VITEST: undefined, VITEST_WORKER_ID: undefined },
      timeoutMs: 15_000,
    });
    expect(emptyResult.exitCode).toBe(1);
    expect(emptyResult.stderr).toContain("emptyToken");
    expect(emptyResult.stderr).toContain("empty value");
    expect(emptyResult.stderr).not.toContain("test body must not run");
  });
});
