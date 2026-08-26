import { defineVcr } from "vcrkit/vitest";

const vcr = defineVcr({});

vcr("generated idempotency key", async () => {
  await fetch("https://api.example.com/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      task: "generate-quarterly-report",
    }),
  });
});
