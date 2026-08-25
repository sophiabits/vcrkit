import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cassettePathFor, readCassette, writeCassette } from "../src/core/cassette.ts";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bside-cassette-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("writeCassette", () => {
  it("atomically replaces an existing cassette without leaving temporary files", async () => {
    const path = join(directory, "nested", "example.json");
    await writeCassette(path, {
      version: 1,
      definitions: [{ scope: "https://example.com", path: "/old" }],
    });
    await writeCassette(path, {
      version: 1,
      definitions: [{ scope: "https://example.com", path: "/new" }],
    });

    expect((await readCassette(path))?.definitions).toEqual([
      { scope: "https://example.com", path: "/new" },
    ]);
    expect(readdirSync(join(directory, "nested"))).toEqual(["example.json"]);
    expect(readFileSync(path, "utf8")).toMatch(/\n$/);
  });

  it("returns null when the cassette does not exist", async () => {
    await expect(readCassette(join(directory, "missing.json"))).resolves.toBeNull();
  });
});

describe("cassettePathFor", () => {
  it("drops periods from generated path segments", () => {
    expect(
      cassettePathFor("/repo/example.vcr.test.ts", ["..", "Suite.With.Dots"], "Test.With.Dots"),
    ).toBe("/repo/__cassettes__/example/unnamed/suitewithdots/testwithdots.json");
  });
});
