import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import nock from "nock";

import { replayCassette, stripPort } from "../src/core/runner.ts";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bside-runner-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("stripPort", () => {
  it("strips a trailing port from a plain hostname", () => {
    expect(stripPort("api.example.com:8080")).toBe("api.example.com");
  });

  it("returns a plain hostname with no port unchanged", () => {
    expect(stripPort("api.example.com")).toBe("api.example.com");
  });

  it("strips the port from a bracketed IPv6 authority", () => {
    expect(stripPort("[::1]:8080")).toBe("[::1]");
  });

  it("returns a bare bracketed IPv6 host unchanged", () => {
    // The naïve lastIndexOf(':') used to leave "[:" here.
    expect(stripPort("[::1]")).toBe("[::1]");
    expect(stripPort("[2001:db8::1]")).toBe("[2001:db8::1]");
  });

  it("returns undefined unchanged", () => {
    expect(stripPort(undefined)).toBeUndefined();
  });
});

describe("replayCassette", () => {
  it("serves a recorded interaction and matches by plain equality on the canonical header value", async () => {
    const cassettePath = join(tmpDir, "ok.json");
    writeFileSync(
      cassettePath,
      JSON.stringify({
        version: 1,
        definitions: [
          {
            scope: "https://api.example.com",
            method: "GET",
            path: "/whoami",
            status: 200,
            response: { hello: "{{apiKey}}" },
            reqheaders: { "x-api-key": "{{apiKey}}" },
          },
        ],
      }),
    );

    await replayCassette(
      cassettePath,
      [],
      async () => {
        const res = await fetch("https://api.example.com/whoami", {
          headers: { "x-api-key": "{{apiKey}}" },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { hello: string };
        expect(body.hello).toBe("{{apiKey}}");
      },
      { testName: "whoami" },
    );
  });

  it("removes the no-match listener even when `nock.define` throws", async () => {
    // Pre-fix bug: listener attach + `nock.define` ran outside the try, so
    // a throw from define left the 'no match' listener attached forever.
    // Repeated bad-cassette calls would pile up listeners. Verify the count
    // returns to baseline after a failing setup.
    const baseline = nock.emitter.listenerCount("no match");
    const broken = join(tmpDir, "broken.json");
    writeFileSync(
      broken,
      JSON.stringify({
        version: 1,
        definitions: [
          {
            // No scope/path/method — nock.define rejects this shape.
            invalid: true,
          },
        ],
      }),
    );
    const brokenErr = await replayCassette(broken, [], async () => {}, {
      testName: "broken",
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    // Sanity-check the test setup itself: nock must actually reject this
    // cassette. If a future nock version accepts it, the regression hides.
    expect(brokenErr).not.toBeNull();
    expect(nock.emitter.listenerCount("no match")).toBe(baseline);
  });

  it("throws on a cassette with an unsupported version", async () => {
    const cassettePath = join(tmpDir, "future.json");
    writeFileSync(
      cassettePath,
      JSON.stringify({
        version: 999,
        definitions: [],
      }),
    );
    await expect(
      replayCassette(cassettePath, [], async () => {}, { testName: "future cassette" }),
    ).rejects.toThrow(/unsupported version 999/);
  });

  it("throws on a cassette without a version", async () => {
    const cassettePath = join(tmpDir, "unversioned.json");
    writeFileSync(cassettePath, JSON.stringify({ definitions: [] }));

    await expect(
      replayCassette(cassettePath, [], async () => {}, { testName: "unversioned cassette" }),
    ).rejects.toThrow(/unsupported version undefined/);
  });

  it("throws when the cassette is missing", async () => {
    await expect(
      replayCassette(join(tmpDir, "missing.json"), [], async () => {}, { testName: "missing" }),
    ).rejects.toThrow(/no cassette/);
  });

  it("throws a formatted mismatch report when a request doesn't match", async () => {
    const cassettePath = join(tmpDir, "mismatch.json");
    writeFileSync(
      cassettePath,
      JSON.stringify({
        version: 1,
        definitions: [
          {
            scope: "https://api.example.com",
            method: "POST",
            path: "/checkout",
            body: { cartId: "abc123" },
            status: 200,
            response: {},
          },
        ],
      }),
    );

    const err = await replayCassette(
      cassettePath,
      [],
      async () => {
        await fetch("https://api.example.com/checkout", {
          method: "POST",
          headers: {
            authorization: "Bearer must-not-leak",
            "content-type": "application/json",
          },
          body: JSON.stringify({ cartId: "def456" }),
        });
      },
      { testName: "checkout flow" },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).not.toBeNull();
    expect(err!.message).toContain('cassette "mismatch"');
    expect(err!.message).toContain("POST https://api.example.com/checkout");
    expect(err!.message).toContain("cartId");
    expect(err!.message).toContain('"abc123"');
    expect(err!.message).toContain('"def456"');
    expect(err!.message).toContain(`rm ${JSON.stringify(cassettePath)} && bside record`);
    expect(err!.cause).toBeUndefined();
    expect(err!.message).not.toContain("must-not-leak");
    expect(err!.stack).not.toContain("must-not-leak");
    expect(err!.stack).not.toContain("Nock: No match for request");
  });

  it("attaches a body-thrown error as `cause` when a mismatch is also captured", async () => {
    // Both a no-match AND a user-thrown error happen in the same run: the user
    // catches nock's terse error (or it surfaces elsewhere) and then their test
    // throws something material — an assertion, a teardown failure. The
    // mismatch report is the right primary error, but losing the user's throw
    // makes the actual bug invisible. Surface both via Error.cause.
    const cassettePath = join(tmpDir, "with-cause.json");
    writeFileSync(
      cassettePath,
      JSON.stringify({
        version: 1,
        definitions: [
          {
            scope: "https://api.example.com",
            method: "POST",
            path: "/checkout",
            body: { cartId: "abc123" },
            status: 200,
            response: {},
          },
        ],
      }),
    );

    const userError = new Error("user-side assertion failed after fetch");
    const err = await replayCassette(
      cassettePath,
      [],
      async () => {
        try {
          await fetch("https://api.example.com/checkout", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cartId: "def456" }),
          });
        } catch {
          // Swallow nock's no-match the way a user catching fetch errors would.
        }
        throw userError;
      },
      { testName: "checkout with cause" },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).not.toBeNull();
    expect(err!.message).toContain("no recorded match");
    expect(err!.cause).toBe(userError);
  });

  it("uses the no-match diagnostic for an empty cassette too", async () => {
    const cassettePath = join(tmpDir, "empty.json");
    writeFileSync(cassettePath, JSON.stringify({ version: 1, definitions: [] }));

    const err = await replayCassette(
      cassettePath,
      [],
      async () => {
        await fetch("https://api.example.com/missing");
      },
      { testName: "empty cassette" },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).not.toBeNull();
    expect(err!.message).toContain("no recorded match");
    expect(err!.message).toContain("Cassette has no recordings");
  });

  it("throws on stale cassette (recorded interaction not consumed)", async () => {
    const cassettePath = join(tmpDir, "stale.json");
    writeFileSync(
      cassettePath,
      JSON.stringify({
        version: 1,
        definitions: [
          {
            scope: "https://x.example.com",
            method: "GET",
            path: "/one",
            status: 200,
            response: "",
          },
          {
            scope: "https://x.example.com",
            method: "GET",
            path: "/two",
            status: 200,
            response: "",
          },
        ],
      }),
    );

    await expect(
      replayCassette(
        cassettePath,
        [],
        async () => {
          await fetch("https://x.example.com/one");
        },
        { testName: "stale" },
      ),
    ).rejects.toThrow(/stale cassette/);
  });
});
