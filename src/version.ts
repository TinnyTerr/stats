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
 * 5: a node's hostname and addresses are core (`host`) and everything else is
 *    a module's, so `stats` and `facts` are optional; the hub carries a
 *    per-node module plan in Welcome and can ask a node to change its set.
 * 4: telemetry carries proxmox and guests, plus `extras` — the reports of
 *    modules a node installed rather than shipped with — and capabilities
 *    carry those modules' manifests so the dashboard can draw them.
 * 3: capabilities are a module set rather than a fixed list of booleans.
 * 2: nodes dial the hub over a WebSocket and speak the binary frame protocol.
 * 1: the hub polled each agent's HTTP API.
 */
export const PROTOCOL = 5;

/** What both roles report about themselves, on /api/health and in snapshots. */
export interface VersionInfo {
	version: string;
	protocol: number;
}

export const versionInfo: VersionInfo = {
	version: VERSION,
	protocol: PROTOCOL,
};

/**
 * Compares two semver-ish strings; positive when `a` is newer. Lives here
 * rather than in src/update.ts because the dashboard needs it too, and the
 * browser can't import anything that reaches for the filesystem.
 *
 * Pre-release suffixes are ignored: they matter to a release process, and this
 * only ever answers "is that node behind this hub?".
 */
export function compareVersions(a: string, b: string): number {
	const parts = (value: string) =>
		value
			.trim()
			.replace(/^v/, "")
			.split("-")[0]!
			.split(".")
			.map((n) => Number.parseInt(n, 10) || 0);
	const left = parts(a);
	const right = parts(b);
	for (let i = 0; i < 3; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
