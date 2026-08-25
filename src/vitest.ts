import { beforeAll, test } from "vitest";

import { cassettePathFor } from "./core/cassette.ts";
import type { ScrubRule } from "./core/redact.ts";
import { recordCassette, replayCassette } from "./core/runner.ts";
import { readVcrMode, withVcrLock } from "./core/runtime.ts";
import { getReplayValue, resolveSecretEntry } from "./core/secrets.ts";
import { makeUserFacingError } from "./core/user-facing-error.ts";
import {
  compileVolatileFields,
  type RedactConfig,
  type VolatileConfig,
  type VolatileEntry,
  type VolatileField,
} from "./core/volatile.ts";
import type { SecretEntry } from "./secrets.ts";

export interface VcrConfig {
  secrets?: Record<string, SecretEntry>;
  redact?: RedactConfig;
  volatile?: VolatileConfig;
}

export type { RedactConfig, VolatileConfig, VolatileEntry };

export interface VcrTestContext<S extends Record<string, string> = Record<string, string>> {
  secrets: S;
  onCleanup: (fn: () => void | Promise<void>) => void;
}

export type VcrFn<S extends Record<string, string> = Record<string, string>> = (
  ctx: VcrTestContext<S>,
) => void | Promise<void>;

export type SecretsOf<C extends VcrConfig> = C extends {
  secrets: infer S extends Record<string, SecretEntry>;
}
  ? { [K in keyof S]: string }
  : Record<string, string>;

export interface VcrFixture<S extends Record<string, string> = Record<string, string>> {
  (name: string, fn: VcrFn<S>): void;
  /** Non-enumerable introspection handle for the `bside` bin. */
  readonly _config: VcrConfig;
}

/**
 * Build the `vcr` fixture from a config object.
 *
 * Mode is read once at config-load time from `VCR` (set by the bin). The
 * fixture closes over a per-worker cache:
 *
 * - **Record**: a single `beforeAll` resolves every provider into the
 *   `realSecrets` map. The test sees real values via `secrets.<name>` and
 *   any occurrence in captured HTTP gets scrubbed to the secret's
 *   `replayValue` (placeholder by default, replayAs override otherwise).
 * - **Replay**: `realSecrets` is the replay values directly — placeholders
 *   or fakes. No provider is touched, no SDK is imported, no creds needed.
 */
export function defineVcr<const C extends VcrConfig>(config: C): VcrFixture<SecretsOf<C>> {
  const mode = readVcrMode();
  const secretEntries = Object.entries(config.secrets ?? {}) as Array<[string, SecretEntry]>;

  // Replay form for every secret. Synchronously knowable (placeholder or
  // replayAs-override) — no provider invocation, no SDK import.
  const replaySecrets: Record<string, string> = {};
  // Detect two secrets that collapse to the same replay value. Only possible
  // via explicit `replayAs(_, "literal")` collisions, or two `replayAs(_,
  // fakeToken({ seed }))` calls sharing a seed — defaults derive from the
  // config key and can't collide. Cassettes lose the ability to disambiguate
  // which secret a scrub came from, so updating one secret's replay value
  // later requires a full re-record. Warn loudly at config time.
  const replayToSecrets = new Map<string, string[]>();
  for (const [k, entry] of secretEntries) {
    const replay = getReplayValue(entry, k);
    replaySecrets[k] = replay;
    const list = replayToSecrets.get(replay);
    if (list) {
      list.push(k);
    } else {
      replayToSecrets.set(replay, [k]);
    }
  }
  // Only warn when we're actually going to run vcr tests. Under bare `vitest
  // run` (no bside bin) the fixture skips every vcr test, and a stderr spam
  // the user can't act on is pure noise.
  if (mode !== null) {
    for (const [replay, keys] of replayToSecrets) {
      if (keys.length > 1) {
        console.warn(
          `bside: secrets [${keys.map((k) => `'${k}'`).join(", ")}] all resolve to the ` +
            `same replay value (${JSON.stringify(replay)}). Cassettes can't tell which ` +
            `secret a scrub came from, so changing one secret's replayAs later will ` +
            `require a full re-record. Pick one to keep and give the others distinct ` +
            `replayAs values or fakeToken seeds.`,
        );
      }
    }
  }

  // Real values, populated only in record by the suite beforeAll below. Start
  // with the valid secret-free context: when no providers are configured there
  // is no beforeAll preflight, but record and replay must still expose `{}`.
  let realSecrets: Record<string, string> = {};
  let scrubRules: ScrubRule[] = [];

  async function resolveRealSecrets(): Promise<void> {
    // Providers are independent network calls (GCP / AWS / env / user-defined).
    // Fire them concurrently — total wall time becomes max(provider) rather
    // than sum(provider). Order is preserved by mapping in-place.
    const results = await Promise.all(
      secretEntries.map(([k, entry]) => resolveSecretEntry(entry, k)),
    );
    const real: Record<string, string> = {};
    const rules: ScrubRule[] = [];
    for (let i = 0; i < secretEntries.length; i++) {
      const [k] = secretEntries[i]!;
      const { resolved, replay } = results[i]!;
      if (resolved === "") {
        throw makeUserFacingError(
          `bside: secret '${k}' resolved to an empty value; refusing to record because ` +
            `an empty secret cannot be scrubbed safely. Check the provider, or remove ` +
            `'${k}' from the secrets config if it is not actually sensitive.`,
        );
      }
      real[k] = resolved;
      rules.push({ real: resolved, canonical: replay });
    }
    realSecrets = real;
    scrubRules = rules;
  }

  const volatileFields: VolatileField[] = compileVolatileFields(config.volatile, config.redact);

  let beforeAllRegistered = false;

  const vcr = ((name: string, fn: VcrFn): void => {
    if (mode === null) {
      test.skip(`${name} ↓ run via 'bside replay'`, () => {});
      return;
    }

    // Resolve secrets in beforeAll so provider failures stop the suite before recording.
    if (mode === "record" && !beforeAllRegistered && secretEntries.length > 0) {
      beforeAllRegistered = true;
      beforeAll(resolveRealSecrets);
    }

    test(name, async (taskCtx) => {
      await withVcrLock(name, async () => {
        const filepath = taskCtx.task.file?.filepath ?? "";
        const suitePath = describeStackOf(taskCtx.task);
        const cassettePath = cassettePathFor(filepath, suitePath, name);
        (taskCtx.task.meta as Record<string, unknown>).bsideCassettePath = cassettePath;
        const identity = [filepath, ...suitePath, name].join(" › ");
        const prior = cassetteRegistry.get(cassettePath);
        if (prior !== undefined && prior !== identity) {
          throw makeUserFacingError(
            `bside: two tests resolve to the same cassette path\n` +
              `  path:   ${cassettePath}\n` +
              `  first:  ${prior}\n` +
              `  second: ${identity}\n` +
              `Test names that differ only by case or characters the sanitizer collapses ` +
              `(spaces, punctuation) produce the same file (e.g. "Foo bar" and "foo-bar" both → ` +
              `"foo-bar.json"). Rename one of the tests, or move them into different describe() blocks.`,
          );
        }
        cassetteRegistry.set(cassettePath, identity);

        if (mode === "record") {
          const result = await recordCassette(
            cassettePath,
            scrubRules,
            volatileFields,
            async ({ onCleanup }) => {
              await fn({ secrets: realSecrets, onCleanup });
            },
          );
          // Vitest serializes task.meta back to the main process, so the
          // bin's record summary can aggregate per-test stats without IPC.
          (taskCtx.task.meta as Record<string, unknown>).bsideRedacted = result.redacted;
        } else {
          await replayCassette(
            cassettePath,
            volatileFields,
            async () => {
              await fn({ secrets: replaySecrets as never, onCleanup: noop });
            },
            { testName: name },
          );
        }
      });
    });
  }) as VcrFixture<SecretsOf<C>>;

  Object.defineProperty(vcr, "_config", { value: config, enumerable: false });
  return vcr;
}

function noop(): void {}

/**
 * Per-worker registry of cassette paths → test identity. Used to detect
 * sanitizer-level path collisions (e.g. "foo bar" vs "foo-bar") that the
 * describe-stack subdirs in `cassettePathFor` can't disambiguate. Per-worker
 * is enough: Vitest's default file-per-worker pool plus bside record's
 * `fileParallelism: false` means any two tests that *can* collide are in the
 * same worker.
 */
const cassetteRegistry = new Map<string, string>();

/**
 * Walk Vitest task → parent suites up to (but not including) the file suite,
 * returning the describe() names outermost-first. Returns [] for a test
 * defined at the file's top level.
 */
function describeStackOf(task: {
  file?: unknown;
  suite?: { name?: string; suite?: unknown } | undefined;
}): string[] {
  const stack: string[] = [];
  let s = task.suite as { name?: string; suite?: unknown } | undefined;
  while (s !== undefined && s !== task.file) {
    if (typeof s.name === "string") {
      stack.unshift(s.name);
    }
    s = s.suite as { name?: string; suite?: unknown } | undefined;
  }
  return stack;
}
