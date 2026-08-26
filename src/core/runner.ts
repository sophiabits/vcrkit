import { basename } from "node:path";

import nock from "nock";

import { type Cassette, type NockDefinition, readCassette, writeCassette } from "./cassette.ts";
import { type ActualRequest, diagnoseMismatch, formatMismatch } from "./mismatch.ts";
import { scrubDefinitions, type ScrubRule } from "./redact.ts";
import { makeUserFacingError } from "./user-facing-error.ts";
import {
  canonicalizeDefinitions,
  makeVolatileBodyMatcher,
  OrdinalStore,
  parseVolatileToken,
  type VolatileField,
} from "./volatile.ts";

export interface RecordHandle {
  onCleanup: (fn: () => void | Promise<void>) => void;
}

export interface RecordResult {
  /** Total scrub-rule substitutions performed on this cassette. 0 on failure. */
  redacted: number;
}

/**
 * Run a test body in record mode.
 *
 * Captures all HTTP via nock's recorder, canonicalizes volatile fields,
 * scrubs declared secret values, and writes the cassette next to the test.
 */
export async function recordCassette(
  cassettePath: string,
  scrubRules: ScrubRule[],
  volatileFields: VolatileField[],
  body: (handle: RecordHandle) => Promise<void>,
): Promise<RecordResult> {
  nock.cleanAll();
  nock.enableNetConnect();
  nock.recorder.clear();
  nock.recorder.rec({
    dont_print: true,
    output_objects: true,
    enable_reqheaders_recording: true,
  });

  const cleanups: Array<() => void | Promise<void>> = [];
  const handle: RecordHandle = {
    onCleanup: (fn) => cleanups.push(fn),
  };

  let bodyError: unknown;
  let redacted = 0;
  // Outer try/finally guarantees onCleanup callbacks run even if scrub /
  // canonicalize / write throws. Inner try/finally around recorder.play()
  // guarantees nock is restored even if play() throws — without that, the
  // recorder stays attached and leaks into the next test in the file.
  try {
    try {
      await body(handle);
    } catch (err) {
      bodyError = err;
    }

    let defs: NockDefinition[] = [];
    try {
      defs = nock.recorder.play() as unknown as NockDefinition[];
    } finally {
      nock.recorder.clear();
      nock.restore();
      nock.cleanAll();
      nock.activate();
    }

    if (bodyError === undefined) {
      // Order matters:
      //   1. scrub first → layer-1 known secret values become `{{name}}`
      //      placeholders. The plain-equality contract for those is preserved.
      //   2. canonicalize after → volatile + redact fields become ordinal tokens.
      //      isCanonical() in volatile.ts skips values already placeholderized
      //      so we don't relabel a known secret into a wildcard.
      const scrubbed = scrubDefinitions(defs, scrubRules);
      redacted = scrubbed.matches;
      const canonicalized = canonicalizeDefinitions(scrubbed.defs, volatileFields);
      await writeCassette(cassettePath, { version: 1, definitions: canonicalized });
    }
  } finally {
    // Cleanups run LIFO. Failures warn but don't fail the test.
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try {
        await cleanups[i]!();
      } catch (err) {
        console.error(`vcrkit: onCleanup callback threw:`, err);
      }
    }
  }

  if (bodyError !== undefined) {
    throw bodyError;
  }
  return { redacted };
}

export interface ReplayOptions {
  /** Used in the "re-record" fix line when a mismatch is diagnosed. */
  testName: string;
}

interface NoMatchCapture {
  request: ActualRequest;
  consumedAtTime: number;
}

/**
 * Run a test body in replay mode.
 */
export async function replayCassette(
  cassettePath: string,
  volatileFields: VolatileField[],
  body: () => Promise<void>,
  options: ReplayOptions,
): Promise<void> {
  const cassette: Cassette | null = await readCassette(cassettePath);
  if (!cassette) {
    throw makeUserFacingError(
      `vcrkit: no cassette at ${cassettePath} — run \`vcrkit record\` to create it`,
      { captureFrom: replayCassette },
    );
  }

  nock.cleanAll();
  nock.disableNetConnect();

  // Capture the first 'no match' so we can replace nock's terse error with the
  // detailed diagnostic. Subsequent no-matches in the same test are ignored — the
  // first one is the root cause and the rest are downstream noise.
  let firstNoMatch: NoMatchCapture | null = null;
  const onNoMatch = (...args: unknown[]): void => {
    if (firstNoMatch !== null) {
      return;
    }
    const parsed = parseNoMatchArgs(args);
    if (!parsed) {
      return;
    }
    const totalDefs = cassette.definitions.length;
    const consumedAtTime = totalDefs - nock.pendingMocks().length;
    firstNoMatch = {
      request: { ...parsed, index: consumedAtTime + 1 },
      consumedAtTime,
    };
  };

  let bodyError: unknown;
  let staleMessage: string | null = null;
  // Everything that touches global nock state goes inside the try so a throw
  // from `nock.define` (malformed cassette, version skew with nock's typing)
  // can't leak `disableNetConnect()` or a `no match` listener into the next
  // test. Without this, the next replay in the same process runs with the
  // network dead and a stale handler still subscribed.
  let listenerAttached = false;
  try {
    nock.emitter.on("no match", onNoMatch);
    listenerAttached = true;

    if (volatileFields.length > 0) {
      // Shared replay store: ordinals committed by one interceptor's matcher
      // are visible to later ones, so the bijection holds across requests.
      const store = new OrdinalStore();
      const headerFieldsByPath = new Map<string, VolatileField>();
      for (const field of volatileFields) {
        if (field.kind === "header") {
          headerFieldsByPath.set(field.path, field);
        }
      }
      const defs = cassette.definitions.map((def) => {
        const next = {
          ...def,
          reqheaders: rewriteReqheaders(def.reqheaders, headerFieldsByPath, store),
        };
        // Only override the body matcher when the cassette actually has a body
        // to compare against. Wrapping an undefined body would force a function
        // matcher that nock then hands a "" actual body, mismatching.
        if (def.body !== undefined) {
          (next as { body: unknown }).body = makeVolatileBodyMatcher(
            def.body,
            volatileFields,
            store,
          );
        }
        return next;
      });
      nock.define(defs as never);
    } else {
      nock.define(cassette.definitions as never);
    }

    try {
      await body();
      if (!nock.isDone()) {
        const pending = nock.pendingMocks();
        staleMessage = `vcrkit: stale cassette ${cassettePath} — ${pending.length} unused interceptor(s):\n  ${pending.join("\n  ")}`;
      }
    } catch (err) {
      bodyError = err;
    }
  } finally {
    if (listenerAttached) {
      nock.emitter.off("no match", onNoMatch);
    }
    nock.cleanAll();
    nock.enableNetConnect();
  }

  // A captured no-match is the root cause — surface that, not the downstream
  // ERR_NOCK_NO_MATCH that bubbled out of the HTTP client. Cast widens the
  // closure-mutated `firstNoMatch` past TS's initializer-based narrowing.
  //
  // If the body *also* threw something other than nock's no-match error (the
  // user caught the fetch error and asserted something else, a teardown
  // failed, etc.), attach that as `cause` so the real failure isn't silently
  // swallowed by the diagnostic. Never attach nock's error: it repeats the
  // request with raw headers and body, which may contain secrets that vcrkit's
  // diagnostic intentionally omits or redacts.
  const captured = firstNoMatch as NoMatchCapture | null;
  if (captured !== null) {
    const report = diagnoseMismatch({
      cassetteName: basename(cassettePath).replace(/\.json$/, ""),
      cassettePath,
      testName: options.testName,
      candidates: cassette.definitions,
      request: captured.request,
    });
    const meaningfulBodyError =
      bodyError !== undefined && !isNockNoMatchError(bodyError) ? bodyError : undefined;
    throw makeUserFacingError(formatMismatch(report), {
      captureFrom: replayCassette,
      ...(meaningfulBodyError !== undefined ? { cause: meaningfulBodyError } : {}),
    });
  }

  // Body error wins over a stale-cassette diagnostic. Asymmetric with the
  // no-match path on purpose: a no-match is unambiguously the root cause of
  // any downstream body throw, but `!nock.isDone()` after a body throw is
  // usually the *consequence* — the user's expect(...) short-circuited the
  // test before the remaining requests could fire. Promoting "stale" here
  // would routinely push users to delete and re-record cassettes that were
  // fine.
  if (bodyError !== undefined) {
    throw bodyError;
  }
  if (staleMessage !== null) {
    throw makeUserFacingError(staleMessage, { captureFrom: replayCassette });
  }
}

/** Detect nock's no-match error even when an HTTP client wraps it as a cause. */
function isNockNoMatchError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;

  while ((typeof current === "object" && current !== null) || typeof current === "function") {
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);

    const candidate = current as { cause?: unknown; code?: unknown; message?: unknown };
    if (
      candidate.code === "ERR_NOCK_NO_MATCH" ||
      (typeof candidate.message === "string" && candidate.message.startsWith("Nock: No match"))
    ) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}

/**
 * nock emits 'no match' in three shapes (intercepted_request_router.js and
 * intercept.js). The common useful shape is `(req, options, bodyString)`.
 * Degrade gracefully for the others so we still produce *some* report.
 */
function parseNoMatchArgs(args: unknown[]): ActualRequest | null {
  const [first, second, third] = args;
  if (isOptions(second)) {
    return buildActualFromOptions(second, asBodyString(third));
  }
  if (isOptions(first)) {
    return buildActualFromOptions(first, undefined);
  }
  return null;
}

interface NockOptions {
  method?: string;
  protocol?: string;
  proto?: string;
  host?: string;
  hostname?: string;
  port?: number | string;
  path?: string;
  headers?: Record<string, string | string[]>;
}

function isOptions(v: unknown): v is NockOptions {
  return typeof v === "object" && v !== null && ("path" in v || "host" in v || "hostname" in v);
}

function asBodyString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function buildActualFromOptions(opts: NockOptions, bodyString: string | undefined): ActualRequest {
  const method = (opts.method ?? "GET").toUpperCase();
  const proto = opts.protocol ?? (opts.proto ? `${opts.proto}:` : "http:");
  // Prefer hostname over host — `host` often carries `:port` even at the
  // protocol default (e.g. `api.example.com:443` for https), which would
  // make the rendered URL noisy vs. how the user wrote it.
  const hostname = opts.hostname ?? stripPort(opts.host) ?? "";
  const port = opts.port === undefined ? "" : `:${opts.port}`;
  const authority = isDefaultPort(proto, opts.port) ? hostname : `${hostname}${port}`;
  const path = opts.path ?? "/";
  const url = `${proto}//${authority}${path}`;
  const body = parseMaybeJson(bodyString);
  const req: ActualRequest = { method, url, body };
  if (opts.headers) {
    req.headers = opts.headers;
  }
  return req;
}

/**
 * Drop a trailing port from a host. IPv6 hosts are bracketed in HTTP authority
 * form (`[::1]:8080`) — the port is *after* the closing `]`, and the address
 * itself contains `:` characters. A naïve `lastIndexOf(":")` would chew into
 * the address. `host` may already be a bare bracketed IPv6 with no port, in
 * which case we return it unchanged.
 */
export function stripPort(host: string | undefined): string | undefined {
  if (host === undefined) {
    return undefined;
  }
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close === -1) {
      return host;
    }
    return host.slice(0, close + 1);
  }
  const i = host.lastIndexOf(":");
  return i === -1 ? host : host.slice(0, i);
}

function isDefaultPort(protocol: string, port: number | string | undefined): boolean {
  if (port === undefined) {
    return true;
  }
  const n = typeof port === "string" ? Number(port) : port;
  if (protocol === "https:" && n === 443) {
    return true;
  }
  if (protocol === "http:" && n === 80) {
    return true;
  }
  return false;
}

function parseMaybeJson(s: string | undefined): unknown {
  if (s === undefined || s === "") {
    return undefined;
  }
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

type ReplayHeaderMatcher = string | ((value: string) => boolean);
type ReplayRequestHeaders = Record<string, ReplayHeaderMatcher>;

/**
 * On replay, a header configured as volatile/redact whose cassette value is a
 * canonical ordinal token gets replaced with a function matcher that does the
 * same first-appearance relabeling as the body matcher. The store is
 * shared so bijection holds across body + header bindings.
 */
function rewriteReqheaders(
  reqheaders: Record<string, string> | undefined,
  fields: Map<string, VolatileField>,
  store: OrdinalStore,
): ReplayRequestHeaders | undefined {
  if (!reqheaders) {
    return reqheaders;
  }
  const out: ReplayRequestHeaders = {};
  for (const [k, v] of Object.entries(reqheaders)) {
    const path = k.toLowerCase();
    const field = fields.get(path);
    if (field && typeof v === "string") {
      const tok = parseVolatileToken(v);
      if (tok) {
        out[k] =
          field.mode === "loose"
            ? (): boolean => true
            : (actual: string): boolean => store.bind("header", path, actual) === tok.ord;
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}
