import { readFile } from "node:fs/promises";
import os from "node:os";
import { toModuleManifest } from "../modules/external.ts";
import {
	BUILTIN_MODULE_IDS,
	isBuiltinModuleId,
	MODULES,
	type ModuleSet,
	resolveModules,
} from "../modules/manifest.ts";
import { type InstalledModule, installedModules } from "../modules/store.ts";
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
	/** which modules to load — docker, systemd, terminal and the rest */
	modules: ModuleSet;
	/** allow start/stop/restart of projects, units and containers */
	control: boolean;
	/**
	 * Let the hub ask this node to replace its own binary. Off unless asked for:
	 * everything else the hub can do is bounded by what's already installed, and
	 * this one changes what's installed. Absent means off.
	 */
	allowRemoteUpdate?: boolean;
	/** projects files/directories, in load order */
	projectPaths: string[];
	/** module ids permitted to hold the privileged exec/pty grants */
	trustedModules: string[];
	/** what `stats modules install` put in the store, ready to load */
	installed?: InstalledModule[];
	/** per-module configuration, keyed by module id — installed modules only */
	moduleSettings?: Record<string, Record<string, unknown>>;
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
	allowRemoteUpdate?: boolean;
	projects?: string | string[];
	modules?: Record<string, boolean>;
	trustedModules?: string[];
	moduleSettings?: Record<string, Record<string, unknown>>;
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

/**
 * Reads a module list the way an operator would write one on a command line.
 *
 *   "docker,systemd"    exactly these (plus the required ones)
 *   "-docker,-terminal" everything the defaults give you, minus these
 *
 * Mixing the two forms is allowed and means what it looks like: the positive
 * entries are the set, and the negative ones are then removed from it.
 */
export function parseModuleList(
	spec: string,
	/** ids of installed modules, which "only these" also has to be able to drop */
	known: readonly string[] = [],
): Record<string, boolean> {
	const entries = spec
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);

	const positives = entries.filter((entry) => !/^[-!]|^no-/.test(entry));
	const modules: Record<string, boolean> = {};

	// An explicit "these ones" starts from nothing; a list of removals starts
	// from whatever the manifest defaults to. The modules that can't be turned
	// off are left alone either way — naming one is fine, omitting it isn't a
	// request to remove it.
	if (positives.length) {
		for (const id of BUILTIN_MODULE_IDS)
			if (!MODULES[id].required) modules[id] = false;
		// An installed module isn't in the builtin table, so "only these" has to
		// switch it off by name or it would survive a list it wasn't on.
		for (const id of known) modules[id] = false;
	}

	for (const entry of entries) {
		const off = /^[-!]|^no-/.test(entry);
		const id = entry.replace(/^[-!]|^no-/, "");
		// A required module named positively is a no-op; named negatively it is a
		// mistake, and resolveModules is where that gets reported.
		if (!off && isBuiltinModuleId(id) && MODULES[id].required) continue;
		modules[id] = !off;
	}
	return modules;
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
	allowRemoteUpdate?: boolean;
	projects?: string;
	config?: string;
	/** "docker,systemd" or "-terminal"; see parseModuleList */
	modules?: string;
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

	// What `stats modules install` left in the store counts as known from here
	// on: it can be named in --modules, switched off in agent.json, and it gets
	// the same "unknown module" error for a typo as a builtin does.
	const installed = await installedModules().catch(() => []);
	const installedManifests = installed.map((module) =>
		toModuleManifest(module.manifest),
	);

	// Three ways to ask for a module set, in the usual precedence. --no-terminal
	// predates modules and still works: it is the terminal module's switch.
	const spec = flags.modules ?? process.env.STATS_MODULES;
	const requested: Record<string, boolean> = {
		...(file.modules ?? {}),
		...(spec
			? parseModuleList(
					spec,
					installedManifests.map((module) => module.id),
				)
			: {}),
	};
	const terminal = flags.terminal ?? envBool("STATS_TERMINAL", true);
	if (flags.terminal !== undefined || process.env.STATS_TERMINAL !== undefined)
		requested.terminal = terminal;
	else if (file.terminal !== undefined) requested.terminal ??= file.terminal;

	const moduleErrors: string[] = [];
	const modules = resolveModules(requested, moduleErrors, installedManifests);
	if (moduleErrors.length) {
		throw new Error(`invalid modules:\n  - ${moduleErrors.join("\n  - ")}`);
	}

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
		modules,
		control: flags.control ?? envBool("STATS_CONTROL", file.control ?? true),
		allowRemoteUpdate:
			flags.allowRemoteUpdate ??
			envBool("STATS_ALLOW_REMOTE_UPDATE", file.allowRemoteUpdate ?? false),
		projectPaths: projects
			? (Array.isArray(projects) ? projects : projects.split(":")).filter(
					Boolean,
				)
			: DEFAULT_SOURCES,
		// The modules in this repo are the ones trusted with exec and pty; a
		// module from anywhere else has to be named here to get either.
		trustedModules: file.trustedModules ?? [...BUILTIN_MODULE_IDS],
		installed,
		moduleSettings: file.moduleSettings ?? {},
	};
}
