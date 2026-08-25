import { describe, expect, it } from "vitest";

import type { NockDefinition } from "../src/core/cassette.ts";
import {
  canonicalizeDefinitions,
  compileVolatileFields,
  makeVolatileBodyMatcher,
  OrdinalStore,
  parseRedactConfig,
  parseVolatileConfig,
  type VolatileField,
} from "../src/core/volatile.ts";

const FIELDS: VolatileField[] = parseVolatileConfig({ request: { body: ["attemptToken"] } });

describe("compileVolatileFields", () => {
  it("maps each directional config entry to its own field kind", () => {
    expect(
      parseVolatileConfig({
        request: { headers: ["x-request"], body: ["requestId"] },
        response: { headers: ["x-response"], body: ["responseId"] },
      }),
    ).toEqual([
      { kind: "header", path: "x-request", mode: "strict", source: "volatile" },
      { kind: "body", path: "requestId", mode: "strict", source: "volatile" },
      { kind: "response-header", path: "x-response", mode: "strict", source: "volatile" },
      { kind: "response", path: "responseId", mode: "strict", source: "volatile" },
    ]);
  });

  it("resolves overlaps once with redaction taking precedence", () => {
    const fields = compileVolatileFields(
      { request: { headers: [{ name: "authorization", match: "loose" }] } },
      undefined,
    );
    const authorization = fields.filter(
      (field) => field.kind === "header" && field.path === "authorization",
    );

    expect(authorization).toEqual([
      { kind: "header", path: "authorization", mode: "strict", source: "redact" },
    ]);
  });
});

function makeDef(token: string): NockDefinition {
  return {
    scope: "https://x.example.com",
    method: "POST",
    path: "/anything",
    body: { attemptToken: token, op: "charge" },
    status: 200,
    response: {},
  };
}

describe("canonicalizeDefinitions", () => {
  it("relabels [A, A, B] as ordinals [0, 0, 1]", () => {
    const defs = canonicalizeDefinitions([makeDef("A"), makeDef("A"), makeDef("B")], FIELDS);
    const bodies = defs.map((d) => (d.body as { attemptToken: string }).attemptToken);
    expect(bodies).toEqual([
      "<!volatile!body:attemptToken!0>",
      "<!volatile!body:attemptToken!0>",
      "<!volatile!body:attemptToken!1>",
    ]);
  });

  it("leaves non-volatile fields untouched", () => {
    const defs = canonicalizeDefinitions([makeDef("A")], FIELDS);
    expect((defs[0]!.body as { op: string }).op).toBe("charge");
  });

  it("rewrites a nested body field at any depth (GraphQL variables case)", () => {
    // The canonical reason to want nested-body rewriting: `variables.cartId` in
    // a GraphQL mutation. Marking `request.body: ["cartId"]` should match it.
    const fields = parseVolatileConfig({ request: { body: ["cartId"] } });
    const def: NockDefinition = {
      scope: "https://shop.example.com",
      method: "POST",
      path: "/graphql",
      body: { query: "mutation", variables: { cartId: "gid://Cart/abc", qty: 1 } },
      status: 200,
      response: {},
    };
    const [out] = canonicalizeDefinitions([def], fields);
    const body = out!.body as { query: string; variables: { cartId: string; qty: number } };
    expect(body.variables.cartId).toBe("<!volatile!body:cartId!0>");
    expect(body.variables.qty).toBe(1);
    expect(body.query).toBe("mutation");
  });

  it("rewrites volatile body fields inside JSON-in-a-string at depth", () => {
    const fields = parseVolatileConfig({ request: { body: ["cartId"] } });
    const def: NockDefinition = {
      scope: "https://shop.example.com",
      method: "POST",
      path: "/graphql",
      body: JSON.stringify({ variables: { cartId: "gid://Cart/abc" } }),
      status: 200,
      response: {},
    };
    const [out] = canonicalizeDefinitions([def], fields);
    expect(JSON.parse(out!.body as string)).toEqual({
      variables: { cartId: "<!volatile!body:cartId!0>" },
    });
  });

  it("relabels reused nested body values across requests with the same ordinal", () => {
    const fields = parseVolatileConfig({ request: { body: ["cartId"] } });
    const mk = (cartId: string): NockDefinition => ({
      scope: "https://shop.example.com",
      method: "POST",
      path: "/graphql",
      body: { variables: { cartId } },
      status: 200,
      response: {},
    });
    const defs = canonicalizeDefinitions([mk("A"), mk("A"), mk("B")], fields);
    const ords = defs.map((d) => (d.body as { variables: { cartId: string } }).variables.cartId);
    expect(ords).toEqual([
      "<!volatile!body:cartId!0>",
      "<!volatile!body:cartId!0>",
      "<!volatile!body:cartId!1>",
    ]);
  });

  it("handles string bodies by parsing/restringifying", () => {
    const defs = canonicalizeDefinitions(
      [{ ...makeDef("A"), body: JSON.stringify({ attemptToken: "A", op: "charge" }) }],
      FIELDS,
    );
    expect(defs[0]!.body).toBe(
      JSON.stringify({ attemptToken: "<!volatile!body:attemptToken!0>", op: "charge" }),
    );
  });
});

describe("canonicalizeDefinitions — response.body", () => {
  function defWithResponse(response: unknown): NockDefinition {
    return {
      scope: "https://x.example.com",
      method: "GET",
      path: "/uuid",
      status: 200,
      response,
    };
  }

  it("rewrites a top-level response field to a canonical token", () => {
    const fields = parseVolatileConfig({ response: { body: ["uuid"] } });
    const [def] = canonicalizeDefinitions(
      [defWithResponse({ uuid: "abc-123", other: "keep" })],
      fields,
    );
    const response = def!.response as { uuid: string; other: string };
    expect(response.uuid).toBe("<!volatile!response:uuid!0>");
    expect(response.other).toBe("keep");
  });

  it("walks nested response objects so echoed fields are caught", () => {
    // httpbin-style echo: the request body comes back under `response.json`.
    const fields = parseVolatileConfig({ response: { body: ["attemptToken"] } });
    const [def] = canonicalizeDefinitions(
      [defWithResponse({ json: { attemptToken: "abc", op: "charge" } })],
      fields,
    );
    const json = (def!.response as { json: { attemptToken: string; op: string } }).json;
    expect(json.attemptToken).toBe("<!volatile!response:attemptToken!0>");
    expect(json.op).toBe("charge");
  });

  it("rewrites volatile fields inside JSON-in-a-string (response.data)", () => {
    // httpbin's `response.data` is the request body, stringified. Without
    // parse/recurse/restringify, tokens would never land here.
    const fields = parseVolatileConfig({ response: { body: ["attemptToken"] } });
    const [def] = canonicalizeDefinitions(
      [defWithResponse({ data: JSON.stringify({ attemptToken: "abc", op: "charge" }) })],
      fields,
    );
    const data = (def!.response as { data: string }).data;
    expect(JSON.parse(data)).toEqual({
      attemptToken: "<!volatile!response:attemptToken!0>",
      op: "charge",
    });
  });

  it("relabels reused response values to the same ordinal across defs", () => {
    const fields = parseVolatileConfig({ response: { body: ["uuid"] } });
    const defs = canonicalizeDefinitions(
      [
        defWithResponse({ uuid: "A" }),
        defWithResponse({ uuid: "A" }),
        defWithResponse({ uuid: "B" }),
      ],
      fields,
    );
    const ords = defs.map((d) => (d.response as { uuid: string }).uuid);
    expect(ords).toEqual([
      "<!volatile!response:uuid!0>",
      "<!volatile!response:uuid!0>",
      "<!volatile!response:uuid!1>",
    ]);
  });

  it("leaves layer-1 placeholders alone", () => {
    const fields = parseVolatileConfig({ response: { body: ["uuid"] } });
    const [def] = canonicalizeDefinitions([defWithResponse({ uuid: "{{seeded}}" })], fields);
    expect((def!.response as { uuid: string }).uuid).toBe("{{seeded}}");
  });
});

describe("makeVolatileBodyMatcher", () => {
  it("keeps a known-secret placeholder equality-matched when its field is also redacted", () => {
    const fields = parseRedactConfig({ request: { body: ["cardNumber"] } });
    const matcher = makeVolatileBodyMatcher(
      { payment: { cardNumber: "{{card}}" } },
      fields,
      new OrdinalStore(),
    );

    expect(matcher({ payment: { cardNumber: "{{card}}" } })).toBe(true);
    expect(matcher({ payment: { cardNumber: "different" } })).toBe(false);
  });

  it("does not let loose mode wildcard a preserved equality value", () => {
    const fields = parseVolatileConfig({
      request: { body: [{ name: "nonce", match: "loose" }] },
    });
    const matcher = makeVolatileBodyMatcher(
      { nonce: "{{nonceSecret}}" },
      fields,
      new OrdinalStore(),
    );

    expect(matcher({ nonce: "{{nonceSecret}}" })).toBe(true);
    expect(matcher({ nonce: "anything-at-all" })).toBe(false);
  });

  it("rejects an ordinal token whose metadata does not match the configured body field", () => {
    const matcher = makeVolatileBodyMatcher(
      { attemptToken: "<!volatile!header:attemptToken!0>" },
      FIELDS,
      new OrdinalStore(),
    );

    expect(matcher({ attemptToken: "X" })).toBe(false);
  });

  it("matches a request whose actual value gets ordinal 0", () => {
    const expected = { attemptToken: "<!volatile!body:attemptToken!0>", op: "charge" };
    const store = new OrdinalStore();
    const matcher = makeVolatileBodyMatcher(expected, FIELDS, store);
    expect(matcher({ attemptToken: "anything", op: "charge" })).toBe(true);
    // Committed:
    expect(store.peek("body", "attemptToken", "anything")).toBe(0);
  });

  it("rejects when non-volatile field differs", () => {
    const expected = { attemptToken: "<!volatile!body:attemptToken!0>", op: "charge" };
    const matcher = makeVolatileBodyMatcher(expected, FIELDS, new OrdinalStore());
    expect(matcher({ attemptToken: "x", op: "different" })).toBe(false);
  });

  it("strict bijection: rejects new value where same-as-prior expected", () => {
    // Record [A, A]: ordinals [0, 0]. Replay [X, Y]: second matcher expects 0
    // but Y is new → would be 1 → bijection conflict → false.
    const store = new OrdinalStore();
    const m1 = makeVolatileBodyMatcher(
      { attemptToken: "<!volatile!body:attemptToken!0>", op: "charge" },
      FIELDS,
      store,
    );
    const m2 = makeVolatileBodyMatcher(
      { attemptToken: "<!volatile!body:attemptToken!0>", op: "charge" },
      FIELDS,
      store,
    );
    expect(m1({ attemptToken: "X", op: "charge" })).toBe(true);
    expect(m2({ attemptToken: "Y", op: "charge" })).toBe(false);
    // Reuse same X — that's what the recording said: works.
    expect(m2({ attemptToken: "X", op: "charge" })).toBe(true);
  });

  it("does not pollute the store on failed match", () => {
    const store = new OrdinalStore();
    const matcher = makeVolatileBodyMatcher(
      { attemptToken: "<!volatile!body:attemptToken!0>", op: "charge" },
      FIELDS,
      store,
    );
    // Fails because of `op` mismatch, but should not bind "X→0".
    expect(matcher({ attemptToken: "X", op: "refund" })).toBe(false);
    expect(store.peek("body", "attemptToken", "X")).toBeNull();
  });

  it("matches a nested volatile body field at depth", () => {
    const fields = parseVolatileConfig({ request: { body: ["cartId"] } });
    const expected = {
      query: "mutation",
      variables: { cartId: "<!volatile!body:cartId!0>", qty: 1 },
    };
    const store = new OrdinalStore();
    const matcher = makeVolatileBodyMatcher(expected, fields, store);
    expect(
      matcher({
        query: "mutation",
        variables: { cartId: "gid://Cart/xyz", qty: 1 },
      }),
    ).toBe(true);
    expect(store.peek("body", "cartId", "gid://Cart/xyz")).toBe(0);
  });

  it("rejects when nested non-volatile field differs", () => {
    const fields = parseVolatileConfig({ request: { body: ["cartId"] } });
    const expected = {
      variables: { cartId: "<!volatile!body:cartId!0>", qty: 1 },
    };
    const matcher = makeVolatileBodyMatcher(expected, fields, new OrdinalStore());
    expect(matcher({ variables: { cartId: "x", qty: 2 } })).toBe(false);
  });

  it("loose mode wildcards the value", () => {
    const looseFields = parseVolatileConfig({
      request: { body: [{ name: "nonce", match: "loose" }] },
    });
    const matcher = makeVolatileBodyMatcher(
      { nonce: "<!volatile!body:nonce!0>", op: "ping" },
      looseFields,
      new OrdinalStore(),
    );
    expect(matcher({ nonce: "anything-at-all", op: "ping" })).toBe(true);
    expect(matcher({ nonce: "other", op: "ping" })).toBe(true);
    expect(matcher({ nonce: 42, op: "ping" })).toBe(false);
  });
});
