import { describe, expect, it } from "vitest";

import { readVcrMode, withVcrLock } from "../src/core/runtime.ts";
import { fromEnv, replayAs } from "../src/secrets.ts";
import { defineVcr } from "../src/vitest.ts";

describe("core engine", () => {
  it("readVcrMode returns null when VCR is unset", () => {
    expect(readVcrMode({})).toBeNull();
  });

  it("readVcrMode picks up record/replay", () => {
    expect(readVcrMode({ VCR: "record" })).toBe("record");
    expect(readVcrMode({ VCR: "replay" })).toBe("replay");
    expect(readVcrMode({ VCR: "bogus" })).toBeNull();
  });

  it("withVcrLock allows sequential use", async () => {
    await withVcrLock("a", async () => {});
    await withVcrLock("b", async () => {});
  });

  it("withVcrLock throws on concurrent overlap", async () => {
    await expect(
      withVcrLock("outer", async () => {
        await withVcrLock("inner", async () => {});
      }),
    ).rejects.toThrow(/concurrently/);
  });

  it("releases the lock after a thrown body", async () => {
    await expect(
      withVcrLock("boom", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    await withVcrLock("after", async () => {});
  });
});

describe("bside/secrets", () => {
  it("fromEnv reads a present var", async () => {
    const provider = fromEnv("BSIDE_TEST_VAR");
    process.env.BSIDE_TEST_VAR = "ok";
    try {
      await expect(provider()).resolves.toBe("ok");
    } finally {
      delete process.env.BSIDE_TEST_VAR;
    }
  });

  it("fromEnv throws on missing var", async () => {
    const provider = fromEnv("BSIDE_DEFINITELY_UNSET_VAR");
    await expect(provider()).rejects.toThrow(/BSIDE_DEFINITELY_UNSET_VAR/);
  });

  it("replayAs wraps provider + replay value", () => {
    const provider = fromEnv("X");
    const wrapped = replayAs(provider, "sk_test_zero");
    expect(wrapped.provider).toBe(provider);
    expect(wrapped.replay).toBe("sk_test_zero");
  });
});

describe("bside/vitest", () => {
  it("defineVcr returns a callable with non-enumerable _config", () => {
    const cfg = { secrets: {}, redact: { request: { headers: ["x-foo"] } } };
    const vcr = defineVcr(cfg);
    expect(typeof vcr).toBe("function");
    expect(vcr._config).toBe(cfg);
    expect(Object.keys(vcr)).not.toContain("_config");
  });
});
