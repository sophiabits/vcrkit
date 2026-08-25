/**
 * Errors produced by bside (mismatch reports, cassette-miss, secret loading,
 * etc.) should read as test-author-facing diagnostics — not as internal-
 * machinery traces.
 *
 * V8's `Error.captureStackTrace(err, fnRef)` rewrites the
 * stack to start above `fnRef`, so by passing the entry point a caller cares
 * about (e.g. `replayCassette`) the user's test frame ends up at the top.
 *
 * The optional `captureFrom` lets each call site name its own boundary; we
 * default to this function so at minimum `makeUserFacingError` itself is
 * hidden. Path-matching the source-tree to strip frames (the old approach) was
 * fragile in monorepos that happened to contain a `vitest` or `secrets` dir.
 */
export function makeUserFacingError(
  message: string,
  options?: { cause?: unknown; captureFrom?: (...args: never[]) => unknown },
): Error {
  const err = new Error(message, options);
  Error.captureStackTrace(err, options?.captureFrom ?? makeUserFacingError);
  return err;
}
