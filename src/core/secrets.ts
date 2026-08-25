import type { SecretEntry } from "../secrets.ts";

export function getReplayValue(entry: SecretEntry, key: string): string {
  if (typeof entry === "function") {
    return `{{${key}}}`;
  }
  return typeof entry.replay === "string" ? entry.replay : entry.replay(key);
}

export async function resolveSecretEntry(
  entry: SecretEntry,
  key: string,
): Promise<{ resolved: string; replay: string }> {
  if (typeof entry === "function") {
    return { resolved: await entry(), replay: `{{${key}}}` };
  }

  return {
    resolved: await entry.provider(),
    replay: getReplayValue(entry, key),
  };
}
