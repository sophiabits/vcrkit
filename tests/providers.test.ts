import { afterEach, describe, expect, it, vi } from "vitest";

import { awsParameter, awsSecret, fromEnv, gcpSecret } from "../src/secrets.ts";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("fromEnv", () => {
  it("returns the env var value when set", async () => {
    vi.stubEnv("BSIDE_X", "value");
    await expect(fromEnv("BSIDE_X")()).resolves.toBe("value");
  });

  it("throws with the var name when missing", async () => {
    await expect(fromEnv("BSIDE_NOT_SET")()).rejects.toThrow(/BSIDE_NOT_SET/);
  });

  it("throws when set to empty string (likely a config bug)", async () => {
    vi.stubEnv("BSIDE_EMPTY", "");
    await expect(fromEnv("BSIDE_EMPTY")()).rejects.toThrow(/BSIDE_EMPTY/);
  });
});

describe("gcpSecret", () => {
  it("constructs the full version path and decodes the payload", async () => {
    const accessSecretVersion = vi
      .fn()
      .mockResolvedValue([{ payload: { data: Buffer.from("super-secret", "utf8") } }]);
    const getProjectId = vi.fn().mockResolvedValue("auto-project");
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        accessSecretVersion,
        getProjectId,
      })),
    }));

    const value = await gcpSecret({ name: "my-secret" })();
    expect(value).toBe("super-secret");
    expect(accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/auto-project/secrets/my-secret/versions/latest",
    });
  });

  it("uses provided project + version verbatim", async () => {
    const accessSecretVersion = vi
      .fn()
      .mockResolvedValue([{ payload: { data: Buffer.from("v", "utf8") } }]);
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        accessSecretVersion,
        getProjectId: vi.fn(),
      })),
    }));

    await gcpSecret({ project: "explicit", name: "k", version: "3" })();
    expect(accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/explicit/secrets/k/versions/3",
    });
  });

  it("wraps SDK errors with the provider name + hint", async () => {
    vi.doMock("@google-cloud/secret-manager", () => ({
      SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        accessSecretVersion: vi.fn().mockRejectedValue(new Error("permission denied")),
        getProjectId: vi.fn().mockResolvedValue("p"),
      })),
    }));

    await expect(gcpSecret({ name: "k", hint: "auth via gcloud" })()).rejects.toThrow(
      /gcpSecret.*permission denied.*auth via gcloud/s,
    );
  });
});

describe("awsSecret", () => {
  it("returns SecretString when set", async () => {
    const send = vi.fn().mockResolvedValue({ SecretString: "literal-secret" });
    vi.doMock("@aws-sdk/client-secrets-manager", () => ({
      SecretsManagerClient: vi.fn().mockImplementation(() => ({ send })),
      GetSecretValueCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    }));

    await expect(awsSecret({ secretId: "prod/api-key" })()).resolves.toBe("literal-secret");
  });

  it("decodes SecretBinary when SecretString is absent", async () => {
    const send = vi.fn().mockResolvedValue({ SecretBinary: Buffer.from("binary-secret", "utf8") });
    vi.doMock("@aws-sdk/client-secrets-manager", () => ({
      SecretsManagerClient: vi.fn().mockImplementation(() => ({ send })),
      GetSecretValueCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    }));

    await expect(awsSecret({ secretId: "bin" })()).resolves.toBe("binary-secret");
  });

  it("passes region through to the client", async () => {
    const ctor = vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({ SecretString: "x" }),
    }));
    vi.doMock("@aws-sdk/client-secrets-manager", () => ({
      SecretsManagerClient: ctor,
      GetSecretValueCommand: vi.fn(),
    }));

    await awsSecret({ region: "eu-west-1", secretId: "k" })();
    expect(ctor).toHaveBeenCalledWith({ region: "eu-west-1" });
  });
});

describe("awsParameter", () => {
  it("returns Parameter.Value", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: "param-value" } });
    vi.doMock("@aws-sdk/client-ssm", () => ({
      SSMClient: vi.fn().mockImplementation(() => ({ send })),
      GetParameterCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
    }));

    await expect(awsParameter({ name: "/foo/bar" })()).resolves.toBe("param-value");
  });

  it("requests WithDecryption=true by default (SecureString)", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: "x" } });
    const cmdCtor = vi.fn().mockImplementation((input: unknown) => ({ input }));
    vi.doMock("@aws-sdk/client-ssm", () => ({
      SSMClient: vi.fn().mockImplementation(() => ({ send })),
      GetParameterCommand: cmdCtor,
    }));

    await awsParameter({ name: "/x" })();
    expect(cmdCtor).toHaveBeenCalledWith({ Name: "/x", WithDecryption: true });
  });

  it("honors withDecryption: false", async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: "x" } });
    const cmdCtor = vi.fn().mockImplementation((input: unknown) => ({ input }));
    vi.doMock("@aws-sdk/client-ssm", () => ({
      SSMClient: vi.fn().mockImplementation(() => ({ send })),
      GetParameterCommand: cmdCtor,
    }));

    await awsParameter({ name: "/x", withDecryption: false })();
    expect(cmdCtor).toHaveBeenCalledWith({ Name: "/x", WithDecryption: false });
  });

  it("throws when Parameter.Value is missing", async () => {
    vi.doMock("@aws-sdk/client-ssm", () => ({
      SSMClient: vi.fn().mockImplementation(() => ({
        send: vi.fn().mockResolvedValue({ Parameter: {} }),
      })),
      GetParameterCommand: vi.fn(),
    }));

    await expect(awsParameter({ name: "/x" })()).rejects.toThrow(/returned no value/);
  });
});
