/**
 * Mismatch diagnostics. Split in two so the parts are independently testable:
 *
 * The runner is responsible for catching nock's no-match signal, calling
 * diagnose, and emitting the formatted string in the thrown error.
 */

import type { NockDefinition } from "./cassette.ts";
import { isPlainObject } from "./value.ts";
import { isOrdinalToken } from "./volatile.ts";

export interface ActualRequest {
  method: string;
  /** Full URL — scope + path. Used verbatim in the header line. */
  url: string;
  body: unknown;
  headers?: Record<string, string | string[]>;
  /** 1-based request ordinal within the test, for "request #N" in the header. */
  index?: number;
}

export type Similarity = "same-method-and-path" | "same-path" | "same-method" | "weak";

export type DiffHint = "looks-like-id" | "looks-like-timestamp";

export type FieldDiff =
  | { kind: "method"; recorded: string; actual: string }
  | { kind: "url"; recorded: string; actual: string }
  | { kind: "query"; name: string; recorded: string | undefined; actual: string | undefined }
  | { kind: "body"; path: string; recorded: unknown; actual: unknown; hint?: DiffHint }
  | { kind: "header"; name: string; recorded: unknown; actual: unknown; hint?: DiffHint }
  | {
      kind: "body-shape";
      path: string;
      reason: "missing-in-recorded" | "missing-in-actual" | "type-mismatch";
      recorded: unknown;
      actual: unknown;
    };

export interface ClosestMatch {
  /** 1-based index into the candidate list, for "Closest recording (#N, …)". */
  cassetteIndex: number;
  definition: NockDefinition;
  similarity: Similarity;
  differences: FieldDiff[];
}

export interface MismatchReport {
  cassetteName: string;
  cassettePath: string;
  /** Used in the "re-record" fix line. */
  testName: string;
  request: ActualRequest;
  closest: ClosestMatch | null;
}

export interface DiagnoseInput {
  cassetteName: string;
  cassettePath: string;
  testName: string;
  candidates: NockDefinition[];
  request: ActualRequest;
}

export function diagnoseMismatch(input: DiagnoseInput): MismatchReport {
  const { request, candidates } = input;
  const closest = pickClosest(candidates, request);
  return {
    cassetteName: input.cassetteName,
    cassettePath: input.cassettePath,
    testName: input.testName,
    request,
    closest,
  };
}

function pickClosest(candidates: NockDefinition[], request: ActualRequest): ClosestMatch | null {
  if (candidates.length === 0) {
    return null;
  }

  const reqPath = pathFromUrl(request.url);
  const reqMethod = request.method.toUpperCase();

  const scored = candidates.map((def, i) => ({
    def,
    index: i + 1,
    similarity: similarityOf(def, reqMethod, reqPath),
  }));

  // Higher rank = closer.
  const rank: Record<Similarity, number> = {
    "same-method-and-path": 3,
    "same-path": 2,
    "same-method": 1,
    weak: 0,
  };
  const best = scored.reduce((a, b) => (rank[b.similarity] > rank[a.similarity] ? b : a));
  const tier = scored.filter((s) => s.similarity === best.similarity);

  // Within a tier, pick the candidate whose body diff is smallest. That makes
  // the "closest" feel intuitive when several recordings share a path.
  let chosen = tier[0]!;
  let chosenDiffs = diffAll(chosen.def, request);
  for (let i = 1; i < tier.length; i++) {
    const cand = tier[i]!;
    const candDiffs = diffAll(cand.def, request);
    if (candDiffs.length < chosenDiffs.length) {
      chosen = cand;
      chosenDiffs = candDiffs;
    }
  }

  return {
    cassetteIndex: chosen.index,
    definition: chosen.def,
    similarity: chosen.similarity,
    differences: chosenDiffs,
  };
}

function similarityOf(def: NockDefinition, method: string, path: string): Similarity {
  const sameMethod = (def.method ?? "GET").toUpperCase() === method;
  const samePath = stripQuery(def.path) === stripQuery(path);
  if (sameMethod && samePath) {
    return "same-method-and-path";
  }
  if (samePath) {
    return "same-path";
  }
  if (sameMethod) {
    return "same-method";
  }
  return "weak";
}

function diffAll(def: NockDefinition, request: ActualRequest): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  const recMethod = (def.method ?? "GET").toUpperCase();
  const reqMethod = request.method.toUpperCase();
  if (recMethod !== reqMethod) {
    diffs.push({ kind: "method", recorded: recMethod, actual: reqMethod });
  }

  const recUrl = `${def.scope ?? ""}${def.path ?? ""}`;
  if (stripQuery(recUrl) !== stripQuery(request.url)) {
    diffs.push({ kind: "url", recorded: recUrl, actual: request.url });
  } else {
    // Paths match modulo the query string — surface per-parameter diffs
    // rather than going silent on what's actually different.
    diffQuery(extractQuery(recUrl), extractQuery(request.url), diffs);
  }

  diffBodies(parseBody(def.body), parseBody(request.body), "", diffs);
  diffHeaders(def.reqheaders, request.headers, diffs);
  return diffs;
}

/**
 * Parse the query portion of a URL into an ordered `(name, value)` list. We
 * keep an array rather than a Map because real-world APIs use repeated keys
 * (`?tag=a&tag=b`) and we'd lose information collapsing them. Order is
 * preserved within each name so subsequent equality is positional.
 */
function extractQuery(url: string): Array<[string, string]> {
  const q = url.indexOf("?");
  if (q === -1) {
    return [];
  }
  const out: Array<[string, string]> = [];
  for (const pair of url.slice(q + 1).split("&")) {
    if (pair === "") {
      continue;
    }
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : pair.slice(eq + 1);
    try {
      out.push([decodeURIComponent(name), decodeURIComponent(value)]);
    } catch {
      out.push([name, value]);
    }
  }
  return out;
}

function diffQuery(
  recorded: Array<[string, string]>,
  actual: Array<[string, string]>,
  out: FieldDiff[],
): void {
  // Group by name so repeated-key queries (`?tag=a&tag=b`) compare positionally
  // within their group rather than collapsing.
  const recByName = groupByName(recorded);
  const actByName = groupByName(actual);
  const names = new Set([...recByName.keys(), ...actByName.keys()]);
  for (const name of names) {
    const recValues = recByName.get(name) ?? [];
    const actValues = actByName.get(name) ?? [];
    const len = Math.max(recValues.length, actValues.length);
    for (let i = 0; i < len; i++) {
      const r = recValues[i];
      const a = actValues[i];
      if (r === a) {
        continue;
      }
      out.push({ kind: "query", name, recorded: r, actual: a });
    }
  }
}

function groupByName(pairs: Array<[string, string]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, v] of pairs) {
    const existing = out.get(k);
    if (existing) {
      existing.push(v);
    } else {
      out.set(k, [v]);
    }
  }
  return out;
}

function diffBodies(recorded: unknown, actual: unknown, path: string, out: FieldDiff[]): void {
  // An ordinal token on the recorded side is match-normalized, so the concrete
  // value is not a mismatch reason. Secret placeholders are deliberately not
  // included: replay matches those by plain equality.
  if (isOrdinalToken(recorded)) {
    return;
  }

  if (isPlainObject(recorded) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(recorded), ...Object.keys(actual)]);
    for (const k of keys) {
      const child = path === "" ? k : `${path}.${k}`;
      const hasR = k in recorded;
      const hasA = k in actual;
      if (hasR && !hasA) {
        out.push({
          kind: "body-shape",
          path: child,
          reason: "missing-in-actual",
          recorded: recorded[k],
          actual: undefined,
        });
        continue;
      }
      if (!hasR && hasA) {
        out.push({
          kind: "body-shape",
          path: child,
          reason: "missing-in-recorded",
          recorded: undefined,
          actual: actual[k],
        });
        continue;
      }
      diffBodies(recorded[k], actual[k], child, out);
    }
    return;
  }

  if (Array.isArray(recorded) && Array.isArray(actual)) {
    const len = Math.max(recorded.length, actual.length);
    for (let i = 0; i < len; i++) {
      const child = `${path}[${i}]`;
      if (i >= actual.length) {
        out.push({
          kind: "body-shape",
          path: child,
          reason: "missing-in-actual",
          recorded: recorded[i],
          actual: undefined,
        });
        continue;
      }
      if (i >= recorded.length) {
        out.push({
          kind: "body-shape",
          path: child,
          reason: "missing-in-recorded",
          recorded: undefined,
          actual: actual[i],
        });
        continue;
      }
      diffBodies(recorded[i], actual[i], child, out);
    }
    return;
  }

  if (typeof recorded !== typeof actual || Array.isArray(recorded) !== Array.isArray(actual)) {
    // Empty path means the whole body has a type mismatch; surface at root.
    out.push({
      kind: "body-shape",
      path: path === "" ? "(body)" : path,
      reason: "type-mismatch",
      recorded,
      actual,
    });
    return;
  }

  if (recorded === actual) {
    return;
  }

  const diff: Extract<FieldDiff, { kind: "body" }> = {
    kind: "body",
    path: path === "" ? "(body)" : path,
    recorded,
    actual,
  };
  const hint = detectHint(actual);
  if (hint !== undefined) {
    diff.hint = hint;
  }
  out.push(diff);
}

function diffHeaders(
  recorded: Record<string, string | string[]> | undefined,
  actual: Record<string, string | string[]> | undefined,
  out: FieldDiff[],
): void {
  if (!recorded) {
    return;
  }
  const actualLower = lowercaseKeys(actual ?? {});
  for (const [name, recVal] of Object.entries(recorded)) {
    const lower = name.toLowerCase();
    const actVal = actualLower[lower];
    if (isOrdinalToken(recVal)) {
      continue;
    }
    if (actVal === undefined) {
      const diff: Extract<FieldDiff, { kind: "header" }> = {
        kind: "header",
        name,
        recorded: recVal,
        actual: undefined,
      };
      const hint = detectHint(recVal);
      if (hint !== undefined) {
        diff.hint = hint;
      }
      out.push(diff);
      continue;
    }
    if (recVal === actVal) {
      continue;
    }
    const diff: Extract<FieldDiff, { kind: "header" }> = {
      kind: "header",
      name,
      recorded: recVal,
      actual: actVal,
    };
    const hint = detectHint(actVal);
    if (hint !== undefined) {
      diff.hint = hint;
    }
    out.push(diff);
  }
}

function lowercaseKeys(obj: Record<string, string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function pathFromUrl(url: string): string {
  // Match nock's split: keep everything from the third "/" onward.
  const m = /^[a-z]+:\/\/[^/]+(\/.*)?$/i.exec(url);
  return m?.[1] ?? url;
}

function stripQuery(path: string): string {
  const q = path.indexOf("?");
  return q === -1 ? path : path.slice(0, q);
}

const ID_RES: ReadonlyArray<RegExp> = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^gid:\/\//, // shopify-style global id
  /^[A-Za-z0-9_-]{20,}$/, // long opaque token
];

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function detectHint(value: unknown): DiffHint | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (ISO_TIMESTAMP_RE.test(value)) {
    return "looks-like-timestamp";
  }
  if (ID_RES.some((re) => re.test(value))) {
    return "looks-like-id";
  }
  return undefined;
}

/**
 * Render a MismatchReport in the user-facing diagnostic layout. The rendering choices (column
 * alignment, hint suffix wording, Fix footer) live here only; structure stays
 * in the report so tests can assert behavior without parsing strings.
 */
export function formatMismatch(report: MismatchReport): string {
  const lines: string[] = [];
  const reqLabel =
    report.request.index === undefined ? "" : ` for request #${report.request.index}`;
  lines.push(`✗ cassette "${report.cassetteName}" — no recorded match${reqLabel}`);
  lines.push("");
  lines.push(`  ${report.request.method.toUpperCase()} ${report.request.url}`);
  lines.push("");

  const closest = report.closest;
  if (!closest) {
    lines.push("  Cassette has no recordings to compare against.");
    lines.push("");
    lines.push(`  Fix: re-record this test:`);
    lines.push(`    ${reRecordCommand(report.cassettePath)}`);
    return lines.join("\n");
  }

  lines.push(
    `  Closest recording (#${closest.cassetteIndex}, ${humanSimilarity(closest.similarity)}) differs:`,
  );
  lines.push("");

  if (closest.differences.length === 0) {
    lines.push("  (no field-level differences — likely a header or shape nock can't render)");
  } else {
    for (const d of closest.differences) {
      lines.push(...renderDiff(d).map((l) => `    ${l}`));
      lines.push("");
    }
    // Trim the final blank.
    if (lines.at(-1) === "") {
      lines.pop();
    }
  }

  lines.push("");
  lines.push(`  Fix: ${fixSuggestion(closest.differences)}`);
  lines.push(`    ${reRecordCommand(report.cassettePath)}`);
  return lines.join("\n");
}

function humanSimilarity(s: Similarity): string {
  switch (s) {
    case "same-method-and-path":
      return "same path";
    case "same-path":
      return "same path, different method";
    case "same-method":
      return "same method, different path";
    case "weak":
      return "weakest match";
  }
}

function renderDiff(d: FieldDiff): string[] {
  switch (d.kind) {
    case "method":
      return [
        `method`,
        `  recorded  ${formatValue(d.recorded)}`,
        `  actual    ${formatValue(d.actual)}`,
      ];
    case "url":
      return [
        `url`,
        `  recorded  ${formatValue(d.recorded)}`,
        `  actual    ${formatValue(d.actual)}`,
      ];
    case "query":
      return [
        `query ${d.name}`,
        `  recorded  ${formatValue(d.recorded)}`,
        `  actual    ${formatValue(d.actual)}`,
      ];
    case "header":
      return [
        `header ${d.name}`,
        `  recorded  ${formatValue(d.recorded)}`,
        `  actual    ${formatValue(d.actual)}${hintSuffix(d.hint)}`,
      ];
    case "body":
      return [
        d.path,
        `  recorded  ${formatValue(d.recorded)}`,
        `  actual    ${formatValue(d.actual)}${hintSuffix(d.hint)}`,
      ];
    case "body-shape":
      return renderShapeDiff(d);
  }
}

function renderShapeDiff(d: Extract<FieldDiff, { kind: "body-shape" }>): string[] {
  switch (d.reason) {
    case "missing-in-actual":
      return [`${d.path}  (missing in request)`, `  recorded  ${formatValue(d.recorded)}`];
    case "missing-in-recorded":
      return [`${d.path}  (not in recording)`, `  actual    ${formatValue(d.actual)}`];
    case "type-mismatch":
      return [
        `${d.path}  (type mismatch)`,
        `  recorded  ${formatValue(d.recorded)}`,
        `  actual    ${formatValue(d.actual)}`,
      ];
  }
}

function hintSuffix(hint: DiffHint | undefined): string {
  switch (hint) {
    case "looks-like-id":
      return "   ← looks like an id; mark volatile?";
    case "looks-like-timestamp":
      return "   ← looks like a timestamp; mark volatile?";
    case undefined:
      return "";
  }
}

function formatValue(v: unknown): string {
  if (v === undefined) {
    return "(unset)";
  }
  if (typeof v === "string") {
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

function fixSuggestion(diffs: FieldDiff[]): string {
  const bodyField = diffs.find(
    (d): d is Extract<FieldDiff, { kind: "body" }> => d.kind === "body" && d.hint !== undefined,
  );
  if (bodyField) {
    return `add '${leafFieldName(bodyField.path)}' to volatile.request.body, or re-record:`;
  }
  const headerField = diffs.find(
    (d): d is Extract<FieldDiff, { kind: "header" }> => d.kind === "header" && d.hint !== undefined,
  );
  if (headerField) {
    return `add '${headerField.name}' to volatile.request.headers, or re-record:`;
  }
  return `update the test to match the recording, or re-record:`;
}

function leafFieldName(path: string): string {
  const segments = path.split(".");
  return segments.at(-1)!.replace(/\[\d+\]/g, "");
}

function reRecordCommand(cassettePath: string): string {
  return `rm ${JSON.stringify(cassettePath)} && bside record`;
}
