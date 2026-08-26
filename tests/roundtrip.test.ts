import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NockDefinition, NockRawHeaders } from "../src/core/cassette.ts";
import { BUILT_IN_IGNORED_HEADERS, scrubDefinitions } from "../src/core/redact.ts";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vcrkit-rt-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("scrubDefinitions", () => {
  const apiKey = "sk_live_super_secret_value_zzz";

  it("omits every built-in noisy header from requests and responses", () => {
    const noisyHeaders = Object.fromEntries(
      BUILT_IN_IGNORED_HEADERS.map((name) => [name.toUpperCase(), `noise:${name}`]),
    );
    const defs: NockDefinition[] = [
      {
        scope: "https://api.example.com",
        path: "/",
        reqheaders: { ...noisyHeaders, "x-keep": "request" },
        rawHeaders: { ...noisyHeaders, "x-keep": "response" },
        response: { headers: { ...noisyHeaders, "x-keep": "echo" } },
      },
    ];

    const { defs: out } = scrubDefinitions(defs, []);
    expect(out[0]?.reqheaders).toEqual({ "x-keep": "request" });
    expect(out[0]?.rawHeaders).toEqual({ "x-keep": "response" });
    expect(out[0]?.response).toEqual({ headers: { "x-keep": "echo" } });
  });

  it("substitutes secret values with their canonical replay form", () => {
    const defs: NockDefinition[] = [
      {
        scope: "https://api.example.com",
        method: "POST",
        path: "/v1/charges",
        body: { token: apiKey, note: `auth=${apiKey}` },
        status: 200,
        response: { received: apiKey },
        reqheaders: { "x-api-key": apiKey, "x-keep": "fine" },
      },
    ];
    const { defs: out, matches } = scrubDefinitions(defs, [
      { real: apiKey, canonical: "{{apiKey}}" },
    ]);
    const json = JSON.stringify(out);
    expect(json).not.toContain(apiKey);
    expect(json).toContain("{{apiKey}}");
    // Header survives; the value got swapped.
    expect((out[0]!.reqheaders as Record<string, string>)["x-api-key"]).toBe("{{apiKey}}");
    expect((out[0]!.reqheaders as Record<string, string>)["x-keep"]).toBe("fine");
    // Body (token + note=auth=...), response, and header all matched.
    expect(matches).toBeGreaterThan(0);
  });

  it("strips ignored request headers", () => {
    const defs: NockDefinition[] = [
      {
        scope: "https://api.example.com",
        path: "/",
        reqheaders: {
          "user-agent": "Node",
          "content-length": "0",
          host: "api.example.com",
          date: "Wed, 01 Jan 2020 00:00:00 GMT",
          "x-keep": "ok",
        },
      },
    ];
    const { defs: out, matches } = scrubDefinitions(defs, []);
    const headers = out[0]!.reqheaders as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["x-keep"]);
    expect(matches).toBe(0);
  });

  it("strips configured headers from requests and responses case-insensitively", () => {
    const defs: NockDefinition[] = [
      {
        scope: "https://shop.example.com",
        path: "/",
        reqheaders: {
          "X-Request-Noise": "request-noise",
          "x-shopify-complexity-score": "kept-on-request",
          "x-keep": "request",
        },
        rawHeaders: {
          "x-shopify-complexity-score": "response-noise",
          "x-request-noise": "kept-on-response",
          "x-keep": "response",
        },
        response: {
          headers: {
            "X-SHOPIFY-COMPLEXITY-SCORE": "echo-noise",
            "x-keep": "echo",
          },
        },
      },
    ];

    const { defs: out } = scrubDefinitions(defs, [], {
      request: { headers: ["x-request-noise"] },
      response: { headers: ["x-shopify-complexity-score"] },
    });
    expect(out[0]?.reqheaders).toEqual({
      "x-shopify-complexity-score": "kept-on-request",
      "x-keep": "request",
    });
    expect(out[0]?.rawHeaders).toEqual({
      "x-request-noise": "kept-on-response",
      "x-keep": "response",
    });
    expect(out[0]?.response).toEqual({ headers: { "x-keep": "echo" } });
  });

  it("strips noisy response headers from rawHeaders (Record form)", () => {
    const defs: NockDefinition[] = [
      {
        scope: "https://api.example.com",
        path: "/",
        rawHeaders: {
          "content-type": "application/json",
          date: "Sun, 31 May 2026 05:00:30 GMT",
          server: "gunicorn/19.9.0",
          "x-amzn-trace-id": "Root=1-abc",
          "cf-ray": "9z9z",
          "x-rate-limit-remaining": "99",
        },
      },
    ];
    const { defs: out } = scrubDefinitions(defs, []);
    const stripped = out[0]!.rawHeaders as NockRawHeaders;
    expect(Object.keys(stripped).sort()).toEqual(["content-type", "x-rate-limit-remaining"]);
  });

  it("strips ignored headers from response.headers (echo-style APIs)", () => {
    const defs: NockDefinition[] = [
      {
        scope: "https://httpbin.example.com",
        path: "/anything",
        response: {
          method: "GET",
          // Different casing on purpose — match is case-insensitive.
          headers: {
            Accept: "*/*",
            Date: "Sun, 31 May 2026 05:00:30 GMT",
            "X-Amzn-Trace-Id": "Root=1-abc",
            "X-Tenant": "rye",
          },
        },
      },
    ];
    const { defs: out } = scrubDefinitions(defs, []);
    const response = out[0]!.response as { headers: Record<string, string> };
    expect(Object.keys(response.headers).sort()).toEqual(["Accept", "X-Tenant"]);
  });

  it("leaves response.headers untouched when response isn't a plain object", () => {
    const defs: NockDefinition[] = [
      { scope: "https://api.example.com", path: "/", response: "raw string body" },
    ];
    const { defs: out } = scrubDefinitions(defs, []);
    expect(out[0]!.response).toBe("raw string body");
  });

  it("scrubs secrets containing JSON-special characters", () => {
    // Bug: the serialize-then-string-replace approach looks for `real` in the
    // JSON-encoded text, but the JSON encoding has escaped the secret's `"`
    // and `\`. Raw `real` doesn't match the encoded form, so the secret leaks.
    const secret = 'p@ss"word\\zz';
    const defs: NockDefinition[] = [
      {
        scope: "https://api.example.com",
        method: "POST",
        path: "/",
        body: { password: secret },
        reqheaders: { "x-secret": secret },
      },
    ];
    const { defs: out } = scrubDefinitions(defs, [{ real: secret, canonical: "{{secret}}" }]);
    const body = out[0]!.body as { password: string };
    const headers = out[0]!.reqheaders as Record<string, string>;
    expect(body.password).toBe("{{secret}}");
    expect(headers["x-secret"]).toBe("{{secret}}");
    // Belt-and-suspenders: no fragment of the secret survives anywhere.
    expect(JSON.stringify(out)).not.toContain("p@ss");
  });

  it("doesn't corrupt unrelated values that contain the secret as a substring", () => {
    // Bug: substring substitution on the serialized JSON rewrites any
    // coincidental occurrence of `real`. Registering "test" as a secret
    // turns the unrelated value "testing 123" into "{{secret}}ing 123".
    const defs: NockDefinition[] = [
      {
        scope: "https://api.example.com",
        method: "POST",
        path: "/",
        body: { greeting: "testing 123", token: "test" },
      },
    ];
    const { defs: out } = scrubDefinitions(defs, [{ real: "test", canonical: "{{secret}}" }]);
    const body = out[0]!.body as { greeting: string; token: string };
    expect(body.token).toBe("{{secret}}");
    expect(body.greeting).toBe("testing 123");
  });

  it("scrubs short secrets at token boundaries without corrupting larger words", () => {
    const defs: NockDefinition[] = [
      {
        scope: "https://api.example.com",
        method: "POST",
        path: "/verify?pin=12",
        body: {
          exact: "12",
          embedded: "pin=12; retry=false",
          adjacentDigits: "3124",
          adjacentLetters: "x12y",
        },
        reqheaders: { authorization: "Bearer 12" },
      },
    ];

    const { defs: out, matches } = scrubDefinitions(defs, [{ real: "12", canonical: "{{pin}}" }]);
    const body = out[0]!.body as Record<string, string>;
    expect(out[0]!.path).toBe("/verify?pin={{pin}}");
    expect(out[0]!.reqheaders?.authorization).toBe("Bearer {{pin}}");
    expect(body).toEqual({
      exact: "{{pin}}",
      embedded: "pin={{pin}}; retry=false",
      adjacentDigits: "3124",
      adjacentLetters: "x12y",
    });
    expect(matches).toBe(4);
  });

  it("still rewrites a secret embedded inside a larger string value", () => {
    // The fix shouldn't break the legitimate embedded-in-string case: a
    // secret that lives in a URL path or `auth=...` blob must still be
    // scrubbed. Word-boundary context distinguishes these from #3.
    const secret = "sk_live_super_secret_value_zzz";
    const defs: NockDefinition[] = [
      {
        scope: "https://api.example.com",
        method: "POST",
        path: `/v1/keys/${secret}/rotate`,
        body: { note: `auth=${secret}; ttl=60` },
      },
    ];
    const { defs: out } = scrubDefinitions(defs, [{ real: secret, canonical: "{{apiKey}}" }]);
    const body = out[0]!.body as { note: string };
    expect(out[0]!.path).toBe("/v1/keys/{{apiKey}}/rotate");
    expect(body.note).toBe("auth={{apiKey}}; ttl=60");
  });

  it("applies longer rules first so prefix collisions don't half-substitute", () => {
    const defs: NockDefinition[] = [
      {
        scope: "https://x",
        path: "/",
        body: { a: "alpha-bravo", b: "alpha" },
      },
    ];
    const { defs: out } = scrubDefinitions(defs, [
      { real: "alpha", canonical: "{{short}}" },
      { real: "alpha-bravo", canonical: "{{long}}" },
    ]);
    const body = out[0]!.body as { a: string; b: string };
    expect(body.a).toBe("{{long}}");
    expect(body.b).toBe("{{short}}");
  });

  it("does not scrub one rule's canonical replacement with another rule", () => {
    const defs: NockDefinition[] = [
      {
        scope: "https://x",
        path: "/",
        body: { first: "alpha", second: "beta" },
      },
    ];
    const { defs: out, matches } = scrubDefinitions(defs, [
      { real: "alpha", canonical: "beta" },
      { real: "beta", canonical: "gamma" },
    ]);
    const body = out[0]!.body as { first: string; second: string };
    expect(body).toEqual({ first: "beta", second: "gamma" });
    expect(matches).toBe(2);
  });
});
