/**
 * Record-mode diff reporter. After `vcrkit record` runs, summarize which
 * cassettes were created, changed, or untouched relative to the pre-run state.
 *
 * Diffs are computed on a normalized cassette so volatile ordinal churn
 * (a re-record that produces values in a different order) doesn't show as
 * "changed lines" when the cassette is materially the same.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { isPlainObject } from "../core/value.ts";

export type CassetteSnapshot = Map<string, string>;

export type CassetteStatus = "created" | "changed" | "unchanged" | "orphaned";

/** Field-level diff between an old and a new cassette. */
export type CassetteFieldChange =
  | { kind: "added"; path: string; after: unknown }
  | { kind: "removed"; path: string; before: unknown }
  | { kind: "changed"; path: string; before: unknown; after: unknown };

/**
 * Per-definition metadata so the renderer can label field changes with
 * `Request #N: METHOD path` instead of inscrutable `definitions[N].…` paths.
 */
export interface CassetteDefinition {
  method: string;
  path: string;
}

export interface CassetteEntry {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the project root, for display. */
  relPath: string;
  status: CassetteStatus;
  /** Only meaningful for `created` and `changed`. */
  addedLines: number;
  /** Only meaningful for `changed`. */
  removedLines: number;
  /**
   * Field-level changes for `changed` cassettes, only populated when the total
   * count is small enough to display inline (see {@link FIELD_DIFF_THRESHOLD}).
   *
   * When the diff is too sprawling to read, this is `undefined` and the caller
   * falls back to the line counts above.
   */
  fields?: CassetteFieldChange[];
  /** Total field-level changes regardless of whether `fields` was populated. */
  totalFieldChanges?: number;
  /**
   * Definitions in the post-record cassette, parallel-indexed with `[i]` paths
   * in `fields`. Populated only when fields is populated and the cassette
   * parsed cleanly.
   */
  definitions?: CassetteDefinition[];
  /**
   * The test that wrote this cassette failed. The cassette may be stale or
   * partial — show with a ✗ marker instead of a benign unchanged/changed glyph.
   */
  testFailed?: boolean;
}

/** A failing test, paired with the cassette path it would write to. */
export interface FailedTest {
  /** Absolute path to the test file. */
  file: string;
  /** The test name as the test runner reports it. */
  name: string;
  /** Absolute path to the cassette this test would write to. */
  cassettePath: string;
}

/**
 * Bail out of rendering field changes above this threshold to avoid overwhelming users.
 */
export const FIELD_DIFF_THRESHOLD = 5;

export interface RecordSummary {
  cassettes: CassetteEntry[];
  /**
   * Failed tests with their resolved cassette paths. Empty when the run was fully green.
   *
   * Surfaced both inline (cassette gets a ✗) and as a trailing list in
   * `formatRecordSummary`, so failure is visible at the bottom of the record
   * output regardless of how the runner sequenced its own report.
   */
  failedTests: FailedTest[];
  totals: {
    created: number;
    changed: number;
    unchanged: number;
    /** Files on disk that no test in this record run claimed. */
    orphaned: number;
    /** Total scrub-rule substitutions, summed across all tests. */
    redacted: number;
    /** Count of `failedTests`, surfaced in the totals line. */
    failed: number;
  };
}

export interface SummarizeOptions {
  /** Caller supplies this from aggregated per-test `task.meta.vcrkitRedacted`. */
  redactedTotal?: number;
  /** Failed tests collected from the runner's task tree. */
  failedTests?: FailedTest[];
  /** Cassette paths claimed by tests participating in this record run. */
  activeCassettePaths?: readonly string[];
}

const CASSETTE_DIR = "__cassettes__";
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", ".next"]);

/**
 * Walk `root` collecting every `__cassettes__/.../*.json`. Cheap full scan
 * is fine — cassette trees are small and the cost is dwarfed by `vitest`'s
 * own startup.
 */
export function snapshotCassettes(root: string): CassetteSnapshot {
  const out: CassetteSnapshot = new Map();
  walk(root, (path) => {
    if (path.includes(`/${CASSETTE_DIR}/`) && path.endsWith(".json")) {
      try {
        out.set(path, readFileSync(path, "utf8"));
      } catch {
        // Race with concurrent writes is fine — skip.
      }
    }
  });
  return out;
}

function walk(dir: string, visit: (path: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) {
      continue;
    }
    const full = join(dir, name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      walk(full, visit);
    } else if (stats.isFile()) {
      visit(full);
    }
  }
}

export function summarizeRecord(
  before: CassetteSnapshot,
  after: CassetteSnapshot,
  root: string,
  options: SummarizeOptions = {},
): RecordSummary {
  const cassettes: CassetteEntry[] = [];
  let created = 0;
  let changed = 0;
  let unchanged = 0;
  let orphaned = 0;

  const failedTests = options.failedTests ?? [];
  const failedCassettePaths = new Set(failedTests.map((t) => t.cassettePath));
  const activeCassettePaths =
    options.activeCassettePaths === undefined ? null : new Set(options.activeCassettePaths);

  // Stable sort by relative path for predictable output.
  const paths = Array.from(after.keys()).sort();

  for (const path of paths) {
    const newContent = after.get(path)!;
    const oldContent = before.get(path);
    const relPath = relative(root, path);
    const testFailed = failedCassettePaths.has(path);

    if (activeCassettePaths !== null && !activeCassettePaths.has(path)) {
      cassettes.push({
        path,
        relPath,
        status: "orphaned",
        addedLines: 0,
        removedLines: 0,
      });
      orphaned++;
      continue;
    }

    if (oldContent === undefined) {
      const lineCount = countLines(newContent);
      cassettes.push({
        path,
        relPath,
        status: "created",
        addedLines: lineCount,
        removedLines: 0,
        ...(testFailed ? { testFailed: true } : {}),
      });
      created++;
      continue;
    }

    const { added, removed } = diffNormalized(oldContent, newContent);
    if (added === 0 && removed === 0) {
      cassettes.push({
        path,
        relPath,
        status: "unchanged",
        addedLines: 0,
        removedLines: 0,
        ...(testFailed ? { testFailed: true } : {}),
      });
      unchanged++;
    } else {
      const fieldChanges = diffCassetteFields(oldContent, newContent);
      const entry: CassetteEntry = {
        path,
        relPath,
        status: "changed",
        addedLines: added,
        removedLines: removed,
      };
      if (testFailed) {
        entry.testFailed = true;
      }
      if (fieldChanges !== null) {
        entry.totalFieldChanges = fieldChanges.length;
        if (fieldChanges.length > 0 && fieldChanges.length <= FIELD_DIFF_THRESHOLD) {
          entry.fields = fieldChanges;
          const definitions = extractDefinitions(newContent);
          if (definitions !== undefined) {
            entry.definitions = definitions;
          }
        }
      }
      cassettes.push(entry);
      changed++;
    }
  }

  return {
    cassettes,
    failedTests,
    totals: {
      created,
      changed,
      unchanged,
      orphaned,
      redacted: options.redactedTotal ?? 0,
      failed: failedTests.length,
    },
  };
}

const ORDINAL_RE = /(<!(?:volatile|redact)![^!]+:[^!]+!)(\d+)>/g;

/**
 * Normalize ordinal labels by first appearance within each token namespace.
 * This ignores arbitrary labels (`[7, 4]` and `[0, 1]` are equivalent) while
 * preserving the reuse pattern (`[0, 0, 1]` and `[0, 1, 1]` are not).
 */
function normalize(content: string): string {
  const ordinalsByNamespace = new Map<string, Map<string, number>>();
  return content.replace(ORDINAL_RE, (_token, namespace: string, ordinal: string) => {
    let ordinals = ordinalsByNamespace.get(namespace);
    if (!ordinals) {
      ordinals = new Map();
      ordinalsByNamespace.set(namespace, ordinals);
    }
    let normalized = ordinals.get(ordinal);
    if (normalized === undefined) {
      normalized = ordinals.size;
      ordinals.set(ordinal, normalized);
    }
    return `${namespace}${normalized}>`;
  });
}

function diffNormalized(
  oldContent: string,
  newContent: string,
): {
  added: number;
  removed: number;
} {
  const oldLines = normalize(oldContent).split("\n");
  const newLines = normalize(newContent).split("\n");
  // LCS length — for ~hundred-line cassettes this is O(n*m) and trivial.
  const oldLineCount = oldLines.length;
  const newLineCount = newLines.length;
  let prev = new Int32Array(newLineCount + 1);
  let curr = new Int32Array(newLineCount + 1);
  for (let i = 1; i <= oldLineCount; i++) {
    for (let j = 1; j <= newLineCount; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        curr[j] = prev[j - 1]! + 1;
      } else {
        curr[j] = Math.max(prev[j]!, curr[j - 1]!);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[newLineCount]!;
  return { added: newLineCount - lcs, removed: oldLineCount - lcs };
}

function countLines(s: string): number {
  if (s === "") {
    return 0;
  }
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      n++;
    }
  }
  return n;
}

/**
 * Structural diff between two cassette JSON files. Returns `null` if either
 * side fails to parse — the caller falls back to line counts. Ordinal tokens
 * are normalized so a reordered value sequence doesn't surface as field
 * changes (the cassette is materially the same).
 */
function diffCassetteFields(oldContent: string, newContent: string): CassetteFieldChange[] | null {
  let before: unknown;
  let after: unknown;
  try {
    before = JSON.parse(normalize(oldContent));
    after = JSON.parse(normalize(newContent));
  } catch {
    return null;
  }
  const out: CassetteFieldChange[] = [];
  diffJson(before, after, "", out);
  return out;
}

function diffJson(before: unknown, after: unknown, path: string, out: CassetteFieldChange[]): void {
  if (Object.is(before, after)) {
    return;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      const child = path === "" ? k : `${path}.${k}`;
      const hasBefore = k in before;
      const hasAfter = k in after;
      if (hasBefore && !hasAfter) {
        out.push({ kind: "removed", path: child, before: before[k] });
        continue;
      }
      if (!hasBefore && hasAfter) {
        out.push({ kind: "added", path: child, after: after[k] });
        continue;
      }
      diffJson(before[k], after[k], child, out);
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const len = Math.max(before.length, after.length);
    for (let i = 0; i < len; i++) {
      const child = `${path}[${i}]`;
      if (i >= after.length) {
        out.push({ kind: "removed", path: child, before: before[i] });
        continue;
      }
      if (i >= before.length) {
        out.push({ kind: "added", path: child, after: after[i] });
        continue;
      }
      diffJson(before[i], after[i], child, out);
    }
    return;
  }

  // Type mismatch or unequal primitives.
  out.push({ kind: "changed", path: path || "(root)", before, after });
}

/**
 * Pull `{ method, path }` out of each definition in a cassette so the renderer
 * can label inline diffs with the actual request. Best-effort: if parse fails
 * the renderer falls back to the raw `definitions[N].…` path.
 */
function extractDefinitions(content: string): CassetteDefinition[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.definitions)) {
    return undefined;
  }
  return parsed.definitions.map((d): CassetteDefinition => {
    const method = isPlainObject(d) && typeof d.method === "string" ? d.method : "GET";
    const path = isPlainObject(d) && typeof d.path === "string" ? d.path : "";
    return { method, path };
  });
}

export interface FormatOptions {
  /** Force colors on/off. Default: auto-detects color support. */
  color?: boolean;
}

/**
 * Render a recording summary as a human-readable block. Field changes are grouped
 * by the definition (request) they belong to so paths read as `response.uuid`
 * under a `Request #2: GET /uuid` header rather than `definitions[1].…`.
 */
export function formatRecordSummary(summary: RecordSummary, options: FormatOptions = {}): string {
  const palette = makePalette(options.color ?? detectColorSupport());
  const lines: string[] = [];
  const total = summary.cassettes.length;
  if (total === 0) {
    return `${palette.bold("vcrkit record")}: no cassettes written.\n`;
  }

  lines.push(`${palette.bold("vcrkit record")}: ${total} cassette${total === 1 ? "" : "s"}`);
  for (const entry of summary.cassettes) {
    lines.push(formatEntryHeader(entry, palette));
    if (entry.fields && entry.fields.length > 0) {
      lines.push(...formatGroupedFields(entry, palette));
    }
  }

  // Failures: list them after the cassette diff and before the totals so the
  // last lines of `vcrkit record` output own the failure unambiguously, instead
  // of trailing off into "N unchanged" while a test silently failed earlier in
  // the run.
  if (summary.failedTests.length > 0) {
    lines.push("");
    lines.push(
      `  ${palette.red("✗")} ${palette.bold(`${summary.failedTests.length} test${summary.failedTests.length === 1 ? "" : "s"} failed`)} during record${palette.dim(" — cassettes for failed tests may be incomplete or stale")}`,
    );
    for (const t of summary.failedTests) {
      lines.push(`      ${palette.red("✗")} ${t.name}`);
    }
  }

  lines.push("");
  const redactedSuffix =
    summary.totals.redacted > 0
      ? `, ${palette.bold(String(summary.totals.redacted))} secret${summary.totals.redacted === 1 ? "" : "s"} redacted`
      : "";
  const failedSuffix =
    summary.totals.failed > 0
      ? `, ${palette.red(palette.bold(`${summary.totals.failed} failed`))}`
      : "";
  const orphanedSuffix =
    summary.totals.orphaned > 0
      ? `, ${palette.yellow(palette.bold(`${summary.totals.orphaned} orphaned`))}`
      : "";
  lines.push(
    `  ${palette.bold(String(summary.totals.created))} created, ${palette.bold(
      String(summary.totals.changed),
    )} changed, ${palette.bold(String(summary.totals.unchanged))} unchanged${orphanedSuffix}${redactedSuffix}${failedSuffix}`,
  );
  return `${lines.join("\n")}\n`;
}

function formatEntryHeader(entry: CassetteEntry, palette: Palette): string {
  const failTag = entry.testFailed ? `  ${palette.red("(test failed)")}` : "";
  // When the test failed, the marker becomes ✗ — overriding the +/~/(blank)
  // glyph so a stale cassette can't masquerade as a benign "unchanged".
  const marker = entry.testFailed
    ? palette.red("✗")
    : entry.status === "created"
      ? palette.green("+")
      : entry.status === "changed"
        ? palette.yellow("~")
        : entry.status === "orphaned"
          ? palette.yellow("?")
          : " ";
  const name = entry.testFailed ? palette.bold(entry.relPath) : undefined;
  switch (entry.status) {
    case "created": {
      const suffix = palette.dim(
        `created (${entry.addedLines} line${entry.addedLines === 1 ? "" : "s"})`,
      );
      return `  ${marker} ${name ?? palette.bold(entry.relPath)}  ${suffix}${failTag}`;
    }
    case "changed": {
      const stats = `${palette.green(`+${entry.addedLines}`)} ${palette.red(`-${entry.removedLines}`)} lines`;
      const overflow =
        entry.totalFieldChanges !== undefined && entry.totalFieldChanges > FIELD_DIFF_THRESHOLD
          ? palette.dim(` (${entry.totalFieldChanges} field changes — too many to list)`)
          : "";
      return `  ${marker} ${name ?? palette.bold(entry.relPath)}  ${stats}${overflow}${failTag}`;
    }
    case "unchanged":
      return entry.testFailed
        ? `  ${marker} ${palette.bold(entry.relPath)}  ${palette.dim("unchanged")}${failTag}`
        : `    ${palette.dim(entry.relPath)}  ${palette.dim("unchanged")}`;
    case "orphaned":
      return `  ${marker} ${palette.bold(entry.relPath)}  ${palette.yellow("orphaned — no matching test ran")}`;
  }
}

const DEF_PATH_RE = /^definitions\[(\d+)\](?:\.(.*))?$/;

interface GroupedChanges {
  /** undefined = root-level / out-of-definitions change. */
  definitionIndex: number | undefined;
  changes: Array<{ change: CassetteFieldChange; subPath: string }>;
}

/**
 * Group field changes by which recorded request they touch, so the renderer
 * can print `Request #2: GET /uuid` once per group instead of stuttering
 * `definitions[1].…` on every line.
 */
function formatGroupedFields(entry: CassetteEntry, palette: Palette): string[] {
  const groups: GroupedChanges[] = [];
  let current: GroupedChanges | undefined;
  for (const change of entry.fields ?? []) {
    const m = DEF_PATH_RE.exec(change.path);
    const idx = m ? Number(m[1]) : undefined;
    const sub = m ? (m[2] ?? "(definition)") : change.path;
    if (!current || current.definitionIndex !== idx) {
      current = { definitionIndex: idx, changes: [] };
      groups.push(current);
    }
    current.changes.push({ change, subPath: sub });
  }

  const out: string[] = [];
  for (const group of groups) {
    if (group.definitionIndex !== undefined) {
      const def = entry.definitions?.[group.definitionIndex];
      const label =
        def !== undefined
          ? `${palette.bold(def.method.toUpperCase())} ${def.path}`
          : palette.dim("(unknown request)");
      out.push(`      ${palette.cyan(`Request #${group.definitionIndex + 1}`)}: ${label}`);
    }
    for (const { change, subPath } of group.changes) {
      const indent = group.definitionIndex !== undefined ? "        " : "      ";
      out.push(`${indent}${formatFieldChange(change, subPath, palette)}`);
    }
  }
  return out;
}

function formatFieldChange(
  change: CassetteFieldChange,
  displayPath: string,
  palette: Palette,
): string {
  const path = palette.dim(displayPath);
  switch (change.kind) {
    case "added":
      return `${palette.green("+")} ${path}: ${palette.green(formatValue(change.after))}`;
    case "removed":
      return `${palette.red("-")} ${path}: ${palette.red(formatValue(change.before))}`;
    case "changed":
      return `${palette.yellow("~")} ${path}: ${palette.red(formatValue(change.before))} → ${palette.green(
        formatValue(change.after),
      )}`;
  }
}

/** Compact one-line preview of any JSON value, truncated for very large ones. */
function formatValue(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) {
    s = "undefined";
  }
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/* ---------- Color support ---------- */

interface Palette {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
}

const PLAIN: Palette = {
  bold: (s) => s,
  dim: (s) => s,
  red: (s) => s,
  green: (s) => s,
  yellow: (s) => s,
  cyan: (s) => s,
};

function makePalette(enabled: boolean): Palette {
  if (!enabled) {
    return PLAIN;
  }
  const wrap = (open: number, close: number) => (s: string) => `[${open}m${s}[${close}m`;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

function detectColorSupport(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "") {
    if (force === "0" || force === "false") {
      return false;
    }
    return true;
  }
  return Boolean(process.stdout.isTTY);
}
