import { describe, expect, it } from "vitest";

import type { NockDefinition } from "../src/core/cassette.ts";
import {
  type ActualRequest,
  type ClosestMatch,
  diagnoseMismatch,
  type FieldDiff,
  formatMismatch,
  type MismatchReport,
} from "../src/core/mismatch.ts";

function diagnose(candidates: NockDefinition[], request: ActualRequest): MismatchReport {
  return diagnoseMismatch({
    cassetteName: "happy-path",
    cassettePath: "/repo/tests/__cassettes__/foo/happy-path.json",
    testName: "completes the happy path",
    candidates,
    request,
  });
}

const SHOPIFY_URL = "https://rye-test-store.myshopify.com/api/2025-01/graphql.json";

function shopifyDef(cartId: string): NockDefinition {
  return {
    scope: "https://rye-test-store.myshopify.com",
    method: "POST",
    path: "/api/2025-01/graphql.json",
    body: { query: "mutation Foo", variables: { cartId } },
    status: 200,
    response: {},
  };
}

describe("diagnoseMismatch — closest pick", () => {
  it("returns null when there are no candidates", () => {
    const report = diagnose([], {
      method: "GET",
      url: "https://x.example.com/",
      body: undefined,
    });
    expect(report.closest).toBeNull();
  });

  it("prefers same-method + same-path over either alone", () => {
    const candidates: NockDefinition[] = [
      { scope: "https://x.example.com", method: "GET", path: "/a", status: 200, response: {} },
      { scope: "https://x.example.com", method: "POST", path: "/b", status: 200, response: {} },
      { scope: "https://x.example.com", method: "POST", path: "/a", status: 200, response: {} },
    ];
    const report = diagnose(candidates, {
      method: "POST",
      url: "https://x.example.com/a",
      body: undefined,
    });
    expect(report.closest?.cassetteIndex).toBe(3);
    expect(report.closest?.similarity).toBe("same-method-and-path");
  });

  it("falls back to same-path when method differs", () => {
    const candidates: NockDefinition[] = [
      { scope: "https://x.example.com", method: "GET", path: "/items", status: 200, response: {} },
    ];
    const report = diagnose(candidates, {
      method: "POST",
      url: "https://x.example.com/items",
      body: undefined,
    });
    expect(report.closest?.similarity).toBe("same-path");
    expect(report.closest?.differences).toContainEqual<FieldDiff>({
      kind: "method",
      recorded: "GET",
      actual: "POST",
    });
  });

  it("tie-breaks within a tier by smaller body diff", () => {
    // Two same-method-same-path candidates; the second has a closer body.
    const candidates: NockDefinition[] = [
      shopifyDef("zzz"), // far
      shopifyDef("gid://shopify/Cart/def456"), // exactly the actual value
    ];
    const report = diagnose(candidates, {
      method: "POST",
      url: SHOPIFY_URL,
      body: { query: "mutation Foo", variables: { cartId: "gid://shopify/Cart/def456" } },
    });
    expect(report.closest?.cassetteIndex).toBe(2);
    expect(report.closest?.differences).toHaveLength(0);
  });
});

describe("diagnoseMismatch — body diff walking", () => {
  it("surfaces a nested body field difference with dotted path", () => {
    const candidates: NockDefinition[] = [shopifyDef("gid://shopify/Cart/abc123")];
    const report = diagnose(candidates, {
      method: "POST",
      url: SHOPIFY_URL,
      body: { query: "mutation Foo", variables: { cartId: "gid://shopify/Cart/def456" } },
    });
    expect(report.closest?.differences).toEqual<FieldDiff[]>([
      {
        kind: "body",
        path: "variables.cartId",
        recorded: "gid://shopify/Cart/abc123",
        actual: "gid://shopify/Cart/def456",
        hint: "looks-like-id",
      },
    ]);
  });

  it("ignores a field whose recorded value is a volatile canonical token", () => {
    const def: NockDefinition = {
      ...shopifyDef("ignored"),
      body: { variables: { cartId: "<!volatile!body:cartId!0>" } },
    };
    const report = diagnose([def], {
      method: "POST",
      url: SHOPIFY_URL,
      body: { variables: { cartId: "gid://shopify/Cart/whatever" } },
    });
    expect(report.closest?.differences).toEqual([]);
  });

  it("reports a field whose equality-matched {{secret}} placeholder differs", () => {
    const def: NockDefinition = {
      ...shopifyDef("ignored"),
      body: { variables: { token: "{{shopifyToken}}" } },
    };
    const report = diagnose([def], {
      method: "POST",
      url: SHOPIFY_URL,
      body: { variables: { token: "real-token-xyz" } },
    });
    expect(report.closest?.differences).toEqual<FieldDiff[]>([
      {
        kind: "body",
        path: "variables.token",
        recorded: "{{shopifyToken}}",
        actual: "real-token-xyz",
      },
    ]);
  });

  it("handles a recorded body that's a JSON string", () => {
    const def: NockDefinition = {
      ...shopifyDef("ignored"),
      body: JSON.stringify({ variables: { cartId: "A" } }),
    };
    const report = diagnose([def], {
      method: "POST",
      url: SHOPIFY_URL,
      body: { variables: { cartId: "B" } },
    });
    expect(report.closest?.differences).toEqual<FieldDiff[]>([
      {
        kind: "body",
        path: "variables.cartId",
        recorded: "A",
        actual: "B",
      },
    ]);
  });

  it("detects an ISO timestamp hint", () => {
    const candidates: NockDefinition[] = [
      {
        ...shopifyDef("ignored"),
        body: { createdAt: "2024-01-02T03:04:05Z" },
      },
    ];
    const report = diagnose(candidates, {
      method: "POST",
      url: SHOPIFY_URL,
      body: { createdAt: "2025-05-31T12:00:00Z" },
    });
    const diff = report.closest?.differences[0];
    expect(diff).toMatchObject({ kind: "body", hint: "looks-like-timestamp" });
  });

  it("flags missing/extra fields as shape diffs", () => {
    const candidates: NockDefinition[] = [{ ...shopifyDef("x"), body: { keep: 1, removed: 2 } }];
    const report = diagnose(candidates, {
      method: "POST",
      url: SHOPIFY_URL,
      body: { keep: 1, added: 3 },
    });
    const reasons = report.closest?.differences.map((d) =>
      d.kind === "body-shape" ? d.reason : d.kind,
    );
    expect(reasons).toEqual(expect.arrayContaining(["missing-in-actual", "missing-in-recorded"]));
  });
});

describe("diagnoseMismatch — query diff", () => {
  it("surfaces a per-parameter query difference instead of going silent", () => {
    const def: NockDefinition = {
      scope: "https://api.example.com",
      method: "GET",
      path: "/items?page=1&limit=20",
      status: 200,
      response: {},
    };
    const report = diagnose([def], {
      method: "GET",
      url: "https://api.example.com/items?page=2&limit=20",
      body: undefined,
    });
    // Used to be empty — the path stripped of query matched, so no diff fired.
    expect(report.closest?.differences).toContainEqual<FieldDiff>({
      kind: "query",
      name: "page",
      recorded: "1",
      actual: "2",
    });
  });

  it("flags a query param that's missing in the actual request", () => {
    const def: NockDefinition = {
      scope: "https://api.example.com",
      method: "GET",
      path: "/items?page=1&limit=20",
      status: 200,
      response: {},
    };
    const report = diagnose([def], {
      method: "GET",
      url: "https://api.example.com/items?page=1",
      body: undefined,
    });
    expect(report.closest?.differences).toContainEqual<FieldDiff>({
      kind: "query",
      name: "limit",
      recorded: "20",
      actual: undefined,
    });
  });

  it("flags a query param that's extra on the actual request", () => {
    const def: NockDefinition = {
      scope: "https://api.example.com",
      method: "GET",
      path: "/items?page=1",
      status: 200,
      response: {},
    };
    const report = diagnose([def], {
      method: "GET",
      url: "https://api.example.com/items?page=1&debug=1",
      body: undefined,
    });
    expect(report.closest?.differences).toContainEqual<FieldDiff>({
      kind: "query",
      name: "debug",
      recorded: undefined,
      actual: "1",
    });
  });
});

describe("diagnoseMismatch — header diff", () => {
  it("reports equality-placeholder differences and skips ordinal-token headers", () => {
    const def: NockDefinition = {
      ...shopifyDef("x"),
      reqheaders: {
        "x-shop-id": "shop-1",
        authorization: "{{shopifyToken}}",
        "x-request-id": "<!volatile!header:x-request-id!0>",
      },
    };
    const report = diagnose([def], {
      method: "POST",
      url: SHOPIFY_URL,
      body: def.body,
      headers: {
        "x-shop-id": "shop-2",
        authorization: "real-token",
        "x-request-id": "request-123",
      },
    });
    expect(report.closest?.differences).toEqual<FieldDiff[]>([
      {
        kind: "header",
        name: "x-shop-id",
        recorded: "shop-1",
        actual: "shop-2",
      },
      {
        kind: "header",
        name: "authorization",
        recorded: "{{shopifyToken}}",
        actual: "real-token",
      },
    ]);
  });
});

describe("formatMismatch", () => {
  it("renders the canonical mismatch example", () => {
    const candidates: NockDefinition[] = [shopifyDef("gid://shopify/Cart/abc123")];
    const report = diagnose(candidates, {
      method: "POST",
      url: SHOPIFY_URL,
      body: { query: "mutation Foo", variables: { cartId: "gid://shopify/Cart/def456" } },
      index: 4,
    });

    const out = formatMismatch(report);
    expect(out).toContain(`✗ cassette "happy-path" — no recorded match for request #4`);
    expect(out).toContain(`POST ${SHOPIFY_URL}`);
    expect(out).toContain(`Closest recording (#1, same path) differs`);
    expect(out).toContain(`variables.cartId`);
    expect(out).toContain(`recorded  "gid://shopify/Cart/abc123"`);
    expect(out).toContain(
      `actual    "gid://shopify/Cart/def456"   ← looks like an id; mark volatile?`,
    );
    expect(out).toContain(`Fix: add 'cartId' to volatile.request.body, or re-record:`);
    expect(out).toContain(`rm "/repo/tests/__cassettes__/foo/happy-path.json" && bside record`);
  });

  it("handles the no-candidates case", () => {
    const report = diagnose([], {
      method: "GET",
      url: "https://x.example.com/missing",
      body: undefined,
    });
    const out = formatMismatch(report);
    expect(out).toContain(`Cassette has no recordings to compare against.`);
    expect(out).toContain(`rm "/repo/tests/__cassettes__/foo/happy-path.json" && bside record`);
  });

  it("omits the request-index suffix when none is provided", () => {
    const report = diagnose([shopifyDef("x")], {
      method: "POST",
      url: SHOPIFY_URL,
      body: shopifyDef("x").body,
    });
    const out = formatMismatch(report);
    expect(out).toMatch(/no recorded match\n/);
  });

  it("uses a generic Fix line when no hint is present", () => {
    const def: NockDefinition = { ...shopifyDef("x"), body: { op: "charge" } };
    const report = diagnose([def], {
      method: "POST",
      url: SHOPIFY_URL,
      body: { op: "refund" },
    });
    const out = formatMismatch(report);
    expect(out).toContain(`Fix: update the test to match the recording, or re-record:`);
  });
});

describe("ClosestMatch shape", () => {
  it("is a structured value the formatter only reads (no hidden state)", () => {
    const candidates: NockDefinition[] = [shopifyDef("a"), shopifyDef("b")];
    const report = diagnose(candidates, {
      method: "POST",
      url: SHOPIFY_URL,
      body: { query: "mutation Foo", variables: { cartId: "b" } },
    });
    const closest: ClosestMatch | null = report.closest;
    expect(closest).not.toBeNull();
    expect(JSON.parse(JSON.stringify(closest))).toEqual(closest);
  });
});
