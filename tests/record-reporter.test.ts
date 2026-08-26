import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CassetteSnapshot,
  FIELD_DIFF_THRESHOLD,
  formatRecordSummary,
  type RecordSummary,
  snapshotCassettes,
  summarizeRecord,
} from "../src/bin/record-reporter.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vcrkit-rec-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeCassette(rel: string, content: object | string): string {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  const body = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  writeFileSync(full, body);
  return full;
}

describe("snapshotCassettes", () => {
  it("captures only files under __cassettes__/", () => {
    writeCassette("tests/__cassettes__/foo/happy.json", { definitions: [] });
    writeCassette("tests/__cassettes__/foo/sad.json", { definitions: [] });
    writeCassette("tests/not-a-cassette.json", { definitions: [] });
    writeCassette("tests/__cassettes__/foo/readme.txt", "noise");

    const snap = snapshotCassettes(root);
    const rels = Array.from(snap.keys())
      .map((p) => p.replace(`${root}/`, ""))
      .sort();
    expect(rels).toEqual([
      "tests/__cassettes__/foo/happy.json",
      "tests/__cassettes__/foo/sad.json",
    ]);
  });

  it("skips node_modules and dist", () => {
    writeCassette("tests/__cassettes__/a.json", { definitions: [] });
    writeCassette("node_modules/dep/__cassettes__/x.json", { definitions: [] });
    writeCassette("dist/__cassettes__/y.json", { definitions: [] });

    const snap = snapshotCassettes(root);
    expect(snap.size).toBe(1);
  });
});

describe("summarizeRecord", () => {
  it("reports created / changed / unchanged", () => {
    const unchanged = writeCassette("a/__cassettes__/u.json", { definitions: [{ k: 1 }] });
    const changed = writeCassette("a/__cassettes__/c.json", { definitions: [{ k: 1 }] });
    // `created` is born after the snapshot.

    const before: CassetteSnapshot = new Map();
    before.set(unchanged, JSON.stringify({ definitions: [{ k: 1 }] }, null, 2));
    before.set(changed, JSON.stringify({ definitions: [{ k: 1 }] }, null, 2));

    // Mutate the changed file and add a new one.
    writeCassette("a/__cassettes__/c.json", { definitions: [{ k: 1 }, { k: 2 }] });
    writeCassette("a/__cassettes__/new.json", { definitions: [{ k: 9 }] });

    const after = snapshotCassettes(root);
    const summary = summarizeRecord(before, after, root);

    expect(summary.totals).toEqual({
      created: 1,
      changed: 1,
      unchanged: 1,
      orphaned: 0,
      redacted: 0,
      failed: 0,
    });
    const byName = new Map(summary.cassettes.map((c) => [c.relPath, c]));
    expect(byName.get("a/__cassettes__/u.json")?.status).toBe("unchanged");
    expect(byName.get("a/__cassettes__/c.json")?.status).toBe("changed");
    expect(byName.get("a/__cassettes__/new.json")?.status).toBe("created");
    expect(byName.get("a/__cassettes__/c.json")!.addedLines).toBeGreaterThan(0);
  });

  it("normalizes volatile ordinals so reordering isn't churn", () => {
    // Same content materially — only the ordinal sequence shifted.
    const before = JSON.stringify(
      {
        definitions: [
          { body: { token: "<!volatile!body:token!0>" } },
          { body: { token: "<!volatile!body:token!1>" } },
        ],
      },
      null,
      2,
    );
    const after = JSON.stringify(
      {
        definitions: [
          { body: { token: "<!volatile!body:token!1>" } },
          { body: { token: "<!volatile!body:token!0>" } },
        ],
      },
      null,
      2,
    );
    const path = writeCassette("__cassettes__/r.json", after);
    const beforeMap: CassetteSnapshot = new Map([[path, before]]);
    const afterMap = snapshotCassettes(root);

    const summary = summarizeRecord(beforeMap, afterMap, root);
    expect(summary.cassettes[0]!.status).toBe("unchanged");
  });

  it("reports a changed volatile-value reuse pattern", () => {
    const cassette = (ordinals: number[]): string =>
      JSON.stringify(
        {
          definitions: ordinals.map((ordinal) => ({
            body: { token: `<!volatile!body:token!${ordinal}>` },
          })),
        },
        null,
        2,
      );
    const before = cassette([0, 0, 1]);
    const after = cassette([0, 1, 1]);
    const path = writeCassette("__cassettes__/reuse.json", after);

    const summary = summarizeRecord(new Map([[path, before]]), snapshotCassettes(root), root);

    expect(summary.cassettes[0]!.status).toBe("changed");
    expect(summary.cassettes[0]!.totalFieldChanges).toBe(1);
  });

  it("threads redactedTotal through to the summary", () => {
    const path = writeCassette("__cassettes__/r.json", { definitions: [] });
    const beforeMap: CassetteSnapshot = new Map([
      [path, JSON.stringify({ definitions: [] }, null, 2)],
    ]);
    const afterMap = snapshotCassettes(root);
    const summary = summarizeRecord(beforeMap, afterMap, root, { redactedTotal: 7 });
    expect(summary.totals.redacted).toBe(7);
  });

  it("marks cassettes not claimed by this run as orphaned", () => {
    const active = writeCassette("__cassettes__/active.json", { definitions: [] });
    const orphaned = writeCassette("__cassettes__/removed-test.json", { definitions: [] });
    const after = snapshotCassettes(root);

    const summary = summarizeRecord(after, after, root, { activeCassettePaths: [active] });
    const byPath = new Map(summary.cassettes.map((cassette) => [cassette.path, cassette]));

    expect(byPath.get(active)?.status).toBe("unchanged");
    expect(byPath.get(orphaned)?.status).toBe("orphaned");
    expect(summary.totals.orphaned).toBe(1);
  });

  it("flags a real content change as changed", () => {
    const before = JSON.stringify({ definitions: [{ body: { op: "charge" } }] }, null, 2);
    const after = JSON.stringify({ definitions: [{ body: { op: "refund" } }] }, null, 2);
    const path = writeCassette("__cassettes__/c.json", after);
    const beforeMap: CassetteSnapshot = new Map([[path, before]]);
    const afterMap = snapshotCassettes(root);

    const summary = summarizeRecord(beforeMap, afterMap, root);
    expect(summary.cassettes[0]!.status).toBe("changed");
    expect(summary.cassettes[0]!.addedLines).toBeGreaterThan(0);
    expect(summary.cassettes[0]!.removedLines).toBeGreaterThan(0);
  });

  it("populates field-level diffs when the change is small", () => {
    const before = JSON.stringify(
      { definitions: [{ body: { op: "charge", cartId: "abc" } }] },
      null,
      2,
    );
    const after = JSON.stringify(
      { definitions: [{ body: { op: "refund", cartId: "abc", reason: "fraud" } }] },
      null,
      2,
    );
    const path = writeCassette("__cassettes__/c.json", after);
    const beforeMap: CassetteSnapshot = new Map([[path, before]]);
    const afterMap = snapshotCassettes(root);

    const summary = summarizeRecord(beforeMap, afterMap, root);
    const entry = summary.cassettes[0]!;
    expect(entry.status).toBe("changed");
    expect(entry.totalFieldChanges).toBe(2);
    expect(entry.fields).toHaveLength(2);
    const byPath = Object.fromEntries(entry.fields!.map((f) => [f.path, f]));
    expect(byPath["definitions[0].body.op"]).toEqual({
      kind: "changed",
      path: "definitions[0].body.op",
      before: "charge",
      after: "refund",
    });
    expect(byPath["definitions[0].body.reason"]).toEqual({
      kind: "added",
      path: "definitions[0].body.reason",
      after: "fraud",
    });
  });

  it("falls back to line summary when too many fields changed", () => {
    // Generate FIELD_DIFF_THRESHOLD + 1 changes by mutating that many keys.
    const overflow = FIELD_DIFF_THRESHOLD + 1;
    const beforeBody: Record<string, number> = {};
    const afterBody: Record<string, number> = {};
    for (let i = 0; i < overflow; i++) {
      beforeBody[`k${i}`] = i;
      afterBody[`k${i}`] = i + 100;
    }
    const before = JSON.stringify({ definitions: [{ body: beforeBody }] }, null, 2);
    const after = JSON.stringify({ definitions: [{ body: afterBody }] }, null, 2);
    const path = writeCassette("__cassettes__/big.json", after);
    const beforeMap: CassetteSnapshot = new Map([[path, before]]);
    const afterMap = snapshotCassettes(root);

    const summary = summarizeRecord(beforeMap, afterMap, root);
    const entry = summary.cassettes[0]!;
    expect(entry.totalFieldChanges).toBe(overflow);
    // Too many to list — fields is omitted, caller falls back to line counts.
    expect(entry.fields).toBeUndefined();
  });

  it("normalizes ordinal tokens at the field level too", () => {
    // Same value sequence semantically — only the ordinal numbers differ.
    const before = JSON.stringify(
      { definitions: [{ body: { token: "<!volatile!body:token!0>", op: "charge" } }] },
      null,
      2,
    );
    const after = JSON.stringify(
      { definitions: [{ body: { token: "<!volatile!body:token!7>", op: "charge" } }] },
      null,
      2,
    );
    const path = writeCassette("__cassettes__/r.json", after);
    const beforeMap: CassetteSnapshot = new Map([[path, before]]);
    const afterMap = snapshotCassettes(root);

    const summary = summarizeRecord(beforeMap, afterMap, root);
    expect(summary.cassettes[0]!.status).toBe("unchanged");
  });
});

describe("formatRecordSummary", () => {
  it("renders a multi-cassette summary", () => {
    const summary: RecordSummary = {
      cassettes: [
        {
          path: "/x/tests/__cassettes__/a/created.json",
          relPath: "tests/__cassettes__/a/created.json",
          status: "created",
          addedLines: 42,
          removedLines: 0,
        },
        {
          path: "/x/tests/__cassettes__/a/changed.json",
          relPath: "tests/__cassettes__/a/changed.json",
          status: "changed",
          addedLines: 3,
          removedLines: 1,
        },
        {
          path: "/x/tests/__cassettes__/a/same.json",
          relPath: "tests/__cassettes__/a/same.json",
          status: "unchanged",
          addedLines: 0,
          removedLines: 0,
        },
      ],
      failedTests: [],
      totals: { created: 1, changed: 1, unchanged: 1, orphaned: 0, redacted: 4, failed: 0 },
    };
    const out = formatRecordSummary(summary, { color: false });
    expect(out).toContain("vcrkit record: 3 cassettes");
    expect(out).toContain("+ tests/__cassettes__/a/created.json");
    expect(out).toContain("created (42 lines)");
    expect(out).toContain("~ tests/__cassettes__/a/changed.json");
    expect(out).toContain("+3 -1 lines");
    expect(out).toContain("unchanged");
    expect(out).toContain("1 created, 1 changed, 1 unchanged, 4 secrets redacted");
  });

  it("omits the redacted clause when zero", () => {
    const out = formatRecordSummary(
      {
        cassettes: [
          {
            path: "/x/__cassettes__/a.json",
            relPath: "__cassettes__/a.json",
            status: "unchanged",
            addedLines: 0,
            removedLines: 0,
          },
        ],
        failedTests: [],
        totals: { created: 0, changed: 0, unchanged: 1, orphaned: 0, redacted: 0, failed: 0 },
      },
      { color: false },
    );
    expect(out).not.toContain("redacted");
  });

  it("renders orphaned cassettes as actionable warnings", () => {
    const out = formatRecordSummary(
      {
        cassettes: [
          {
            path: "/x/__cassettes__/removed.json",
            relPath: "__cassettes__/removed.json",
            status: "orphaned",
            addedLines: 0,
            removedLines: 0,
          },
        ],
        failedTests: [],
        totals: { created: 0, changed: 0, unchanged: 0, orphaned: 1, redacted: 0, failed: 0 },
      },
      { color: false },
    );

    expect(out).toContain("? __cassettes__/removed.json  orphaned — no matching test ran");
    expect(out).toContain("1 orphaned");
  });

  it("handles the empty case", () => {
    const out = formatRecordSummary(
      {
        cassettes: [],
        failedTests: [],
        totals: { created: 0, changed: 0, unchanged: 0, orphaned: 0, redacted: 0, failed: 0 },
      },
      { color: false },
    );
    expect(out).toContain("no cassettes written");
  });

  it("groups inline field changes under a Request #N header", () => {
    const out = formatRecordSummary(
      {
        cassettes: [
          {
            path: "/x/__cassettes__/c.json",
            relPath: "__cassettes__/c.json",
            status: "changed",
            addedLines: 2,
            removedLines: 1,
            totalFieldChanges: 2,
            definitions: [{ method: "POST", path: "/checkout" }],
            fields: [
              {
                kind: "changed",
                path: "definitions[0].body.op",
                before: "charge",
                after: "refund",
              },
              { kind: "added", path: "definitions[0].body.reason", after: "fraud" },
            ],
          },
        ],
        failedTests: [],
        totals: { created: 0, changed: 1, unchanged: 0, orphaned: 0, redacted: 0, failed: 0 },
      },
      { color: false },
    );
    // Header shows the actual request, not a definitions[0] path.
    expect(out).toContain("Request #1: POST /checkout");
    // Field paths within the group drop the definitions[…] prefix.
    expect(out).toContain('body.op: "charge" → "refund"');
    expect(out).toContain('+ body.reason: "fraud"');
    expect(out).not.toContain("definitions[0]");
  });

  it("falls back to (unknown request) when definitions metadata is missing", () => {
    const out = formatRecordSummary(
      {
        cassettes: [
          {
            path: "/x/__cassettes__/c.json",
            relPath: "__cassettes__/c.json",
            status: "changed",
            addedLines: 1,
            removedLines: 1,
            totalFieldChanges: 1,
            fields: [
              {
                kind: "changed",
                path: "definitions[0].body.op",
                before: "a",
                after: "b",
              },
            ],
          },
        ],
        failedTests: [],
        totals: { created: 0, changed: 1, unchanged: 0, orphaned: 0, redacted: 0, failed: 0 },
      },
      { color: false },
    );
    expect(out).toContain("Request #1");
    expect(out).toContain("(unknown request)");
  });

  it("emits no ANSI when color is forced off (CI-friendly)", () => {
    const out = formatRecordSummary(
      {
        cassettes: [
          {
            path: "/x/__cassettes__/c.json",
            relPath: "__cassettes__/c.json",
            status: "changed",
            addedLines: 1,
            removedLines: 0,
            totalFieldChanges: 1,
            definitions: [{ method: "GET", path: "/" }],
            fields: [{ kind: "added", path: "definitions[0].body.x", after: 1 }],
          },
        ],
        failedTests: [],
        totals: { created: 0, changed: 1, unchanged: 0, orphaned: 0, redacted: 0, failed: 0 },
      },
      { color: false },
    );
    // ANSI CSI is ESC [ — should not appear anywhere.
    expect(out).not.toMatch(/\[/);
  });

  it("emits ANSI sequences when color is forced on", () => {
    const out = formatRecordSummary(
      {
        cassettes: [
          {
            path: "/x/__cassettes__/c.json",
            relPath: "__cassettes__/c.json",
            status: "changed",
            addedLines: 1,
            removedLines: 0,
            totalFieldChanges: 1,
            definitions: [{ method: "GET", path: "/" }],
            fields: [{ kind: "added", path: "definitions[0].body.x", after: 1 }],
          },
        ],
        failedTests: [],
        totals: { created: 0, changed: 1, unchanged: 0, orphaned: 0, redacted: 0, failed: 0 },
      },
      { color: true },
    );
    expect(out).toMatch(/\[/);
  });

  it("notes when field count exceeded the inline threshold", () => {
    const out = formatRecordSummary(
      {
        cassettes: [
          {
            path: "/x/__cassettes__/big.json",
            relPath: "__cassettes__/big.json",
            status: "changed",
            addedLines: 50,
            removedLines: 50,
            totalFieldChanges: 42,
            // fields intentionally omitted — too many to list.
          },
        ],
        failedTests: [],
        totals: { created: 0, changed: 1, unchanged: 0, orphaned: 0, redacted: 0, failed: 0 },
      },
      { color: false },
    );
    expect(out).toContain("42 field changes — too many to list");
  });

  it("marks failed-test cassettes inline and lists failures at the end", () => {
    const out = formatRecordSummary(
      {
        cassettes: [
          {
            path: "/x/tests/__cassettes__/a/ok.json",
            relPath: "tests/__cassettes__/a/ok.json",
            status: "unchanged",
            addedLines: 0,
            removedLines: 0,
          },
          {
            path: "/x/tests/__cassettes__/a/bad.json",
            relPath: "tests/__cassettes__/a/bad.json",
            status: "unchanged",
            addedLines: 0,
            removedLines: 0,
            testFailed: true,
          },
        ],
        failedTests: [
          {
            file: "/x/tests/a.vcr.test.ts",
            name: "the bad one",
            cassettePath: "/x/tests/__cassettes__/a/bad.json",
          },
        ],
        totals: { created: 0, changed: 0, unchanged: 2, orphaned: 0, redacted: 0, failed: 1 },
      },
      { color: false },
    );
    // The failed cassette renders with ✗ + (test failed) tag, not the benign blank glyph.
    expect(out).toMatch(/✗ tests\/__cassettes__\/a\/bad\.json.*\(test failed\)/);
    // The good one keeps the dim "unchanged" treatment.
    expect(out).toContain("tests/__cassettes__/a/ok.json  unchanged");
    // Trailing failure block and totals call out the failure.
    expect(out).toContain("1 test failed");
    expect(out).toContain("✗ the bad one");
    expect(out).toContain("1 failed");
  });
});
