import { toModuleManifest } from "../modules/external.ts";
import {
	BUILTIN_MODULE_IDS,
	MODULE_LIST,
	type ModuleManifest,
	type ModuleSet,
	moduleOn,
	moduleRunsOn,
} from "../modules/manifest.ts";
import { isPlatform, type Platform } from "../modules/platform.ts";
import type { NodeCapabilities } from "../types.ts";

/**
 * Which modules a node should be running, decided on the hub.
 *
 * The rule used to be one-way: a node chose its modules and the hub could only
 * take them away. That was the right rule when the hub was just a screen. It
 * stops being the right rule once there is a page for managing a fleet, because
 * an operator who has already put the hub's token on a machine has already
 * decided the hub is trusted — asking them to then SSH to each node to turn a
 * module on is ceremony, not security.
 *
 * So the hub is the source of truth for *intent*, and this file is where that
 * intent is resolved. Two things keep it honest:
 *
 *   - **The node is still the source of truth for state.** The hub records what
 *     it wants; what a node announces is what is actually running. A module the
 *     hub asked for that hasn't appeared is `pending`, not on, and the page says
 *     so. This is the difference between a dashboard that lies and one that
 *     doesn't.
 *   - **Widening needs the node's consent, narrowing never does.** Turning a
 *     module off is a request a node always honours. Turning one *on* is the
 *     hub reaching into a machine, so it needs `allowHubModules` on the node,
 *     the same opt-in shape as `allowRemoteUpdate`. A node running as root sets
 *     it by default — it has already handed the machine over, and this hub is
 *     the source of truth for what it should be running — and any other node
 *     keeps the old rule exactly, with the page showing the intent as `refused`
 *     rather than silently doing nothing.
 *
 * The narrow-only path is not a fallback that decays over time; it is what runs
 * on every node that hasn't said otherwise.
 */

/** How one module stands on one node, once intent and reality are compared. */
export type ModuleState =
	/** the node is running it */
	| "on"
	/** the node isn't running it, and nothing asked it to */
	| "off"
	/** the hub asked for it and the node hasn't announced it yet */
	| "pending"
	/** the hub asked for it and the node won't take module direction */
	| "refused"
	/** the hub asked for it and the node's platform can't run it */
	| "unsupported"
	/** the hub's fleet-wide switch has it off everywhere */
	| "blocked";

export interface ModuleStatus {
	id: string;
	label: string;
	description: string;
	/** empty means portable — see src/modules/platform.ts */
	platforms: Platform[];
	state: ModuleState;
	/** what the node reported */
	running: boolean;
	/** what the hub asked for, or null when it has no opinion */
	desired: boolean | null;
	/** false when hub.json switched it off across the fleet */
	allowedByFleet: boolean;
	/** true for a module installed from a git repository rather than shipped */
	installed: boolean;
}

/** One node's row on the hub's module page. */
export interface NodeModuleView {
	nodeId: string;
	name: string;
	online: boolean;
	platform: Platform | null;
	/** whether this node accepts module direction from the hub */
	acceptsHubModules: boolean;
	modules: ModuleStatus[];
}

export interface ResolveInput {
	/** what the node announced it loaded, after the hub's own narrowing */
	announced: ModuleSet;
	/** the hub's per-node intent; a module absent here is one it has no view on */
	desired: Record<string, boolean>;
	/** hub.json's fleet-wide switches — subtractive, always */
	fleet: ModuleSet;
	/** the node opted in to the hub deciding its module set */
	acceptsHubModules: boolean;
	/** the node's platform, for saying "that module isn't for this host" */
	platform: Platform | null;
	/** manifests for modules this node installed rather than shipped with */
	externals?: NodeCapabilities["externals"];
}

/**
 * The manifests relevant to one node: the builtins, plus whatever it installed.
 * An installed module is not in this repo's table, so the only place its
 * manifest exists on the hub is the capabilities the node sent.
 */
export function manifestsFor(
	externals: NodeCapabilities["externals"] = [],
): ModuleManifest[] {
	return [...MODULE_LIST, ...externals.map(toModuleManifest)];
}

/** Resolves intent against reality for every module a node could run. */
export function resolveNodeModules(input: ResolveInput): ModuleStatus[] {
	const manifests = manifestsFor(input.externals);
	const known = new Map(manifests.map((m) => [m.id, m]));

	// A module can be announced or desired without the hub having a manifest for
	// it — an installed module on a node running a newer build, say. It still
	// gets a row: hiding it would make the page disagree with the node.
	const ids = new Set<string>([
		...manifests.map((m) => m.id),
		...Object.keys(input.announced),
		...Object.keys(input.desired),
	]);

	const statuses: ModuleStatus[] = [];
	for (const id of ids) {
		const manifest = known.get(id);
		const running = moduleOn(input.announced, id);
		// undefined is "the hub has no opinion"; false is "the hub wants it off".
		const wanted = input.desired[id];
		const desired = wanted === undefined ? null : wanted;
		const allowedByFleet = input.fleet[id] !== false;
		const supported = manifest
			? moduleRunsOn(manifest, input.platform)
			: // No manifest means no declaration to check; the node is the authority
				// on whether it can run its own installed module.
				true;

		statuses.push({
			id,
			label: manifest?.label ?? id,
			description: manifest?.description ?? "",
			platforms: manifest?.platforms ?? [],
			state: stateOf({
				running,
				desired,
				allowedByFleet,
				supported,
				acceptsHubModules: input.acceptsHubModules,
			}),
			running,
			desired,
			allowedByFleet,
			installed: !(BUILTIN_MODULE_IDS as readonly string[]).includes(id),
		});
	}

	// Builtins in manifest order, installed modules after, the way tabs appear.
	const order = new Map(MODULE_LIST.map((m, i) => [m.id, i]));
	return statuses.sort((a, b) => {
		const left = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
		const right = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
		return left - right || a.id.localeCompare(b.id);
	});
}

function stateOf(input: {
	running: boolean;
	desired: boolean | null;
	allowedByFleet: boolean;
	supported: boolean;
	acceptsHubModules: boolean;
}): ModuleState {
	// Reality first: whatever the hub wanted, a module that is running is on, and
	// the page must never claim otherwise.
	if (input.running) return "on";
	if (input.desired !== true) {
		// Not running and not asked for. "blocked" is worth distinguishing from
		// plain "off" — it's the one an operator can't fix from this node's row.
		return input.allowedByFleet ? "off" : "blocked";
	}

	// Asked for and absent: say which of the three reasons it is.
	if (!input.allowedByFleet) return "blocked";
	if (!input.supported) return "unsupported";
	if (!input.acceptsHubModules) return "refused";
	return "pending";
}

/**
 * The module set to hand a node in Welcome.
 *
 * This is *intent*, and only intent. A module the hub has no opinion about is
 * absent from the result rather than set to whatever the node happens to be
 * running — echoing the announcement back would turn "docker isn't installed
 * here" into "the hub wants docker off", and the node would then narrow its own
 * configuration to match a preference nobody expressed. The visible symptom was
 * a node reloading its modules once on every connection.
 *
 * Narrowing is unconditional. Widening is folded in only for a node that opted
 * in — for anyone else the result can't turn on a module they didn't already
 * announce, which is the old rule, unchanged and enforced on both sides.
 */
export function plannedModules(input: {
	announced: ModuleSet;
	desired: Record<string, boolean>;
	fleet: ModuleSet;
	acceptsHubModules: boolean;
}): ModuleSet {
	const ids = new Set<string>([
		...Object.keys(input.fleet),
		...Object.keys(input.desired),
	]);

	const planned: ModuleSet = {};
	for (const id of ids) {
		const running = moduleOn(input.announced, id);
		// undefined is "the hub has no opinion"; false is "the hub wants it off".
		const wanted = input.desired[id];
		const desired = wanted === undefined ? null : wanted;

		// The fleet switch is the outermost gate and answers first.
		if (input.fleet[id] === false) {
			planned[id] = false;
			continue;
		}
		if (desired === false) {
			planned[id] = false;
			continue;
		}
		if (desired === true) {
			planned[id] = input.acceptsHubModules ? true : running;
		}
		// No opinion: say nothing, and let the node's own configuration stand.
	}
	return planned;
}

/** The platform a node reported, if it is one this build knows. */
export function nodePlatform(
	value: string | null | undefined,
): Platform | null {
	return isPlatform(value) ? value : null;
}
