import { expect } from "vitest";

import { defineVcr } from "../../src/vitest.ts";

/**
 * Dev-loop config that talks to httpbin.org. A plain async provider stands
 * in for a real cloud secret — the value is an obvious test string so `bside
 * record` runs offline-friendly and the cassette is reproducible without any
 * out-of-band setup.
 *
 * Three things this exercises:
 *
 *  - **Secret-aware redaction.** `apiKey` is sent as `x-api-key`; the
 *    cassette must store `{{apiKey}}` (literal value scrubbed) and replay must
 *    match because `secrets.apiKey` resolves to the same placeholder.
 *  - **Per-field redact.** A POST body carries a `cardNumber` field
 *    that's in `redact.request.body`; the cassette stores a canonical token and
 *    matching is normalized, so the replay can re-send the real PII without
 *    failing equality.
 *  - **Stateful volatile matching.** httpbin's `/uuid` returns a fresh
 *    UUID every call; the test sends a body field whose reuse pattern across
 *    a few requests must survive re-record (relabeling, not erasure).
 */
const vcr = defineVcr({
  secrets: {
    apiKey: async () => "sk_test_fakeapikey1234567890abcdef",
  },
  redact: {
    request: { body: ["cardNumber"] },
    response: { body: ["origin"] },
  },
  volatile: {
    request: {
      body: ["attemptToken"],
      headers: [{ name: "x-request-id", match: "loose" }],
    },
  },
});

const BASE = "https://httpbin.org";

/**
 * httpbin echoes back what you sent — perfect for round-tripping secret /
 * redact / volatile handling: send a known value, read it back, assert the
 * value was handled the way the design says it should be.
 */

vcr("GET /headers echoes the api key, cassette redacts it", async ({ secrets }) => {
  const res = await fetch(`${BASE}/headers`, {
    headers: { "x-api-key": secrets.apiKey },
  });
  expect(res.status).toBe(200);

  const body = (await res.json()) as { headers: Record<string, string> };
  // httpbin uppercases header keys.
  expect(body.headers["X-Api-Key"]).toBe(secrets.apiKey);
});

vcr("POST /anything redacts a body field", async ({ secrets }) => {
  const res = await fetch(`${BASE}/anything`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": secrets.apiKey,
    },
    body: JSON.stringify({
      cardNumber: "4242424242424242",
      amount: 100,
    }),
  });
  expect(res.status).toBe(200);

  const body = (await res.json()) as { json: { cardNumber: string; amount: number } };
  // The test re-sends the real PII; redact is match-normalized so this still
  // matches the cassette on replay.
  expect(body.json.cardNumber).toBe("4242424242424242");
  expect(body.json.amount).toBe(100);
});

vcr("POST /anything with rotating attemptToken — strict volatile", async ({ secrets }) => {
  const headers = {
    "content-type": "application/json",
    "x-api-key": secrets.apiKey,
  };

  // Reuse the same token across two calls, then rotate. Replay must see the
  // same reuse pattern [A, A, B] or fail loudly.
  const tokenA = crypto.randomUUID();
  const tokenB = crypto.randomUUID();

  for (const token of [tokenA, tokenA, tokenB]) {
    const res = await fetch(`${BASE}/anything`, {
      method: "POST",
      headers,
      body: JSON.stringify({ attemptToken: token, op: "charge" }),
    });
    expect(res.status).toBe(200);
  }
});

vcr("GET /uuid x3 — distinct responses make the cassette deterministic", async ({ secrets }) => {
  const headers = { "x-api-key": secrets.apiKey };
  const ids = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${BASE}/uuid`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uuid: string };
    ids.add(body.uuid);
  }
  expect(ids.size).toBe(3);
});

vcr("onCleanup runs only in record mode", async ({ secrets, onCleanup }) => {
  onCleanup(() => {
    // In record mode this would tear down a real resource; in
    // replay the callback never runs.
  });

  const res = await fetch(`${BASE}/status/200`, {
    headers: { "x-api-key": secrets.apiKey },
  });
  expect(res.status).toBe(200);
});
