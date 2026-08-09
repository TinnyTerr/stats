import pkg from "../package.json" with { type: "json" };

/**
 * One version for both roles — hub and agent ship from the same repo, so the
 * only source of truth is package.json.
 */
export const VERSION: string = pkg.version;

/**
 * The node↔hub wire contract — the frame layout in src/proto/frame.ts and the
 * payloads that ride on it. Bumped only when an older peer would misread a
 * newer one; the release version moves independently of it.
 *
 * 2: nodes dial the hub over a WebSocket and speak the binary frame protocol.
 * 1: the hub polled each agent's HTTP API.
 */
export const PROTOCOL = 2;

/** What both roles report about themselves, on /api/health and in snapshots. */
export interface VersionInfo {
	version: string;
	protocol: number;
}

export const versionInfo: VersionInfo = {
	version: VERSION,
	protocol: PROTOCOL,
};
