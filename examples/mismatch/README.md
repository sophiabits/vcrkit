# Intentional replay mismatch

This fixture exists to demonstrate vcrkit's mismatch output. It is fully offline and is expected to
exit with status 1.

From this directory, run:

```sh
pnpm vcrkit replay
```

The cassette contains a recorded idempotency key, while the test creates a fresh one on every run.
The resulting error points to `volatile.request.body` as the fix.
