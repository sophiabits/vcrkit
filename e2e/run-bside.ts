import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const BSIDE_BIN = resolve(here, "../dist/bin/bside.js");

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RunOptions {
  cwd?: string;
  /** Overrides merged onto process.env. `undefined` values remove the key. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function assertBuilt(): void {
  if (!existsSync(BSIDE_BIN)) {
    throw new Error(
      `bside bin not found at ${BSIDE_BIN}. Run \`pnpm build\` before the CLI integration suite.`,
    );
  }
}

export function runBside(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  assertBuilt();

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [BSIDE_BIN, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill("SIGKILL");
            rejectPromise(new Error(`bside timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs)
        : null;

    child.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      rejectPromise(err);
    });
    child.on("close", (exitCode) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolvePromise({ stdout, stderr, exitCode });
    });
  });
}
