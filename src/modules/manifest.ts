/**
 * The module manifest: one row per capability the fleet is built out of.
 *
 * Docker, systemd, terminals and the rest are not special cases wired through
 * the codebase — they are modules a node loads, and everything downstream
 * follows from this table: which collectors run, which control actions exist,
 * which tab appears in the detail pane and which faces the node card can show.
 *
 * Node, hub and browser all import this file, so "is docker on here?" has one
 * answer in three places. The node decides what it loads; the hub can only
 * narrow that (see {@link narrowModules}); the browser renders whatever
 * survived.
 */

import {
	currentPlatform,
	type Platform,
	platformNote,
	supportsPlatform,
} from "./platform.ts";

/** The modules that ship in this repo. Installed ones are ids too — see below. */
export const BUILTIN_MODULE_IDS = [
	"system",
	"projects",
	"docker",
	"systemd",
	"proxmox",
	"pihole",
	"processes",
	"ports",
	"logs",
	"terminal",
	"ca",
] as const;

export type BuiltinModuleId = (typeof BUILTIN_MODULE_IDS)[number];

/**
 * A module id is a string, not a union, because a node can install modules from
 * a git repository (see src/modules/store.ts) and the hub and browser have to
 * be able to name one they have never heard of. {@link BuiltinModuleId} is the
 * closed set for the code in this repo.
 */
export type ModuleId = string;

/** Which modules a peer has, keyed by id. Absent ids read as off. */
export type ModuleSet = Partial<Record<ModuleId, boolean>>;

/**
 * What a module is allowed to reach out to. The first four are the open set:
 * any module may ask for them, and {@link ModuleHost} is the only way to use
 * them. `exec` and `pty` hand over the machine itself, so they are privileged —
 * a module holding one has to be trusted explicitly.
 */
export type ModuleGrant = "read" | "http" | "ws" | "socket" | "exec" | "pty";

export const OPEN_GRANTS: readonly ModuleGrant[] = [
	"read",
	"http",
	"ws",
	"socket",
];

export const PRIVILEGED_GRANTS: readonly ModuleGrant[] = ["exec", "pty"];

/** Every grant there is. What a root node hands out — see `rootPolicy()`. */
export const ALL_GRANTS: readonly ModuleGrant[] = [
	...OPEN_GRANTS,
	...PRIVILEGED_GRANTS,
];

export function isPrivilegedGrant(grant: ModuleGrant): boolean {
	return PRIVILEGED_GRANTS.includes(grant);
}

export interface ModuleManifest {
	id: ModuleId;
	label: string;
	description: string;
	/**
	 * The node's identity — hostname and addresses — is the only thing the core
	 * reports; a required module is one the *dashboard* can't lay out a card
	 * without. Nothing is required today, and new modules should not be: a node
	 * on a platform none of them support is a valid node with an empty card.
	 */
	required: boolean;
	/**
	 * Which hosts this module runs on, as `process.platform` values. Empty means
	 * portable — see src/modules/platform.ts for why that's the default rather
	 * than an omission.
	 */
	platforms: Platform[];
	/** loaded unless the config says otherwise */
	enabledByDefault: boolean;
	/** everything this module may touch; enforced by src/modules/host.ts */
	grants: ModuleGrant[];
	/** control actions it owns — the hub refuses these when the module is off */
	actions: string[];
	/** the detail tab it contributes, null when it draws no tab of its own */
	tab: string | null;
	/** telemetry fields it fills in, for the "why is this empty?" answer */
	provides: string[];
}

export const MODULES: Record<BuiltinModuleId, ModuleManifest> = {
	system: {
		id: "system",
		label: "System",
		description:
			"CPU, memory, disks, network and temperatures, from the host's own probe.",
		// Not required: the node core reports hostname and addresses, and a host
		// with no probe for its platform still connects and still runs every
		// other module. See src/collect/probe.ts.
		required: false,
		enabledByDefault: true,
		// One module, one probe per platform. freebsd has no probe yet, and
		// declaring it here would mean announcing a tab that never fills in.
		platforms: ["linux", "darwin", "win32"],
		grants: ["read", "exec"],
		actions: ["facts.refresh"],
		tab: "overview",
		provides: ["stats", "facts"],
	},
	projects: {
		id: "projects",
		label: "Projects",
		description:
			"Runs and supervises the processes declared in the projects file.",
		required: false,
		enabledByDefault: true,
		// Spawning and watching a child process is the one thing every platform
		// agrees on, so this stays portable.
		platforms: [],
		grants: ["read", "http", "exec"],
		actions: ["projects.list", "projects.reload", "project.action"],
		tab: "projects",
		provides: ["projects"],
	},
	docker: {
		id: "docker",
		label: "Docker",
		description: "Containers from the engine API over its unix socket.",
		required: false,
		enabledByDefault: true,
		// The engine speaks the same HTTP either way, but reaching it on Windows
		// is a named pipe rather than a unix socket — a `socket` grant that
		// doesn't exist yet.
		platforms: ["linux", "darwin"],
		grants: ["socket"],
		actions: ["container.action"],
		tab: "containers",
		provides: ["containers"],
	},
	systemd: {
		id: "systemd",
		label: "systemd",
		description: "Unit list, system state and per-unit detail.",
		required: false,
		enabledByDefault: true,
		platforms: ["linux"],
		grants: ["read", "exec"],
		actions: ["unit.show", "unit.action"],
		tab: "services",
		provides: ["systemd", "units"],
	},
	proxmox: {
		id: "proxmox",
		label: "Proxmox",
		description:
			"VMs and containers from a Proxmox VE host, via pvesh or its API.",
		required: false,
		enabledByDefault: true,
		// Portable because the API-token path is just HTTP: a node anywhere can
		// watch a PVE host. `pvesh` is the local shortcut, and availability —
		// not the platform — is what decides between them.
		platforms: [],
		// `exec` is pvesh on the hypervisor itself; `http` is the API token path for
		// a node watching a PVE host it isn't running on.
		grants: ["read", "exec", "http"],
		actions: ["guest.action"],
		tab: "guests",
		provides: ["proxmox", "guests"],
	},
	pihole: {
		id: "pihole",
		label: "Pi-hole",
		description: "Queries, blocking and clients from a Pi-hole's own API.",
		required: false,
		enabledByDefault: true,
		// Portable, and portable for the reason the default exists: this module is
		// made of HTTP calls. The node need not be the Pi-hole, and usually isn't.
		platforms: [],
		// `exec` is `pihole api` on the Pi-hole itself, which is only reachable by
		// root and needs no credentials; `http` is every other node's way in.
		grants: ["http", "exec"],
		actions: ["pihole.blocking", "pihole.dns"],
		tab: "pihole",
		provides: ["pihole"],
	},
	processes: {
		id: "processes",
		label: "Processes",
		description: "The busiest processes on the host.",
		required: false,
		enabledByDefault: true,
		// `ps` and /proc. Windows wants a different probe entirely.
		platforms: ["linux", "darwin"],
		grants: ["read", "exec"],
		actions: [],
		tab: "processes",
		provides: ["processes"],
	},
	ports: {
		id: "ports",
		label: "Ports",
		description: "What is listening, and which process owns it.",
		required: false,
		enabledByDefault: true,
		platforms: ["linux", "darwin"],
		grants: ["read", "exec"],
		actions: [],
		tab: "ports",
		provides: ["ports"],
	},
	logs: {
		id: "logs",
		label: "Logs",
		description: "Tails journal units, containers, files and project output.",
		required: false,
		enabledByDefault: true,
		// Files and project output work anywhere; journalctl is gated by
		// availability, not by platform, so the module itself is portable.
		platforms: [],
		grants: ["read", "socket", "exec"],
		actions: ["logs.tail"],
		tab: "logs",
		provides: [],
	},
	terminal: {
		id: "terminal",
		label: "Terminal",
		description: "An interactive shell on the host, over the same socket.",
		required: false,
		enabledByDefault: true,
		platforms: ["linux", "darwin", "win32"],
		grants: ["pty"],
		actions: ["terminal.open", "terminal.resize", "terminal.close"],
		tab: "terminal",
		provides: [],
	},
	ca: {
		id: "ca",
		label: "Local CA",
		description:
			"Trusts the fleet's local CA in the host's system certificate store.",
		required: false,
		enabledByDefault: true,
		// Every platform has a trust store; which command reaches it is a
		// per-platform installer, not a reason to leave one out.
		platforms: ["linux", "darwin", "win32"],
		grants: ["read", "exec"],
		actions: ["ca.status"],
		tab: null,
		provides: ["ca"],
	},
};

/** The builtins, in the order their tabs and faces appear. */
export const MODULE_LIST: ModuleManifest[] = BUILTIN_MODULE_IDS.map(
	(id) => MODULES[id],
);

/** Action name → the module that owns it. Actions not listed here are core. */
const OWNER_BY_ACTION = new Map<string, ModuleId>(
	MODULE_LIST.flatMap((module) =>
		module.actions.map((action) => [action, module.id] as [string, ModuleId]),
	),
);

/**
 * An installed module's actions aren't in the builtin table, so callers that
 * might see one — the node's dispatcher, the hub's relay — pass the manifests
 * they know about alongside.
 */
export function moduleForAction(
	action: string,
	extra: readonly ModuleManifest[] = [],
): ModuleId | null {
	const owner = OWNER_BY_ACTION.get(action);
	if (owner) return owner;
	for (const module of extra) {
		if (module.actions.includes(action)) return module.id;
	}
	return null;
}

/** Reads a module set the way every caller wants to: absent means off. */
export function moduleOn(
	modules: ModuleSet | null | undefined,
	id: ModuleId,
): boolean {
	return modules?.[id] === true;
}

export function isBuiltinModuleId(value: string): value is BuiltinModuleId {
	return (BUILTIN_MODULE_IDS as readonly string[]).includes(value);
}

/**
 * Turns whatever the config asked for into a complete set. Unknown ids are
 * reported rather than ignored — a typo in `modules` should not silently mean
 * "the default", which is the failure mode of every feature-flag file ever
 * written.
 *
 * `installed` is what a node found in its module store; naming one is as valid
 * as naming a builtin, and naming something neither is the typo this catches.
 */
export function resolveModules(
	requested: ModuleSet | undefined,
	errors: string[] = [],
	installed: readonly ModuleManifest[] = [],
): ModuleSet {
	const known = new Map<string, ModuleManifest>();
	for (const module of [...MODULE_LIST, ...installed])
		known.set(module.id, module);

	const resolved: ModuleSet = {};
	for (const module of known.values())
		resolved[module.id] = module.enabledByDefault;

	for (const [key, value] of Object.entries(requested ?? {})) {
		// A key spread in from another set but never actually set says nothing
		// either way, and must not read as "on".
		if (value === undefined) continue;
		const module = known.get(key);
		if (!module) {
			errors.push(
				`unknown module '${key}' — known modules are ${[...known.keys()].join(", ")}`,
			);
			continue;
		}
		if (module.required && value === false) {
			errors.push(`module '${key}' is required and cannot be disabled`);
			continue;
		}
		resolved[key] = value !== false;
	}
	return resolved;
}

/**
 * The hub's half of the rule that runs through this whole codebase: it may take
 * a module away from a node, never hand one back. A node that didn't load
 * docker stays without docker no matter what hub.json says.
 */
export function narrowModules(node: ModuleSet, hub: ModuleSet): ModuleSet {
	const narrowed: ModuleSet = {};
	// The node's own keys, not the builtin table: a module it installed is one
	// the hub has never heard of, and narrowing must still be able to switch it
	// off across the fleet.
	const ids = new Set([
		...(BUILTIN_MODULE_IDS as readonly string[]),
		...Object.keys(node),
	]);
	for (const id of ids) {
		narrowed[id] = moduleOn(node, id) && hub[id] !== false;
	}
	return narrowed;
}

/**
 * The ids that are on, builtins first in manifest order and installed modules
 * after them — the order tabs and faces appear.
 */
export function enabledModules(modules: ModuleSet): ModuleId[] {
	const builtin = BUILTIN_MODULE_IDS.filter((id) => moduleOn(modules, id));
	const installed = Object.keys(modules)
		.filter((id) => moduleOn(modules, id) && !isBuiltinModuleId(id))
		.sort();
	return [...builtin, ...installed];
}

/* ---------- platform ---------- */

/**
 * Whether a module's declaration allows it to run here. This is the *stated*
 * answer, not the working one — a module can name a platform and still be
 * unavailable on it (no docker socket, no PVE). The loader asks this first
 * because it is free and needs no host access.
 *
 * The hub and the browser call it too, with a node's platform rather than their
 * own, which is why the platform is a parameter and not read from the process.
 */
export function moduleRunsOn(
	manifest: ModuleManifest,
	platform: Platform | null = currentPlatform(),
): boolean {
	return supportsPlatform(manifest.platforms, platform);
}

/** The line the CLI and the dashboard show for a module that can't run here. */
export function modulePlatformNote(
	manifest: ModuleManifest,
	platform: Platform | null = currentPlatform(),
): string {
	return platformNote(manifest.id, manifest.platforms, platform);
}

/**
 * The builtins a given platform can run, which is what the hub's module page
 * lists for a node before that node has ever reported its set.
 */
export function modulesForPlatform(
	platform: Platform | null,
): ModuleManifest[] {
	return MODULE_LIST.filter((module) => moduleRunsOn(module, platform));
}
