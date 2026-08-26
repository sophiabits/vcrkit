import { expect } from "vitest";

import { defineVcr } from "vcrkit/vitest";

const vcr = defineVcr({
  secrets: {
    apiKey: async () => "sk_test_acceptance",
  },
});

vcr("smoke replay matches a cassette with redacted apiKey", async ({ secrets }) => {
  const res = await fetch("https://api.example.com/whoami", {
    headers: { "x-api-key": secrets.apiKey },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
});
