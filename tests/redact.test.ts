import { describe, expect, it } from "vitest";

import type { NockDefinition, NockRawHeaders } from "../src/core/cassette.ts";
import { scrubDefinitions } from "../src/core/redact.ts";
import {
  BUILT_IN_REDACT_HEADERS,
  canonicalizeDefinitions,
  parseRedactConfig,
  parseVolatileToken,
} from "../src/core/volatile.ts";

function makeDef(reqheaders: Record<string, string>, body?: unknown): NockDefinition {
  return {
    scope: "https://api.example.com",
    method: "POST",
    path: "/charge",
    status: 200,
    response: {},
    reqheaders,
    ...(body !== undefined ? { body } : {}),
  };
}

describe("parseRedactConfig", () => {
  it("includes every built-in header automatically", () => {
    const fields = parseRedactConfig(undefined);
    const names = fields.filter((f) => f.kind === "header").map((f) => f.path);
    for (const builtin of BUILT_IN_REDACT_HEADERS) {
      expect(names).toContain(builtin);
    }
  });

  it("extends, does not duplicate, the built-in list", () => {
    const fields = parseRedactConfig({
      request: { headers: ["AUTHORIZATION", "x-tenant-token"] },
    });
    const headerFields = fields.filter((f) => f.kind === "header");
    const auth = headerFields.filter((f) => f.path === "authorization");
    expect(auth).toHaveLength(1);
    expect(headerFields.some((f) => f.path === "x-tenant-token")).toBe(true);
    expect(fields.some((f) => f.kind === "response-header" && f.path === "x-tenant-token")).toBe(
      false,
    );
  });

  it("marks redact fields with source: 'redact'", () => {
    const fields = parseRedactConfig({ request: { body: ["cardNumber"] } });
    const card = fields.find((f) => f.path === "cardNumber");
    expect(card?.source).toBe("redact");
  });
});

describe("canonicalize via redact source", () => {
  it("rewrites authorization header value to a redact-prefixed token", () => {
    const defs = canonicalizeDefinitions(
      [makeDef({ authorization: "Bearer super-secret-jwt-1234" })],
      parseRedactConfig(undefined),
    );
    const value = defs[0]!.reqheaders!.authorization as string;
    const tok = parseVolatileToken(value);
    expect(tok).not.toBeNull();
    expect(tok?.source).toBe("redact");
    expect(tok?.kind).toBe("header");
    expect(tok?.path).toBe("authorization");
  });

  it("relabels reused values to the same ordinal across requests", () => {
    const defs = canonicalizeDefinitions(
      [
        makeDef({ authorization: "Bearer same" }),
        makeDef({ authorization: "Bearer same" }),
        makeDef({ authorization: "Bearer different" }),
      ],
      parseRedactConfig(undefined),
    );
    const ords = defs.map(
      (d) => parseVolatileToken((d.reqheaders as Record<string, string>).authorization)?.ord,
    );
    expect(ords).toEqual([0, 0, 1]);
  });

  it("skips layer-1 placeholders so plain-equality matching survives", () => {
    // Simulates: scrub already ran, x-api-key value is now `{{apiKey}}`.
    // Redact pass should NOT relabel it — the placeholder is non-secret and
    // we want plain-equality matching on replay.
    const defs = canonicalizeDefinitions(
      [makeDef({ "x-api-key": "{{apiKey}}" })],
      parseRedactConfig(undefined),
    );
    expect((defs[0]!.reqheaders as Record<string, string>)["x-api-key"]).toBe("{{apiKey}}");
  });

  it("redacts user-configured body fields", () => {
    const defs = canonicalizeDefinitions(
      [
        makeDef(
          { "content-type": "application/json" },
          { cardNumber: "4242424242424242", amount: 100 },
        ),
      ],
      parseRedactConfig({ request: { body: ["cardNumber"] } }),
    );
    const body = defs[0]!.body as { cardNumber: string; amount: number };
    expect(body.cardNumber).not.toContain("4242");
    expect(parseVolatileToken(body.cardNumber)?.source).toBe("redact");
    expect(body.amount).toBe(100);
  });

  it("redacts a body field at any depth (PII nested under a payment object)", () => {
    const defs = canonicalizeDefinitions(
      [
        makeDef(
          { "content-type": "application/json" },
          { payment: { card: { cardNumber: "4242424242424242", cvc: "123" } } },
        ),
      ],
      parseRedactConfig({ request: { body: ["cardNumber"] } }),
    );
    const card = (defs[0]!.body as { payment: { card: { cardNumber: string; cvc: string } } })
      .payment.card;
    expect(card.cardNumber).not.toContain("4242");
    expect(parseVolatileToken(card.cardNumber)?.source).toBe("redact");
    expect(card.cvc).toBe("123");
  });

  it("applies a configured response body field only to the response", () => {
    const def: NockDefinition = {
      ...makeDef({}, { accessToken: "request-value" }),
      response: { accessToken: "response-secret" },
    };
    const [out] = canonicalizeDefinitions(
      [def],
      parseRedactConfig({ response: { body: ["accessToken"] } }),
    );

    expect((out!.body as { accessToken: string }).accessToken).toBe("request-value");
    const responseToken = (out!.response as { accessToken: string }).accessToken;
    expect(parseVolatileToken(responseToken)).toMatchObject({
      source: "redact",
      kind: "response",
      path: "accessToken",
    });
  });
});

describe("response-side header deny-list", () => {
  it("tokenizes set-cookie in rawHeaders (Record form, multi-value array)", () => {
    const def: NockDefinition = {
      scope: "https://api.example.com",
      path: "/login",
      status: 200,
      response: { ok: true },
      rawHeaders: {
        "content-type": "application/json",
        "set-cookie": ["session=abc123def456; Path=/", "csrf=zzz; Path=/; HttpOnly"],
      },
    };
    const out = canonicalizeDefinitions([def], parseRedactConfig(undefined));
    const raw = out[0]!.rawHeaders as NockRawHeaders;
    const cookies = raw["set-cookie"] as string[];
    expect(cookies).toHaveLength(2);
    for (const c of cookies) {
      expect(c).not.toContain("session=abc");
      expect(c).not.toContain("csrf=zzz");
      expect(parseVolatileToken(c)?.source).toBe("redact");
      expect(parseVolatileToken(c)?.path).toBe("set-cookie");
    }
    expect(raw["content-type"]).toBe("application/json");
  });

  it("tokenizes authorization echoed in response.headers (httpbin-style)", () => {
    const def: NockDefinition = {
      scope: "https://httpbin.example.com",
      path: "/anything",
      status: 200,
      response: {
        method: "GET",
        headers: {
          Accept: "*/*",
          Authorization: "Bearer the-actual-jwt",
        },
      },
    };
    const out = canonicalizeDefinitions([def], parseRedactConfig(undefined));
    const headers = (out[0]!.response as { headers: Record<string, string> }).headers;
    expect(headers.Accept).toBe("*/*");
    expect(headers.Authorization).not.toContain("the-actual-jwt");
    expect(parseVolatileToken(headers.Authorization)?.path).toBe("authorization");
  });

  it("applies a user-configured response header only to the response side", () => {
    const def: NockDefinition = {
      scope: "https://api.example.com",
      path: "/whoami",
      status: 200,
      response: { ok: true },
      reqheaders: { "x-tenant-token": "request-value" },
      rawHeaders: { "x-tenant-token": "tnt_live_super_secret" },
    };
    const out = canonicalizeDefinitions(
      [def],
      parseRedactConfig({ response: { headers: ["x-tenant-token"] } }),
    );
    const raw = out[0]!.rawHeaders as NockRawHeaders;
    expect(raw["x-tenant-token"]).not.toContain("super_secret");
    expect(parseVolatileToken(raw["x-tenant-token"])?.path).toBe("x-tenant-token");
    expect(out[0]!.reqheaders?.["x-tenant-token"]).toBe("request-value");
  });

  it("uses a separate ordinal namespace from request headers (no crosstalk)", () => {
    // Same value on req + res should NOT share an ordinal — different
    // occurrences, different namespaces. Just check both ends got tokenized.
    const def: NockDefinition = {
      scope: "https://api.example.com",
      method: "GET",
      path: "/echo",
      status: 200,
      response: {},
      reqheaders: { authorization: "Bearer same-token" },
      rawHeaders: { authorization: "Bearer same-token" },
    };
    const out = canonicalizeDefinitions([def], parseRedactConfig(undefined));
    const reqAuth = (out[0]!.reqheaders as Record<string, string>).authorization;
    const resAuth = (out[0]!.rawHeaders as NockRawHeaders).authorization;
    expect(parseVolatileToken(reqAuth)?.kind).toBe("header");
    expect(parseVolatileToken(resAuth)?.kind).toBe("response-header");
  });
});

describe("scrub-then-canonicalize ordering", () => {
  it("preserves layer-1 placeholder in a deny-list header", () => {
    const real = "sk_live_secret_xyz";
    const defs: NockDefinition[] = [makeDef({ "x-api-key": real })];
    const { defs: scrubbed } = scrubDefinitions(defs, [{ real, canonical: "{{apiKey}}" }]);
    const canonicalized = canonicalizeDefinitions(scrubbed, parseRedactConfig(undefined));
    const header = (canonicalized[0]!.reqheaders as Record<string, string>)["x-api-key"];
    expect(header).toBe("{{apiKey}}");
  });
});
