/**
 * Volatile matching is stateful relabeling, not erasure like redaction is.
 *
 * Both record and replay assign each observed value a first-appearance ordinal per
 * field path; the cassette stores those ordinals as canonical tokens, and
 * replay compares the ordinal it computes against the one on disk.
 *
 * Ordinal matching is important for ensuring that value-reuse patterns (e.g.
 * idempotency keys) are encoded and checkable in replay mode.
 */

import type { NockDefinition } from "./cassette.ts";
import { isPlainObject } from "./value.ts";

export type VolatileEntry = string | { name: string; match: "loose" };

export interface VolatileSideConfig {
  headers?: VolatileEntry[];
  body?: VolatileEntry[];
}

export interface VolatileConfig {
  /** Values sent to the server. These participate in replay matching. */
  request?: VolatileSideConfig;
  /**
   * Values returned by the server. These are canonicalized when recording so
   * cassettes do not churn; replay returns the canonical tokens to the test.
   */
  response?: VolatileSideConfig;
}

export interface RedactSideConfig {
  headers?: string[];
  body?: string[];
}

export interface RedactConfig {
  /** Sensitive values sent to the server. */
  request?: RedactSideConfig;
  /** Sensitive values returned by the server. */
  response?: RedactSideConfig;
}

export interface VolatileField {
  kind: "body" | "header" | "response" | "response-header";
  /**
   * Body/response: leaf field name to match at any depth. Header: lowercased header name.
   */
  path: string;
  mode: "strict" | "loose";
  source: "volatile" | "redact";
}

/**
 * Sensitive headers that get value-redacted by default on both requests and
 * responses. User-configured headers extend this list on their declared side.
 */
export const BUILT_IN_REDACT_HEADERS: ReadonlyArray<string> = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "www-authenticate",
  "x-api-key",
];

export function parseVolatileConfig(cfg: VolatileConfig | undefined): VolatileField[] {
  const out: VolatileField[] = [];
  for (const entry of cfg?.request?.headers ?? []) {
    out.push({
      kind: "header",
      path: entryName(entry).toLowerCase(),
      mode: typeof entry === "string" ? "strict" : entry.match,
      source: "volatile",
    });
  }
  for (const entry of cfg?.request?.body ?? []) {
    out.push({
      kind: "body",
      path: entryName(entry),
      mode: typeof entry === "string" ? "strict" : entry.match,
      source: "volatile",
    });
  }
  for (const entry of cfg?.response?.headers ?? []) {
    out.push({
      kind: "response-header",
      path: entryName(entry).toLowerCase(),
      mode: typeof entry === "string" ? "strict" : entry.match,
      source: "volatile",
    });
  }
  for (const entry of cfg?.response?.body ?? []) {
    out.push({
      kind: "response",
      path: entryName(entry),
      mode: typeof entry === "string" ? "strict" : entry.match,
      source: "volatile",
    });
  }
  return out;
}

/**
 * Parse user `redact` config and merge the built-in header deny-list into both
 * sides. The result deduplicates fields already covered by the built-ins.
 */
export function parseRedactConfig(cfg: RedactConfig | undefined): VolatileField[] {
  const fields = new Map<string, VolatileField>();
  const add = (kind: VolatileField["kind"], path: string): void => {
    const field = { kind, path, mode: "strict", source: "redact" } as const;
    fields.set(`${kind}:${path}`, field);
  };
  for (const name of BUILT_IN_REDACT_HEADERS) {
    add("header", name);
    add("response-header", name);
  }
  for (const name of cfg?.request?.headers ?? []) {
    add("header", name.toLowerCase());
  }
  for (const name of cfg?.request?.body ?? []) {
    add("body", name);
  }
  for (const name of cfg?.response?.headers ?? []) {
    add("response-header", name.toLowerCase());
  }
  for (const name of cfg?.response?.body ?? []) {
    add("response", name);
  }
  return [...fields.values()];
}

/**
 * Compile user configuration into the single field policy consumed by both
 * record and replay. A field can be named by both configs (most commonly a
 * built-in sensitive header also listed under `volatile.request.headers`), so passing
 * the two raw arrays downstream would make behavior depend on iteration order.
 * Redaction wins overlaps: its stricter safety contract must not be weakened by
 * an earlier volatile rule.
 */
export function compileVolatileFields(
  volatile: VolatileConfig | undefined,
  redact: RedactConfig | undefined,
): VolatileField[] {
  const fieldsByIdentity = new Map<string, VolatileField>();
  for (const field of [...parseVolatileConfig(volatile), ...parseRedactConfig(redact)]) {
    fieldsByIdentity.set(`${field.kind}:${field.path}`, field);
  }
  return [...fieldsByIdentity.values()];
}

function entryName(entry: VolatileEntry): string {
  return typeof entry === "string" ? entry : entry.name;
}

const TOKEN_RE = /^<!(volatile|redact)!([^:]+):([^!]+)!(\d+)>$/;
const PLACEHOLDER_RE = /^\{\{[^}]+\}\}$/;

/** True only for match-normalized ordinal tokens, not equality placeholders. */
export function isOrdinalToken(s: unknown): boolean {
  return typeof s === "string" && TOKEN_RE.test(s);
}

export function volatileToken(
  source: "volatile" | "redact",
  kind: string,
  path: string,
  ord: number,
): string {
  return `<!${source}!${kind}:${path}!${ord}>`;
}

export function parseVolatileToken(
  s: unknown,
): { source: "volatile" | "redact"; kind: string; path: string; ord: number } | null {
  if (typeof s !== "string") {
    return null;
  }
  const m = TOKEN_RE.exec(s);
  if (!m) {
    return null;
  }
  return {
    source: m[1] as "volatile" | "redact",
    kind: m[2]!,
    path: m[3]!,
    ord: Number(m[4]!),
  };
}

/**
 * A value is already "canonical" if it's a layer-1 secret placeholder
 * (`{{name}}`) or an ordinal token written by `volatileToken`. Canonicalize
 * skips these so the plain-equality contract for layer-1 secrets survives
 * downstream passes. Exported so `mismatch` and other
 * pure-data consumers don't reinvent the predicate.
 */
export function isCanonical(s: unknown): boolean {
  return typeof s === "string" && (PLACEHOLDER_RE.test(s) || isOrdinalToken(s));
}

/**
 * First-appearance ordinal store keyed by `(kind, path)`. Both record and
 * replay use the same shape: record assigns ordinals as it walks the captured
 * definitions; replay assigns them as live requests arrive.
 */
export class OrdinalStore {
  private counters = new Map<string, number>();
  private maps = new Map<string, Map<string, number>>();

  /** Existing ordinal for value, or null. */
  peek(kind: string, path: string, value: string): number | null {
    const m = this.maps.get(`${kind}:${path}`);
    return m?.get(value) ?? null;
  }

  /** Existing ordinal, or bind fresh (next in sequence). */
  bind(kind: string, path: string, value: string): number {
    const key = `${kind}:${path}`;
    let m = this.maps.get(key);
    if (!m) {
      m = new Map();
      this.maps.set(key, m);
      this.counters.set(key, 0);
    }
    const existing = m.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const ord = this.counters.get(key)!;
    this.counters.set(key, ord + 1);
    m.set(value, ord);
    return ord;
  }

  snapshot(): OrdinalStore {
    const s = new OrdinalStore();
    s.counters = new Map(this.counters);
    s.maps = new Map(Array.from(this.maps, ([k, v]) => [k, new Map(v)]));
    return s;
  }

  adoptFrom(other: OrdinalStore): void {
    this.counters = new Map(other.counters);
    this.maps = new Map(Array.from(other.maps, ([k, v]) => [k, new Map(v)]));
  }
}

/**
 * Record-side rewrite: walk all definitions in order and replace each
 * volatile value with its canonical ordinal token, keyed by first-appearance
 * order across the whole run.
 */
export function canonicalizeDefinitions(
  defs: NockDefinition[],
  fields: VolatileField[],
): NockDefinition[] {
  if (fields.length === 0) {
    return defs;
  }
  const store = new OrdinalStore();
  return defs.map((def) => canonicalizeOne(def, fields, store));
}

function canonicalizeOne(
  def: NockDefinition,
  fields: VolatileField[],
  store: OrdinalStore,
): NockDefinition {
  let body = def.body;
  let reqheaders = def.reqheaders;
  let response = def.response;
  let rawHeaders: unknown = def.rawHeaders;
  for (const field of fields) {
    if (field.kind === "body") {
      body = rewriteBodyField(body, field, store);
    } else if (field.kind === "header") {
      reqheaders = rewriteHeaderField(reqheaders, field, store);
    } else if (field.kind === "response-header") {
      rawHeaders = rewriteRawHeadersField(rawHeaders, field, store);
      response = rewriteEchoedHeaderField(response, field, store);
    } else {
      response = rewriteResponseField(response, field, store);
    }
  }
  const next: NockDefinition = { ...def, body, response };
  if (reqheaders !== undefined) {
    next.reqheaders = reqheaders;
  }
  if (rawHeaders !== undefined) {
    next.rawHeaders = rawHeaders as never;
  }
  return next;
}

function rewriteBodyField(body: unknown, field: VolatileField, store: OrdinalStore): unknown {
  const { parsed, wasString } = parseBody(body);
  if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
    return body;
  }
  const next = walkRewrite(parsed, field, store, "body");
  return wasString ? JSON.stringify(next) : next;
}

/**
 * Walk an arbitrary JSON tree replacing every string-valued occurrence of
 * `field.path` with a canonical token. Mirrors `rewriteResponseField`; body
 * payloads need the same recursion because volatile/redacted fields routinely
 * live deep in the tree (GraphQL `variables.cartId`, PII under a nested
 * `payment.card.cardNumber`, …).
 */
function walkRewrite(
  value: unknown,
  field: VolatileField,
  store: OrdinalStore,
  kind: "body" | "response",
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => walkRewrite(v, field, store, kind));
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === field.path && typeof v === "string" && !isCanonical(v)) {
        const ord = field.mode === "loose" ? 0 : store.bind(kind, field.path, v);
        out[k] = volatileToken(field.source, kind, field.path, ord);
      } else {
        out[k] = walkRewrite(v, field, store, kind);
      }
    }
    return out;
  }

  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") {
        const rewritten = walkRewrite(parsed, field, store, kind);
        return JSON.stringify(rewritten);
      }
    } catch {
      // not JSON; leave as-is
    }
  }

  return value;
}

function rewriteHeaderField(
  reqheaders: Record<string, string> | undefined,
  field: VolatileField,
  store: OrdinalStore,
): Record<string, string> | undefined {
  if (!reqheaders) {
    return reqheaders;
  }
  const key = Object.keys(reqheaders).find((k) => k.toLowerCase() === field.path);
  if (!key) {
    return reqheaders;
  }
  const value = reqheaders[key];
  if (value === undefined) {
    return reqheaders;
  }
  // Layer-1 placeholder or an earlier canonical token — leave alone.
  if (isCanonical(value)) {
    return reqheaders;
  }
  const ord = field.mode === "loose" ? 0 : store.bind(field.kind, field.path, value);
  return { ...reqheaders, [key]: volatileToken(field.source, field.kind, field.path, ord) };
}

function rewriteResponseField(
  response: unknown,
  field: VolatileField,
  store: OrdinalStore,
): unknown {
  return walkRewrite(response, field, store, "response");
}

/**
 * Apply a header-deny-list field to response-side `rawHeaders`. nock emits
 * this as either an alternating `[k, v, k, v, …]` array or a
 * `Record<string, string | string[]>`; multi-valued headers (notably
 * `set-cookie`) routinely appear as an array of strings on the Record form.
 *
 * Uses a separate ordinal namespace from request headers.
 */
function rewriteRawHeadersField(raw: unknown, field: VolatileField, store: OrdinalStore): unknown {
  if (raw === undefined) {
    return raw;
  }
  if (Array.isArray(raw)) {
    const out: unknown[] = [...raw];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const k = raw[i];
      const v = raw[i + 1];
      if (typeof k === "string" && k.toLowerCase() === field.path && typeof v === "string") {
        out[i + 1] = tokenizeHeaderValue(v, field, store);
      }
    }
    return out;
  }
  if (isPlainObject(raw)) {
    return rewriteHeaderMap(raw, field, store);
  }
  return raw;
}

function rewriteEchoedHeaderField(
  response: unknown,
  field: VolatileField,
  store: OrdinalStore,
): unknown {
  if (!isPlainObject(response) || !isPlainObject(response.headers)) {
    return response;
  }
  const headers = response.headers as Record<string, unknown>;
  const rewritten = rewriteHeaderMap(headers, field, store);
  if (rewritten === headers) {
    return response;
  }
  return { ...response, headers: rewritten };
}

function rewriteHeaderMap(
  headers: Record<string, unknown>,
  field: VolatileField,
  store: OrdinalStore,
): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== field.path) {
      out[k] = v;
      continue;
    }
    if (typeof v === "string") {
      const next = tokenizeHeaderValue(v, field, store);
      if (next !== v) {
        changed = true;
      }
      out[k] = next;
    } else if (Array.isArray(v)) {
      const arr = v.map((entry) => {
        if (typeof entry !== "string") {
          return entry;
        }
        const next = tokenizeHeaderValue(entry, field, store);
        if (next !== entry) {
          changed = true;
        }
        return next;
      });
      out[k] = arr;
    } else {
      out[k] = v;
    }
  }
  return changed ? out : headers;
}

function tokenizeHeaderValue(value: string, field: VolatileField, store: OrdinalStore): string {
  if (isCanonical(value)) {
    return value;
  }
  const ord = field.mode === "loose" ? 0 : store.bind(field.kind, field.path, value);
  return volatileToken(field.source, field.kind, field.path, ord);
}

/**
 * Replay-side body matcher. Returns a function suitable for nock's
 * Definition `body` field. The function relabels actual values against the
 * shared `store`, but ONLY commits new bindings when it returns true — sound
 * because nock selects the first interceptor whose matcher returns true.
 */
export function makeVolatileBodyMatcher(
  expectedBody: unknown,
  fields: VolatileField[],
  store: OrdinalStore,
): (actual: unknown) => boolean {
  const requestBodyFields = fields.filter((f) => f.kind === "body");
  return (actual: unknown): boolean => {
    const { parsed: actualObj } = parseBody(actual);
    const { parsed: expectedObj } = parseBody(expectedBody);
    const tentative = store.snapshot();
    if (!matchValue(expectedObj, actualObj, requestBodyFields, tentative)) {
      return false;
    }
    store.adoptFrom(tentative);
    return true;
  };
}

function matchValue(
  expected: unknown,
  actual: unknown,
  requestBodyFields: VolatileField[],
  store: OrdinalStore,
): boolean {
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const expKeys = Object.keys(expected).sort();
    const actKeys = Object.keys(actual).sort();
    if (expKeys.length !== actKeys.length) {
      return false;
    }
    if (expKeys.some((k, i) => k !== actKeys[i])) {
      return false;
    }

    for (const key of expKeys) {
      const expVal = expected[key];
      const actVal = actual[key];
      const field = requestBodyFields.find((f) => f.path === key);

      if (field) {
        const tok = parseVolatileToken(expVal);
        // Configured fields are only match-normalized when record actually
        // wrote an ordinal token. Known-secret placeholders deliberately stay
        // as equality values, even when their field is also configured under
        // redact/volatile.
        if (!tok) {
          if (!matchValue(expVal, actVal, requestBodyFields, store)) {
            return false;
          }
          continue;
        }
        if (tok.kind !== "body" || tok.path !== field.path) {
          return false;
        }
        if (field.mode === "loose") {
          if (typeof actVal !== "string") {
            return false;
          }
          continue;
        }
        if (typeof actVal !== "string") {
          return false;
        }
        const actOrd = store.bind("body", field.path, actVal);
        if (actOrd !== tok.ord) {
          return false;
        }
      } else {
        if (!matchValue(expVal, actVal, requestBodyFields, store)) {
          return false;
        }
      }
    }
    return true;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return false;
    }
    return expected.every((v, i) => matchValue(v, actual[i], requestBodyFields, store));
  }
  return expected === actual;
}

function parseBody(body: unknown): { parsed: unknown; wasString: boolean } {
  if (typeof body !== "string") {
    return { parsed: body, wasString: false };
  }
  try {
    return { parsed: JSON.parse(body), wasString: true };
  } catch {
    return { parsed: body, wasString: false };
  }
}
