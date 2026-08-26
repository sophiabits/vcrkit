import { makeUserFacingError } from "./user-facing-error.ts";

export type VcrMode = "record" | "replay";

/**
 * Reads the VCR mode we're running in.
 *
 * Returns null when the fixture is loaded outside `vcrkit replay` / `vcrkit record` so the fixture can
 * auto-skip.
 */
export function readVcrMode(env: NodeJS.ProcessEnv = process.env): VcrMode | null {
  const value = env.VCR;
  if (value === "record" || value === "replay") {
    return value;
  }
  return null;
}

/**
 * Process-global lock: no two VCR tests may share a process concurrently.
 *
 * Vitest's default file-per-worker pool already satisfies this; the lock is the
 * runtime backstop for `.concurrent` or single-process pools.
 */
let active: string | null = null;

export async function withVcrLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (active !== null) {
    throw makeUserFacingError(
      `vcrkit: cassette "${name}" started while "${active}" is still active in ` +
        `the same process. VCR tests can't run concurrently (nock is global). ` +
        `Remove .concurrent, or run via \`vcrkit record/replay\`.`,
    );
  }
  active = name;
  try {
    return await fn();
  } finally {
    active = null;
  }
}
