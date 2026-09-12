import { readFileSync } from "node:fs";

export interface ReleaseInfo {
  revision: string;
  builtAt?: string;
  dependencyHash?: string;
  sourceHash?: string;
  dirty?: boolean;
}

/** The installed build describes itself; never guess a revision from the host checkout. */
export function getReleaseInfo(): ReleaseInfo {
  try {
    const value = JSON.parse(readFileSync(new URL("../../../../release.json", import.meta.url), "utf8"));
    if (value.version !== 1 || !/^[a-f0-9]{40}$/.test(value.revision) || typeof value.dirty !== "boolean") return { revision: "unknown" };
    return {
      revision: value.revision, dirty: value.dirty,
      builtAt: typeof value.builtAt === "string" ? value.builtAt : undefined,
      dependencyHash: /^[a-f0-9]{64}$/.test(value.dependencyHash) ? value.dependencyHash : undefined,
      sourceHash: /^[a-f0-9]{64}$/.test(value.sourceHash) ? value.sourceHash : undefined,
    };
  } catch { return { revision: "unknown" }; }
}
