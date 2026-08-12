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

/** The modules that ship in this repo. Installed ones are ids too — see below. */
export const BUILTIN_MODULE_IDS = [
	"system",
	"projects",
	"docker",
	"systemd",
	"proxmox",
	"processes",
	"ports",
	"logs",
	"terminal",
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

export function isPrivilegedGrant(grant: ModuleGrant): boolean {
	return PRIVILEGED_GRANTS.includes(grant);
}

export interface ModuleManifest {
	id: ModuleId;
	label: string;
	description: string;
	/** the dashboard has nothing to draw without it, so it can't be switched off */
	required: boolean;
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
			"CPU, memory, disks, network, temperatures and the host's identity.",
		required: true,
		enabledByDefault: true,
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
		// `exec` is pvesh on the hypervisor itself; `http` is the API token path for
		// a node watching a PVE host it isn't running on.
		grants: ["read", "exec", "http"],
		actions: ["guest.action"],
		tab: "guests",
		provides: ["proxmox", "guests"],
	},
	processes: {
		id: "processes",
		label: "Processes",
		description: "The busiest processes on the host.",
		required: false,
		enabledByDefault: true,
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
		grants: ["pty"],
		actions: ["terminal.open", "terminal.resize", "terminal.close"],
		tab: "terminal",
		provides: [],
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
