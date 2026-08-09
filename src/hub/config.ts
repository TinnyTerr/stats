import type { HubConfig, NodeOverride } from "../types.ts";

/**
 * Hub configuration. Unlike the old poll-based setup, the hub no longer lists
 * the machines it watches — nodes announce themselves. What's left is the
 * hub's own settings plus optional per-node overrides (a nicer display name,
 * tags, a dedicated token) that apply when a node with that id shows up.
 */

const DEFAULT_PATH = process.env.STATS_CONFIG ?? "./hub.json";

interface RawConfig {
	port?: number;
	host?: string;
	token?: string | null;
	nodeToken?: string | null;
	allowUnknownNodes?: boolean;
	dbPath?: string;
	retentionHours?: number;
	telemetryIntervalMs?: number;
	nodeTimeoutMs?: number;
	terminal?: boolean;
	embeddedNode?: boolean;
	nodes?: NodeOverride[];
}

/** Resolves "env:NAME" indirection; passes anything else through. */
export function resolveSecret(value: string | null | undefined): string | null {
	if (!value) return null;
	if (value.startsWith("env:")) return process.env[value.slice(4)] ?? null;
	return value;
}

function validateNode(node: NodeOverride, index: number): string[] {
	const errors: string[] = [];
	const where = `nodes[${index}]`;
	if (!node.id) errors.push(`${where}: missing 'id'`);
	else if (!/^[a-zA-Z0-9_.-]+$/.test(node.id)) {
		errors.push(
			`${where}: 'id' must be alphanumeric, dot, dash or underscore (got '${node.id}')`,
		);
	}
	if (node.tags && !Array.isArray(node.tags))
		errors.push(`${where}: 'tags' must be an array`);
	return errors;
}

export async function loadConfig(path = DEFAULT_PATH): Promise<HubConfig> {
	const file = Bun.file(path);

	let raw: RawConfig = {};
	if (await file.exists()) {
		try {
			raw = (await file.json()) as RawConfig;
		} catch (err) {
			throw new Error(
				`${path} is not valid JSON: ${err instanceof Error ? err.message : err}`,
			);
		}
	} else if (path !== DEFAULT_PATH) {
		// An explicit --config that isn't there is a mistake; the default missing
		// just means "run with defaults", which is a perfectly good first launch.
		throw new Error(`config not found at ${path}`);
	}

	const nodes = raw.nodes ?? [];
	const errors = nodes.flatMap(validateNode);
	const ids = new Set<string>();
	for (const node of nodes) {
		if (ids.has(node.id)) errors.push(`duplicate node id '${node.id}'`);
		ids.add(node.id);
	}
	if (errors.length)
		throw new Error(`invalid ${path}:\n  - ${errors.join("\n  - ")}`);

	const telemetryIntervalMs = Math.max(1000, raw.telemetryIntervalMs ?? 3000);

	return {
		port: raw.port ?? 3000,
		host: raw.host ?? "127.0.0.1",
		token: resolveSecret(raw.token),
		nodeToken: resolveSecret(raw.nodeToken),
		allowUnknownNodes: raw.allowUnknownNodes ?? true,
		dbPath: raw.dbPath ?? "./stats.db",
		retentionHours: raw.retentionHours ?? 24,
		telemetryIntervalMs,
		// Three missed ticks, never less than 15s, so a slow box isn't declared dead.
		nodeTimeoutMs: Math.max(
			raw.nodeTimeoutMs ?? telemetryIntervalMs * 3,
			15_000,
		),
		terminal: raw.terminal ?? true,
		embeddedNode: raw.embeddedNode ?? false,
		nodes: nodes.map((node) => ({
			...node,
			token: resolveSecret(node.token) ?? undefined,
		})),
	};
}

/** Strips secrets before a node override is sent to the browser. */
export function publicNode(node: NodeOverride): Omit<NodeOverride, "token"> {
	const { token: _token, ...rest } = node;
	return rest;
}
