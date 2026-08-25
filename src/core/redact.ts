import type { NockDefinition } from "./cassette.ts";
import { isPlainObject } from "./value.ts";

/**
 * Headers excused from matching by default, across both requests and responses.
 *
 * Several flavors blend in here:
 *
 *   - per-request timestamps and trace IDs that change every recording and
 *     turn `git diff` of cassettes into pure noise (`date`, `x-amzn-trace-id`,
 *     `x-cloud-trace-context`, …);
 *   - HTTP/1.1 connection-management and CDN/proxy identification headers
 *     that aren't semantically meaningful to a test (`server`, `via`,
 *     `cf-ray`, `x-served-by`, `keep-alive`, `transfer-encoding`, …);
 *   - caching/freshness headers whose values are derived from response
 *     content or wall-clock and shift between recordings (`etag`,
 *     `last-modified`, `age`, `expires`);
 *   - rate-limit counters that change every call (`x-ratelimit-*`,
 *     `ratelimit-*` per RFC 9239 draft);
 *   - framework-emitted server tags (`x-runtime`, `x-powered-by`).
 */
export const BUILT_IN_IGNORED_HEADERS: ReadonlyArray<string> = [
  // Generic infrastructure
  "cf-ray",
  "x-request-id",
  "server-timing",
  "date",
  "report-to",
  "traceparent",
  "tracestate",
  "baggage",
  "x-b3-traceid",
  "x-b3-spanid",
  "x-cloud-trace-context",
  "x-vercel-id",
  "x-vercel-cache",
  "age",
  "x-cache",
  "x-amz-cf-id",
  "x-amz-cf-pop",
  "via",
  "x-amzn-request-id",
  "x-amz-apigw-id",
  "x-amzn-trace-id",
  // B3 tracing
  "b3",
  "x-b3-parentspanid",
  "x-b3-sampled",
  "x-b3-flags",
  // Datadog tracing
  "x-datadog-trace-id",
  "x-datadog-parent-id",
  "x-datadog-sampling-priority",
  "x-datadog-origin",
  "x-datadog-tags",
  // New Relic tracing
  "newrelic",
  // AWS and Azure request diagnostics
  "x-amz-request-id",
  "x-amz-id-2",
  "x-ms-request-id",
  "x-ms-correlation-request-id",
  // Fastly diagnostics
  "x-timer",
  "x-varnish",
  // Kong diagnostics and timing
  "x-kong-request-id",
  "x-kong-proxy-latency",
  "x-kong-upstream-latency",
  "x-kong-response-latency",
  "x-kong-admin-latency",
  "x-kong-total-latency",
  "x-kong-third-party-latency",
  "x-kong-client-latency",
];

const IGNORE_REQ_HEADERS = new Set([
  ...BUILT_IN_IGNORED_HEADERS,
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "user-agent",
]);

const IGNORE_RES_HEADERS = new Set([
  ...BUILT_IN_IGNORED_HEADERS,
  // Tracing
  "x-trace-id",
  // Connection management
  "connection",
  "keep-alive",
  "transfer-encoding",
  // Caching / freshness
  "etag",
  "expires",
  "last-modified",
  // Rate limits
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  // Server / framework tags
  "strict-transport-security",
  "x-powered-by",
  "x-runtime",
  // CDN / proxy identification
  "cf-cache-status",
  "server",
  "x-azure-ref",
  "x-cache-hits",
  "x-edge-location",
  "x-served-by",
]);

/**
 * One scrub: every occurrence of `real` in the cassette JSON becomes
 * `canonical`. For a plain secret, `canonical` is `{{name}}`; for a
 * `replayAs`-wrapped secret it's the override constant or seeded fake.
 */
export interface ScrubRule {
  real: string;
  canonical: string;
}

export interface ScrubResult {
  defs: NockDefinition[];
  /** Total number of scrub-rule substitutions (sum across all rules). */
  matches: number;
}

/**
 * Apply known-secret redaction: substitute every declared secret value with
 * its canonical replay form, plus drop legitimately-varying request headers.
 */
export function scrubDefinitions(defs: NockDefinition[], rules: ScrubRule[]): ScrubResult {
  const stripped = defs.map(stripIgnoredHeaders);
  const sorted = [...rules]
    .filter((r) => r.real !== "")
    .sort((a, b) => b.real.length - a.real.length);
  const compiled = compileRules(sorted);
  let matches = 0;
  const out = stripped.map((def) => {
    const walked = walkValue(def as unknown, compiled);
    matches += walked.matches;
    return walked.value as NockDefinition;
  });
  return { defs: out, matches };
}

interface CompiledRule {
  real: string;
  canonical: string;
  /** Matches `real` only when it doesn't extend into adjacent word chars. */
  re: RegExp;
}

interface CompiledRules {
  /** First rule wins when callers supply the same real value more than once. */
  canonicalByReal: ReadonlyMap<string, string>;
  /** One alternation ensures replacements are never scanned as fresh input. */
  re: RegExp | null;
}

function compileRules(rules: ReadonlyArray<ScrubRule>): CompiledRules {
  const compiled = rules.map(compileRule);
  const canonicalByReal = new Map<string, string>();
  for (const rule of compiled) {
    if (!canonicalByReal.has(rule.real)) {
      canonicalByReal.set(rule.real, rule.canonical);
    }
  }
  return {
    canonicalByReal,
    re:
      compiled.length === 0
        ? null
        : new RegExp(compiled.map((rule) => `(?:${rule.re.source})`).join("|"), "g"),
  };
}

function compileRule(rule: ScrubRule): CompiledRule {
  // `\b` on a side only matters when that side of `real` is itself a word
  // char. If `real` begins/ends with a non-word char (e.g. `-`, `"`, `=`),
  // its own boundary char already separates it; asserting `\b` would forbid
  // legitimate occurrences.
  const head = WORD_RE.test(rule.real.charAt(0)) ? "\\b" : "";
  const tail = WORD_RE.test(rule.real.charAt(rule.real.length - 1)) ? "\\b" : "";
  return {
    real: rule.real,
    canonical: rule.canonical,
    re: new RegExp(`${head}${escapeRegex(rule.real)}${tail}`, "g"),
  };
}

const WORD_RE = /\w/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface WalkResult {
  value: unknown;
  matches: number;
}

function walkValue(value: unknown, rules: CompiledRules): WalkResult {
  if (typeof value === "string") {
    return scrubString(value, rules);
  }
  if (Array.isArray(value)) {
    let total = 0;
    const out = value.map((v) => {
      const r = walkValue(v, rules);
      total += r.matches;
      return r.value;
    });
    return { value: out, matches: total };
  }
  if (value !== null && typeof value === "object") {
    let total = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = walkValue(v, rules);
      total += r.matches;
      out[k] = r.value;
    }
    return { value: out, matches: total };
  }
  return { value, matches: 0 };
}

function scrubString(input: string, rules: CompiledRules): WalkResult {
  // Fast path: the whole string is exactly the secret. Sidesteps boundary
  // edge cases for secrets that end in chars `\w` doesn't recognize
  // (e.g. non-ASCII letters).
  const exact = rules.canonicalByReal.get(input);
  if (exact !== undefined) {
    return { value: exact, matches: 1 };
  }
  if (rules.re === null) {
    return { value: input, matches: 0 };
  }

  let matches = 0;
  rules.re.lastIndex = 0;
  const value = input.replace(rules.re, (real) => {
    matches++;
    return rules.canonicalByReal.get(real)!;
  });
  return { value, matches };
}

function stripIgnoredHeaders(def: NockDefinition): NockDefinition {
  const next: NockDefinition = { ...def };
  if (def.reqheaders) {
    const reqHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(def.reqheaders)) {
      if (!IGNORE_REQ_HEADERS.has(k.toLowerCase())) {
        reqHeaders[k] = v;
      }
    }
    next.reqheaders = reqHeaders;
  }
  if (def.rawHeaders !== undefined) {
    next.rawHeaders = stripRawHeaders(def.rawHeaders) as never;
  }

  // Heuristic for echo-style APIs (httpbin etc.) that surface the request's
  // received headers as `response.headers`. If we leave them as-is, the same
  // trace IDs and timestamps that drive `rawHeaders` noise reappear here on
  // every re-record. Only fires when response is a plain object with a
  // `headers` field shaped like a header map.
  if (isPlainObject(def.response) && isPlainObject(def.response.headers)) {
    const cleanedHeaders = stripHeaderMap(def.response.headers as Record<string, unknown>);
    next.response = { ...def.response, headers: cleanedHeaders };
  }
  return next;
}

/**
 * nock recorder emits rawHeaders as either an alternating `[k, v, k, v, …]`
 * array or a `Record<string, string>` depending on version/source. Handle both.
 * Return type is loose to accommodate both shapes; caller casts to `never`.
 */
function stripRawHeaders(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const k = raw[i];
      if (typeof k === "string" && !IGNORE_RES_HEADERS.has(k.toLowerCase())) {
        out.push(k, raw[i + 1]!);
      }
    }
    return out;
  }
  if (isPlainObject(raw)) {
    return stripHeaderMap(raw);
  }
  return raw;
}

function stripHeaderMap(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!IGNORE_RES_HEADERS.has(k.toLowerCase())) {
      out[k] = v;
    }
  }
  return out;
}
