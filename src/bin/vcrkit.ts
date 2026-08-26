#!/usr/bin/env node
import { startVitest } from "vitest/node";

import { cassettePathFor } from "../core/cassette.ts";
import {
  type FailedTest,
  formatRecordSummary,
  snapshotCassettes,
  summarizeRecord,
} from "./record-reporter.ts";

type Mode = "record" | "replay";

function usage(exitCode: 0 | 2): never {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    [
      "Usage:",
      "  vcrkit replay              # offline, fail on cassette miss",
      "  vcrkit record              # network on, write cassettes",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

/**
 * Prevent execution inside a vitest context that wasn't set up by vcrkit, to
 * prevent VCRs from running under unsafe configs (e.g. parallelism on).
 */
function assertSafeRecordContext(): void {
  if (process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined) {
    process.stderr.write(
      "vcrkit record: refusing to run inside an existing vitest context.\n" +
        "  Run `vcrkit record` directly, not via `vitest run` or a parent vitest invocation.\n" +
        "  (Record needs to control parallelism and reporters.)\n",
    );
    process.exit(2);
  }
}

async function runVitest(mode: Mode): Promise<number> {
  process.env.VCR = mode;
  const cwd = process.cwd();
  // Snapshot *before* vitest starts so the diff captures whatever the run
  // mutates. Replay never writes cassettes, so we only do this in record.
  const beforeSnapshot = mode === "record" ? snapshotCassettes(cwd) : null;

  const vitest = await startVitest("test", [], {
    run: true,
    include: ["**/*.vcr.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    // Record talks to a stateful upstream (e.g. rate limits), so serialize across files.
    ...(mode === "record" ? { fileParallelism: false } : {}),
  });
  if (!vitest) {
    return 2;
  }

  // Pull state *before* close: `vitest.state` is only documented to be live
  // while vitest is up. Tests have already run to completion by the time
  // `startVitest(... { run: true })` resolves, so `getFiles()` is populated.
  const files = vitest.state.getFiles();
  const failed = files.some((f) => f.result?.state === "fail");
  await vitest.close();

  if (beforeSnapshot !== null) {
    const afterSnapshot = snapshotCassettes(cwd);
    const redactedTotal = collectTaskMetadata(
      files,
      "vcrkitRedacted",
      (value): value is number => typeof value === "number",
    ).reduce((total, value) => total + value, 0);
    const activeCassettePaths = collectTaskMetadata(
      files,
      "vcrkitCassettePath",
      (value): value is string => typeof value === "string",
    );
    const failedTests = collectFailedTests(files);
    const summary = summarizeRecord(beforeSnapshot, afterSnapshot, cwd, {
      redactedTotal,
      failedTests,
      activeCassettePaths,
    });
    process.stdout.write(`\n${formatRecordSummary(summary)}`);
  }

  return failed ? 1 : 0;
}

function collectTaskMetadata<T>(
  tasks: readonly unknown[],
  key: string,
  isValue: (value: unknown) => value is T,
): T[] {
  const values: T[] = [];
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) {
      continue;
    }
    const object = task as { meta?: unknown; tasks?: unknown };
    if (object.meta && typeof object.meta === "object") {
      const value = (object.meta as Record<string, unknown>)[key];
      if (isValue(value)) {
        values.push(value);
      }
    }
    if (Array.isArray(object.tasks)) {
      values.push(...collectTaskMetadata(object.tasks, key, isValue));
    }
  }
  return values;
}

/**
 * Walk Vitest's task tree pulling out failed leaf tests with the test file
 * they live in. The reporter uses these to mark the corresponding cassette in
 * the record diff and to print a final failure list — so the user sees the
 * failure both inline (next to the cassette) and as the last line of output,
 * not just buried in vitest's mid-output `Failed Tests` block.
 */
function collectFailedTests(tasks: readonly unknown[]): FailedTest[] {
  function walk(
    nestedTasks: readonly unknown[],
    currentFile?: string,
    suitePath: readonly string[] = [],
  ): FailedTest[] {
    const failedTests: FailedTest[] = [];
    for (const task of nestedTasks) {
      if (typeof task !== "object" || task === null) {
        continue;
      }
      const object = task as {
        type?: unknown;
        mode?: unknown;
        name?: unknown;
        filepath?: unknown;
        result?: unknown;
        tasks?: unknown;
      };
      const isFileSuite = typeof object.filepath === "string";
      const filepath = typeof object.filepath === "string" ? object.filepath : currentFile;
      if (object.type === "test" && object.mode !== "skip" && object.mode !== "todo") {
        const result = object.result as { state?: unknown } | undefined;
        if (
          result?.state === "fail" &&
          typeof object.name === "string" &&
          typeof filepath === "string"
        ) {
          failedTests.push({
            file: filepath,
            name: object.name,
            cassettePath: cassettePathFor(filepath, suitePath, object.name),
          });
        }
      }
      if (Array.isArray(object.tasks)) {
        // Push the describe name when descending into a nested suite, but not
        // when descending into a file suite (its `name` is the filename, which
        // `cassettePathFor` already encodes as the per-file subdir).
        const childSuitePath =
          !isFileSuite && object.type === "suite" && typeof object.name === "string"
            ? [...suitePath, object.name]
            : suitePath;
        failedTests.push(...walk(object.tasks, filepath, childSuitePath));
      }
    }
    return failedTests;
  }

  return walk(tasks);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  switch (cmd) {
    case "replay":
      process.exit(await runVitest("replay"));
      break;
    case "record":
      assertSafeRecordContext();
      process.exit(await runVitest("record"));
      break;
    case "--help":
    case "-h":
      usage(0);
    case undefined:
      usage(2);
    default:
      process.stderr.write(`vcrkit: unknown command: ${cmd}\n`);
      usage(2);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
