# vcrkit

Zero-ceremony VCR (record/replay) HTTP tests on top of [nock](https://github.com/nock/nock), with first-class secret loading and redaction.

## Features

- Record real HTTP interactions in test-local cassettes
- Deterministic, offline replay without credentials or live services
- Vitest-native `defineVcr` fixture with TypeScript inference
- [Secret loading](#secrets) from environment variables, GCP Secret Manager, AWS Secrets Manager, AWS Parameter Store, or custom providers
- Automatic redaction of registered secrets and common sensitive headers
- [Strict and loose matching](#volatile-fields) for values that change between runs
- Field-level request mismatch diagnostics with suggested fixes
- [LIFO cleanup callbacks](#cleanup) that run outside cassette capture

> `vcrkit` works with Vitest versions 2-4, and Node 20+.

## Getting started

Install `vcrkit` with your preferred package manager:

```
pnpm add --dev vcrkit vitest
```

And add scripts to your `package.json`:

```json
{
  "scripts": {
    "vcr:record": "vcrkit record",
    "vcr:replay": "vcrkit replay"
  }
}
```

Create a VCR test file, like `src/example.vcr.test.ts`:

```typescript
import { expect } from "vitest";

import { defineVcr } from "vcrkit/vitest";

const vcr = defineVcr({});

vcr("httpbin returns 200", async () => {
  const res = await fetch("https://httpbin.org/status/200");
  expect(res.status).toBe(200);
});
```

Recording runs all VCR tests, recording network requests and responses to a cassette file:

```
pnpm vcr:record
```

Replaying runs the VCR tests, replaying network responses from cassettes:

```
pnpm vcr:replay
```

Running a regular `vitest` invocation will skip execution of VCRs.

VCR tests support Vitest's familiar focus and skip modifiers:

```typescript
vcr.skip("temporarily disabled", async () => {
  // ...
});

vcr.only("run just this VCR test", async () => {
  // ...
});
```

## Usage

### Secrets

Most useful VCR tests require credentials. You can define secret dependencies by passing in a map of secret loaders:

```typescript
import { expect } from "vitest";

import { defineVcr } from "vcrkit/vitest";
import { fromEnv } from "vcrkit/secrets";

const vcr = defineVcr({
  secrets: {
    stripeToken: fromEnv("STRIPE_TOKEN"),
  },
});

vcr("can create a customer", async ({ secrets }) => {
  const stripe = new Stripe(secrets.stripeToken);
  const customer = await stripe.customers.create();
  expect(customer.id).toMatch("cus_");
});
```

`vcrkit` ships with helpers for common secret stores, and you can also write your own function for loading secrets:

```typescript
import { defineVcr } from "vcrkit/vitest";
import { awsSecret } from "vcrkit/secrets";

const vcr = defineVcr({
  secrets: {
    stripeToken: awsSecret({
      secretId: "arn:...",
    }),
    someOtherToken: () =>
      fetch("...")
        .then((res) => res.json())
        .then((data) => data.token),
  },
});
```

Secrets are only loaded when recording a cassette. During replay, secrets are stubbed out with dummy strings:

```typescript
const vcr = defineVcr({
  secrets: {
    stripeToken: awsSecret({
      secretId: "arn:...",
    }),
  },
});

vcr("...", ({ secrets }) => {
  // secrets.stripeToken is "{{stripeToken}}" when replaying
});
```

Some libraries expect credentials to match a particular shape. For example, `google-auth-library` will throw if you try to pass in a string that isn't valid JSON. To work around this, you can supply your own replay value:

```typescript
import { awsSecret, replayAs } from "vcrkit/secrets";

const vcr = defineVcr({
  secrets: {
    googleCredentials: replayAs(
      awsSecret({ secretId: "arn:..." }),
      JSON.stringify({
        /* ... */
      }),
    ),
  },
});
```

### Cleanup

Each VCR test receives an `onCleanup` function, which can be used to queue up work which runs after the test finishes (either successfully or unsuccessfully):

```typescript
const vcr = defineVcr({});

vcr("updates a Stripe customer", async ({ onCleanup }) => {
  const customer = await stripe.customers.create();
  onCleanup(async () => {
    await stripe.customers.del(customer.id);
  });

  await stripe.customers.update(customer.id, {
    metadata: { testRun: "vcrkit" },
  });

  const retrieved = await stripe.customers.retrieve(customer.id);

  expect(retrieved.metadata).toEqual({ testRun: "vcrkit" });
});
```

You can call `onCleanup` multiple times within a test. Cleanup callbacks are executed in LIFO order, and network requests made within them are not recorded to the cassette file. Cleanup callbacks only run in recording mode.

### Redaction

`vcrkit` ships out of the box with three default layers of redaction:

1. Security-sensitive headers like `authorization` are tokenized, so that raw header values observed during a recording don't get written to disk.
2. Secret values returned from loaders in the `secrets` map are automatically tokenized, like above.
3. Transient values which are randomized across runs (like `x-request-id`) are completely dropped, so they don't create noise when re-recording a test suite.

If the API you're testing sends back sensitive values that aren't covered by the defaults, then you can pass in custom redaction options. For example, if you're working with [Stripe Issuing cards](https://docs.stripe.com/api/issuing/cards/object) you can redact the `cvc` field from response bodies like so:

```typescript
const vcr = defineVcr({
  redact: {
    response: {
      body: ["cvc"],
    },
  },
});
```

Field name matching works at arbitrary depth, so all of the following `cvc` fields will end up redacted:

```jsonc
// in
{
  "cvc": "123",
  "card": {
    "cvc": "456",
    "details": {
      "cvc": "789"
    }
  }
}

// out
{
  "cvc": "<redact!...>",
  "card": {
    "cvc": "<redact!...>",
    "details": {
      "cvc": "<redact!...>"
    }
  }
}
```

You can add API-specific headers to the built-in ignore list. Names are case-insensitive and the configured headers are omitted from both requests and responses:

```typescript
const vcr = defineVcr({
  ignore: {
    request: {
      headers: ["x-timing"],
    },
    response: {
      headers: ["x-shopify-complexity-score"],
    },
  },
});
```

### Volatile fields

Some values are generated at runtime and differ between runs. Idempotency keys, for example, are normally randomly generated client-side before making a request. Marking these fields as volatile avoids request matching failures during replay:

```typescript
import { randomUUID } from "node:crypto";

const vcr = defineVcr({
  volatile: {
    request: {
      headers: ["idempotency-key"],
    },
  },
});

vcr("retries a charge with the same idempotency key", async () => {
  const idempotencyKey = randomUUID();

  const charge = () =>
    fetch("https://api.example.com/charges", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
    });

  await charge();
  await charge();
});
```

By default, `vcrkit` keeps track of each distinct value it observes for a volatile field. This is useful for ensuring value reuse patterns remain stable as you iterate on your code.

Suppose your service creates two Stripe charges. The first request encounters a transient connection failure and is retried with the same idempotency key. The second charge uses a new key. During recording, vcrkit observes the pattern `[A, A, B]`.

During replay, `[X, X, Y]` matches because the literal keys changed but their reuse pattern did not. `[X, Y, Z]` fails, catching a bug where the retry generated a new idempotency key and could create a duplicate charge.

Volatile values are tokenized (similar to redacted fields) to minimize cassette churn from re-recording.

Volatile fields can be opted in to loose matching, which _doesn't_ keep track of reuse patterns. This is helpful when you want your test to verify that a field has been provided as part of a request, but you don't care about the specific value of the field:

```typescript
const vcr = defineVcr({
  volatile: {
    request: {
      body: [{ name: "traceId", match: "loose" }],
    },
  },
});
```

## Notes

1. `vcrkit` uses [nock](https://github.com/nock/nock) under the hood to intercept HTTP requests. Modifying `nock` configuration options from your own code within a VCR test is unsupported.
2. You should always review cassettes for sensitive data before committing them to source control, and adjust `redact` options if needed.
3. When running in recording mode, real network requests are made. Do not make irreversible actions!
