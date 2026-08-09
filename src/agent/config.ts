import { readFile } from "node:fs/promises";
import os from "node:os";
import { DEFAULT_SOURCES } from "./projects.ts";

/**
 * How a node is told where its hub is and what it may do. Precedence is the
 * usual one: command-line flags beat environment variables, which beat
 * /etc/stats/agent.json — so the installer can write a file and an operator can
 * still override it for one run.
 */

export interface AgentConfig {
	/** ws:// or wss:// URL of the hub's node endpoint */
	hubUrl: string;
	/** shared secret presented in Hello */
	token: string | null;
	/** stable id for this machine; the hub keys everything on it */
	id: string;
	name: string;
	tags: string[];
	/** what the node asks for; the hub may hand back a slower interval */
	telemetryIntervalMs: number;
	/** allow the dashboard to open shells here */
	terminal: boolean;
	/** allow start/stop/restart of projects, units and containers */
	control: boolean;
	/** projects files/directories, in load order */
	projectPaths: string[];
}

const DEFAULT_CONFIG_PATH =
	process.env.STATS_AGENT_CONFIG ?? "/etc/stats/agent.json";

interface RawAgentConfig {
	hub?: string;
	hubUrl?: string;
	token?: string | null;
	id?: string;
	name?: string;
	tags?: string[];
	telemetryIntervalMs?: number;
	terminal?: boolean;
	control?: boolean;
	projects?: string | string[];
}

/**
 * Accepts anything that identifies the hub — `hub.lan`, `hub.lan:3000`,
 * `http://hub.lan:3000`, `wss://hub.lan/node` — and returns the WebSocket URL
 * of its node endpoint.
 */
export function normaliseHubUrl(input: string): string {
	let raw = input.trim();
	if (!raw) throw new Error("hub URL is empty");
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `ws://${raw}`;

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`'${input}' is not a valid hub URL`);
	}

	if (url.protocol === "http:") url.protocol = "ws:";
	else if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`hub URL must be ws:// or wss:// (got ${url.protocol}//)`);
	}

	if (url.pathname === "/" || url.pathname === "") url.pathname = "/node";
	if (!url.port) url.port = url.protocol === "wss:" ? "443" : "3000";
	return url.toString();
}

/**
 * A node's identity has to survive reboots and IP changes, so it prefers
 * /etc/machine-id — the one thing on a Linux box that is stable and unique —
 * falling back to the hostname.
 */
async function defaultNodeId(): Promise<string> {
	const machineId = await readFile("/etc/machine-id", "utf8").catch(() => null);
	const trimmed = machineId?.trim();
	if (trimmed) return trimmed.slice(0, 16);
	return (
		os
			.hostname()
			.replace(/[^a-zA-Z0-9_-]/g, "-")
			.toLowerCase() || "node"
	);
}

function envBool(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined) return fallback;
	return !/^(0|false|no|off)$/i.test(value.trim());
}

export interface AgentOverrides {
	hub?: string;
	token?: string;
	id?: string;
	name?: string;
	tags?: string;
	interval?: string;
	terminal?: boolean;
	control?: boolean;
	projects?: string;
	config?: string;
}

export async function loadAgentConfig(
	flags: AgentOverrides = {},
): Promise<AgentConfig> {
	const path = flags.config ?? DEFAULT_CONFIG_PATH;
	let file: RawAgentConfig = {};
	const configFile = Bun.file(path);
	if (await configFile.exists()) {
		try {
			file = (await configFile.json()) as RawAgentConfig;
		} catch (err) {
			throw new Error(
				`${path} is not valid JSON: ${err instanceof Error ? err.message : err}`,
			);
		}
	} else if (flags.config) {
		throw new Error(`agent config not found at ${path}`);
	}

	const hub = flags.hub ?? process.env.STATS_HUB ?? file.hubUrl ?? file.hub;
	if (!hub) {
		throw new Error(
			"no hub to connect to. Pass --hub ws://hub:3000, set STATS_HUB, or write hubUrl into /etc/stats/agent.json",
		);
	}

	const interval = Number(
		flags.interval ??
			process.env.STATS_INTERVAL ??
			file.telemetryIntervalMs ??
			3000,
	);
	const tags = flags.tags ?? process.env.STATS_TAGS;
	const projects =
		flags.projects ?? process.env.STATS_PROJECTS ?? file.projects;

	return {
		hubUrl: normaliseHubUrl(hub),
		token: flags.token ?? process.env.STATS_NODE_TOKEN ?? file.token ?? null,
		id:
			flags.id ??
			process.env.STATS_NODE_ID ??
			file.id ??
			(await defaultNodeId()),
		name:
			flags.name ?? process.env.STATS_NODE_NAME ?? file.name ?? os.hostname(),
		tags: tags
			? tags
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: (file.tags ?? []),
		// A node that reports faster than once a second is a load generator, not a monitor.
		telemetryIntervalMs: Number.isFinite(interval)
			? Math.max(1000, interval)
			: 3000,
		terminal:
			flags.terminal ?? envBool("STATS_TERMINAL", file.terminal ?? true),
		control: flags.control ?? envBool("STATS_CONTROL", file.control ?? true),
		projectPaths: projects
			? (Array.isArray(projects) ? projects : projects.split(":")).filter(
					Boolean,
				)
			: DEFAULT_SOURCES,
	};
}
