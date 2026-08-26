import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { replayCassette } from "../src/core/runner.ts";
import { parseRedactConfig, parseVolatileConfig } from "../src/core/volatile.ts";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vcrkit-hdr-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const cassette = (definitions: unknown[]): string => {
  const path = join(tmpDir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, definitions }));
  return path;
};

describe("redact header replay", () => {
  it("accepts any value for a deny-list header on replay", async () => {
    const path = cassette([
      {
        scope: "https://api.example.com",
        method: "GET",
        path: "/",
        status: 200,
        response: { ok: true },
        reqheaders: { authorization: "<!redact!header:authorization!0>" },
      },
    ]);

    await replayCassette(
      path,
      parseRedactConfig(undefined),
      async () => {
        const res = await fetch("https://api.example.com/", {
          headers: { authorization: "Bearer literally-anything" },
        });
        expect(res.status).toBe(200);
      },
      { testName: "authorization deny-list" },
    );
  });
});

describe("volatile header replay", () => {
  const fields = parseVolatileConfig({ request: { headers: ["x-idempotency-key"] } });

  it("matches reused values to the same ordinal across requests", async () => {
    const path = cassette([
      // Recorded [B, B, C] → tokens [0, 0, 1]
      {
        scope: "https://api.example.com",
        method: "POST",
        path: "/charge",
        status: 200,
        response: { id: 1 },
        reqheaders: { "x-idempotency-key": "<!volatile!header:x-idempotency-key!0>" },
      },
      {
        scope: "https://api.example.com",
        method: "POST",
        path: "/charge",
        status: 200,
        response: { id: 2 },
        reqheaders: { "x-idempotency-key": "<!volatile!header:x-idempotency-key!0>" },
      },
      {
        scope: "https://api.example.com",
        method: "POST",
        path: "/charge",
        status: 200,
        response: { id: 3 },
        reqheaders: { "x-idempotency-key": "<!volatile!header:x-idempotency-key!1>" },
      },
    ]);

    // Replay [X, X, Y] — same reuse pattern as record, just different values.
    await replayCassette(
      path,
      fields,
      async () => {
        const r1 = await fetch("https://api.example.com/charge", {
          method: "POST",
          headers: { "x-idempotency-key": "X" },
        });
        const r2 = await fetch("https://api.example.com/charge", {
          method: "POST",
          headers: { "x-idempotency-key": "X" },
        });
        const r3 = await fetch("https://api.example.com/charge", {
          method: "POST",
          headers: { "x-idempotency-key": "Y" },
        });
        expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 200]);
      },
      { testName: "idempotency reuse" },
    );
  });

  it("fails when the reuse pattern diverges (rotated where record reused)", async () => {
    const path = cassette([
      {
        scope: "https://api.example.com",
        method: "POST",
        path: "/charge",
        status: 200,
        response: { id: 1 },
        reqheaders: { "x-idempotency-key": "<!volatile!header:x-idempotency-key!0>" },
      },
      {
        scope: "https://api.example.com",
        method: "POST",
        path: "/charge",
        status: 200,
        response: { id: 2 },
        reqheaders: { "x-idempotency-key": "<!volatile!header:x-idempotency-key!0>" },
      },
    ]);

    // Replay [X, Y] — rotated when record reused. Second request must fail.
    await expect(
      replayCassette(
        path,
        fields,
        async () => {
          await fetch("https://api.example.com/charge", {
            method: "POST",
            headers: { "x-idempotency-key": "X" },
          });
          await fetch("https://api.example.com/charge", {
            method: "POST",
            headers: { "x-idempotency-key": "Y" },
          });
        },
        { testName: "rotated when record reused" },
      ),
    ).rejects.toThrow(/no recorded match|stale cassette/);
  });

  it("fails when the test omits a header the cassette expected", async () => {
    const path = cassette([
      {
        scope: "https://api.example.com",
        method: "POST",
        path: "/charge",
        status: 200,
        response: {},
        reqheaders: { "x-idempotency-key": "<!volatile!header:x-idempotency-key!0>" },
      },
    ]);

    await expect(
      replayCassette(
        path,
        fields,
        async () => {
          // No x-idempotency-key sent.
          await fetch("https://api.example.com/charge", { method: "POST" });
        },
        { testName: "missing header" },
      ),
    ).rejects.toThrow(/no recorded match/);
  });
});
