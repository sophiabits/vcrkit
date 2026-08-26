import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { makeUserFacingError } from "./user-facing-error.ts";

export interface Cassette {
  version: 1;
  definitions: NockDefinition[];
}

export const CASSETTE_VERSION = 1 as const;

export type HeadersLike = Record<string, unknown>;

export type NockRawHeaders = Record<string, string | string[]>;

/**
 * Shape of an entry from `nock.recorder.play()` with `output_objects: true`.
 * Kept loose — nock's own typing is too narrow for the response field.
 */
export interface NockDefinition {
  scope: string;
  method?: string;
  path: string;
  status?: number;
  body?: unknown;
  response?: unknown;
  reqheaders?: Record<string, string>;
  rawHeaders?: NockRawHeaders;
  [key: string]: unknown;
}

export async function readCassette(path: string): Promise<Cassette | null> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const raw = JSON.parse(content) as {
    version?: unknown;
    definitions?: unknown;
  };
  if (raw.version !== CASSETTE_VERSION) {
    throw makeUserFacingError(
      `vcrkit: cassette at ${path} has unsupported version ${String(raw.version)} — ` +
        `this CLI only understands version ${CASSETTE_VERSION}. Upgrade vcrkit or re-record.`,
    );
  }
  if (!Array.isArray(raw.definitions)) {
    throw makeUserFacingError(
      `vcrkit: cassette at ${path} is malformed — \`definitions\` is missing or not an array`,
    );
  }
  return { version: CASSETTE_VERSION, definitions: raw.definitions };
}

export async function writeCassette(path: string, cassette: Cassette): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const payload: Cassette = { version: CASSETTE_VERSION, definitions: cassette.definitions };
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // The write may have failed before creating the temporary file, or the
      // rename may already have moved it into place.
    }
    throw error;
  }
}

/**
 * Computes where to store the cassette file for a given test context, e.g.
 * `<test-dir>/__cassettes__/<test-file-stem>/<suite-segments…>/<test-name>.json`.
 *
 * File path sanitization can produce collisions (e.g. `Foo bar` and `foo-bar` both
 * sanitize to `foo-bar`), which runners should watch out for.
 */
export function cassettePathFor(
  testFilePath: string,
  suitePath: readonly string[],
  testName: string,
): string {
  const dir = dirname(testFilePath);
  const stem = basename(testFilePath).replace(/\.(vcr\.)?test\.[mc]?[jt]sx?$/, "");
  const suiteDirs = suitePath.map(sanitize);
  return join(dir, "__cassettes__", stem, ...suiteDirs, `${sanitize(testName)}.json`);
}

function sanitize(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\./g, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "unnamed"
  );
}
