/**
 * vcrkit/secrets — provider factories, replayAs, and shipped fakes.
 */

import { createHash } from "node:crypto";

import { makeUserFacingError } from "./core/user-facing-error.ts";

export type SecretProvider = () => Promise<string>;

/**
 * A fake replay value is a deterministic `(seed) => string` factory, seeded
 * by the secret's config key when wired through `replayAs`. Same key → same
 * value every run, so cassettes don't churn.
 */
export type FakeFactory = (seed: string) => string;

export interface ReplayAs {
  provider: SecretProvider;
  replay: string | FakeFactory;
}

/**
 * Wraps a provider with an explicit replay value.
 *
 * Useful if you're working with code that validates token shape, and the default
 * `{{name}}` replay value fails validation (e.g. `google-auth-library` validates
 * that the passed-in credential is a valid JSON string).
 *
 * @example
 * replayAs(
 *   gcpSecret({ name: "GOOGLE_CREDENTIALS" }),
 *   JSON.stringify({...}),
 * )
 */
export function replayAs(provider: SecretProvider, replay: string | FakeFactory): ReplayAs {
  return { provider, replay };
}

export type SecretEntry = SecretProvider | ReplayAs;

export function fromEnv(name: string): SecretProvider {
  return async () => {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw makeUserFacingError(`vcrkit: env var ${name} is not set`);
    }
    return value;
  };
}

export interface GcpSecretOpts {
  /** GCP project ID. Falls back to the SDK's default-credentials project. */
  project?: string;
  /** Secret name within the project (the part after `projects/X/secrets/`). */
  name: string;
  /**
   * Secret version.
   * @default "latest"
   */
  version?: string;
  /** Surfaced in the error message when auth fails — usually a CLI to run. */
  hint?: string;
}

/**
 * Read a secret from GCP Secret Manager.
 *
 * Auth comes from Application Default Credentials.
 */
export function gcpSecret(opts: GcpSecretOpts): SecretProvider {
  return async (): Promise<string> => {
    const { SecretManagerServiceClient } = await loadSdk(
      () => import("@google-cloud/secret-manager"),
      "@google-cloud/secret-manager",
      opts.hint ?? "Run `gcloud auth application-default login`",
    );
    const client = new SecretManagerServiceClient();
    const project = opts.project ?? (await client.getProjectId());
    const version = opts.version ?? "latest";
    const fullName = `projects/${project}/secrets/${opts.name}/versions/${version}`;
    try {
      const [response] = await client.accessSecretVersion({ name: fullName });
      const payload = response.payload?.data;
      if (!payload) {
        throw makeUserFacingError(`vcrkit: ${fullName} returned no payload`);
      }
      return typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
    } catch (err) {
      throw wrapAuthError(err, `gcpSecret(${fullName})`, opts.hint);
    }
  };
}

export interface AwsSecretOpts {
  /** AWS region (e.g. `us-east-1`). Falls back to the SDK's resolver chain. */
  region?: string;
  /** Secret name or full ARN. */
  secretId: string;
  /**
   * Stage label (`AWSCURRENT` etc.) or version ID. Defaults to the latest version of the secret.
   */
  versionStage?: string;
  /** Surfaced in the error message when auth fails — usually a CLI to run. */
  hint?: string;
}

/**
 * Read a secret from AWS Secrets Manager.
 *
 * Auth comes from the standard AWS credentials chain.
 */
export function awsSecret(opts: AwsSecretOpts): SecretProvider {
  return async (): Promise<string> => {
    const { SecretsManagerClient, GetSecretValueCommand } = await loadSdk(
      () => import("@aws-sdk/client-secrets-manager"),
      "@aws-sdk/client-secrets-manager",
      opts.hint ?? "Run `aws sso login` or set AWS_PROFILE / AWS_ACCESS_KEY_ID",
    );
    const client = new SecretsManagerClient(opts.region ? { region: opts.region } : {});
    try {
      const out = await client.send(
        new GetSecretValueCommand({
          SecretId: opts.secretId,
          ...(opts.versionStage ? { VersionStage: opts.versionStage } : {}),
        }),
      );
      if (typeof out.SecretString === "string") {
        return out.SecretString;
      }
      if (out.SecretBinary) {
        return Buffer.from(out.SecretBinary).toString("utf8");
      }
      throw makeUserFacingError(`vcrkit: awsSecret(${opts.secretId}) returned no value`);
    } catch (err) {
      throw wrapAuthError(err, `awsSecret(${opts.secretId})`, opts.hint);
    }
  };
}

export interface AwsParameterOpts {
  /** AWS region. Falls back to the SDK's resolver chain. */
  region?: string;
  /** Parameter name (e.g. `/prod/stripe/secret-key`). */
  name: string;
  /**
   * Whether to decrypt `SecureString` parameters.
   *
   * @default true
   */
  withDecryption?: boolean;
  /** Surfaced in the error message when auth fails — usually a CLI to run. */
  hint?: string;
}

/**
 * Read a parameter from AWS Systems Manager Parameter Store.
 *
 * Auth comes from the standard AWS credentials chain.
 */
export function awsParameter(opts: AwsParameterOpts): SecretProvider {
  return async (): Promise<string> => {
    const { SSMClient, GetParameterCommand } = await loadSdk(
      () => import("@aws-sdk/client-ssm"),
      "@aws-sdk/client-ssm",
      opts.hint ?? "Run `aws sso login` or set AWS_PROFILE / AWS_ACCESS_KEY_ID",
    );
    const client = new SSMClient(opts.region ? { region: opts.region } : {});
    try {
      const out = await client.send(
        new GetParameterCommand({
          Name: opts.name,
          WithDecryption: opts.withDecryption ?? true,
        }),
      );
      const value = out.Parameter?.Value;
      if (typeof value !== "string") {
        throw makeUserFacingError(`vcrkit: awsParameter(${opts.name}) returned no value`);
      }
      return value;
    } catch (err) {
      throw wrapAuthError(err, `awsParameter(${opts.name})`, opts.hint);
    }
  };
}

async function loadSdk<T>(importer: () => Promise<T>, pkg: string, hint: string): Promise<T> {
  try {
    return await importer();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw makeUserFacingError(
      `vcrkit: failed to load optional peer dep \`${pkg}\` — install it as a devDependency.\n` +
        `  Hint: ${hint}\n` +
        `  Cause: ${cause}`,
    );
  }
}

function wrapAuthError(err: unknown, provider: string, hint: string | undefined): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const hintLine = hint ? `\n  Hint: ${hint}` : "";
  return makeUserFacingError(`vcrkit: ${provider} failed: ${msg}${hintLine}`);
}

export interface FakeTokenOpts {
  /** Literal prefix prepended verbatim (`sk_test_`, `pk_`, etc.). */
  prefix?: string;
  /** Total length of the produced string, including the prefix. Default 32. */
  length?: number;
  /** Pin the seed instead of deriving it from the secret's config key. */
  seed?: string;
}

/**
 * Deterministic token factory.
 *
 * @example
 * const vcr = defineVcr({
 *   secrets: {
 *     stripeToken: replayAs(
 *       fromEnv("STRIPE_TOKEN"),
 *       fakeToken({ prefix: "sk_", length: 32 }),
 *     ),
 *   },
 * });
 */
export function fakeToken(opts: FakeTokenOpts = {}): FakeFactory {
  const prefix = opts.prefix ?? "";
  const length = opts.length ?? 32;
  const seedOverride = opts.seed;
  if (length < prefix.length) {
    throw makeUserFacingError(
      `vcrkit: fakeToken length (${length}) must be >= prefix length (${prefix.length})`,
    );
  }
  return (key: string): string => {
    const seed = seedOverride ?? key;
    const need = length - prefix.length;
    return prefix + hexStream(seed, need);
  };
}

export interface FakeUuidOpts {
  /** Pin the seed instead of deriving it from the secret's config key. */
  seed?: string;
}

/**
 * Deterministic RFC 4122 v4-shaped UUID factory. The 16 bytes come
 * from SHA-256(seed); the version (4) and variant (10) bits are set so the
 * value passes UUID validators..
 */
export function fakeUuid(opts: FakeUuidOpts = {}): FakeFactory {
  const seedOverride = opts.seed;
  return (key: string): string => {
    const seed = seedOverride ?? key;
    const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
    const b = Buffer.from(bytes);
    // RFC 4122: version 4 in the high nibble of byte 6, variant 10 in the
    // high two bits of byte 8.
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };
}

/**
 * Lowercase hex stream of arbitrary length, deterministic for a given `seed`.
 */
function hexStream(seed: string, length: number): string {
  let out = "";
  let counter = 0;
  while (out.length < length) {
    out += createHash("sha256").update(seed).update(`:${counter}`).digest("hex");
    counter++;
  }
  return out.slice(0, length);
}
