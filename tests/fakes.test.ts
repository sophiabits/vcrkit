import { describe, expect, it } from "vitest";

import { fakeToken, fakeUuid } from "../src/secrets.ts";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("fakeToken", () => {
  it("produces a string of exactly `length` chars, starting with `prefix`", () => {
    const out = fakeToken({ prefix: "sk_test_", length: 32 })("someId");
    expect(out).toHaveLength(32);
    expect(out.startsWith("sk_test_")).toBe(true);
  });

  it("is deterministic in the seed", () => {
    const factory = fakeToken({ prefix: "sk_test_", length: 24 });
    expect(factory("apiKey")).toBe(factory("apiKey"));
  });

  it("yields distinct values for distinct seeds", () => {
    const factory = fakeToken({ prefix: "sk_test_", length: 24 });
    expect(factory("apiKey")).not.toBe(factory("otherKey"));
  });

  it("respects an explicit `seed` override (pins the value)", () => {
    const pinned = fakeToken({ prefix: "sk_test_", length: 24, seed: "fixed" });
    expect(pinned("apiKey")).toBe(pinned("anotherKey"));
  });

  it("defaults to length 32 with no prefix", () => {
    const out = fakeToken()("x");
    expect(out).toHaveLength(32);
    expect(out).toMatch(/^[0-9a-f]{32}$/);
  });

  it("supports bodies longer than one SHA-256 (64 hex chars)", () => {
    const out = fakeToken({ length: 128 })("seed");
    expect(out).toHaveLength(128);
    expect(out).toMatch(/^[0-9a-f]{128}$/);
  });

  it("throws when prefix is longer than length", () => {
    expect(() => fakeToken({ prefix: "very-long-prefix", length: 4 })).toThrow(/length/);
  });
});

describe("fakeUuid", () => {
  it("produces an RFC 4122 v4-shaped string", () => {
    const out = fakeUuid()("someId");
    expect(out).toMatch(UUID_V4_RE);
  });

  it("is deterministic in the seed", () => {
    const factory = fakeUuid();
    expect(factory("apiKey")).toBe(factory("apiKey"));
  });

  it("yields distinct UUIDs for distinct seeds", () => {
    const factory = fakeUuid();
    expect(factory("apiKey")).not.toBe(factory("otherKey"));
  });

  it("respects an explicit `seed` override", () => {
    const pinned = fakeUuid({ seed: "fixed" });
    expect(pinned("apiKey")).toBe(pinned("anotherKey"));
    expect(pinned("apiKey")).toMatch(UUID_V4_RE);
  });
});
