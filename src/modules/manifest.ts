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

export const MODULE_IDS = [
	"system",
	"projects",
	"docker",
	"systemd",
	"processes",
	"ports",
	"logs",
	"terminal",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

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

export const MODULES: Record<ModuleId, ModuleManifest> = {
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

export const MODULE_LIST: ModuleManifest[] = MODULE_IDS.map(
	(id) => MODULES[id],
);

/** Action name → the module that owns it. Actions not listed here are core. */
const OWNER_BY_ACTION = new Map<string, ModuleId>(
	MODULE_LIST.flatMap((module) =>
		module.actions.map((action) => [action, module.id] as [string, ModuleId]),
	),
);

export function moduleForAction(action: string): ModuleId | null {
	return OWNER_BY_ACTION.get(action) ?? null;
}

/** Reads a module set the way every caller wants to: absent means off. */
export function moduleOn(
	modules: ModuleSet | null | undefined,
	id: ModuleId,
): boolean {
	return modules?.[id] === true;
}

export function isModuleId(value: string): value is ModuleId {
	return (MODULE_IDS as readonly string[]).includes(value);
}

/**
 * Turns whatever the config asked for into a complete set. Unknown ids are
 * reported rather than ignored — a typo in `modules` should not silently mean
 * "the default", which is the failure mode of every feature-flag file ever
 * written.
 */
export function resolveModules(
	requested: Record<string, boolean> | undefined,
	errors: string[] = [],
): ModuleSet {
	const resolved: ModuleSet = {};
	for (const module of MODULE_LIST)
		resolved[module.id] = module.enabledByDefault;

	for (const [key, value] of Object.entries(requested ?? {})) {
		if (!isModuleId(key)) {
			errors.push(
				`unknown module '${key}' — known modules are ${MODULE_IDS.join(", ")}`,
			);
			continue;
		}
		if (MODULES[key].required && value === false) {
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
	for (const module of MODULE_LIST) {
		narrowed[module.id] = moduleOn(node, module.id) && hub[module.id] !== false;
	}
	return narrowed;
}

/** The ids that are on, in manifest order — the order tabs and faces appear. */
export function enabledModules(modules: ModuleSet): ModuleId[] {
	return MODULE_IDS.filter((id) => moduleOn(modules, id));
}
