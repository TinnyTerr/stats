import pkg from "../package.json" with { type: "json" };

/**
 * One version for both roles — hub and agent ship from the same repo, so the
 * only source of truth is package.json.
 */
export const VERSION: string = pkg.version;

/**
 * The agent↔hub HTTP contract. Bumped only when the wire shape changes in a way
 * an older peer can't read; the release version moves independently of it.
 */
export const PROTOCOL = 1;

/** What both roles report about themselves, on /api/health and in snapshots. */
export interface VersionInfo {
  version: string;
  protocol: number;
}

export const versionInfo: VersionInfo = { version: VERSION, protocol: PROTOCOL };
