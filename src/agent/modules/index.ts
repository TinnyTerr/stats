import {
	checkGrants,
	createModuleHost,
	type ModulePolicy,
} from "../../modules/host.ts";
import {
	type ModuleId,
	type ModuleSet,
	moduleForAction,
	moduleOn,
} from "../../modules/manifest.ts";
import type { InboundRequest } from "../../proto/link.ts";
import { RemoteError } from "../../proto/link.ts";
import { dockerModule } from "./docker.ts";
import { logsModule } from "./logs.ts";
import type { NodeModule, NodeModuleContext, TelemetryParts } from "./mod.ts";
import { portsModule, processesModule } from "./processes.ts";
import { projectsModule } from "./projects.ts";
import { proxmoxModule } from "./proxmox.ts";
import { systemModule } from "./system.ts";
import { systemdModule } from "./systemd.ts";
import { terminalModule } from "./terminal.ts";

/**
 * Everything that ships in the box. Loading is three gates in a row — the
 * config asked for it, the policy allows the grants it wants, and the host can
 * actually serve it — and a module that fails any of them is simply absent:
 * no tab, no actions, no empty section in telemetry.
 */

export const BUILTIN_MODULES: NodeModule[] = [
	systemModule,
	projectsModule,
	dockerModule,
	systemdModule,
	proxmoxModule,
	processesModule,
	portsModule,
	logsModule,
	terminalModule,
];

/** A module action with its own context already bound to it. */
export type BoundHandler = (req: InboundRequest) => Promise<unknown>;

export interface LoadedModules {
	/** what the node ended up running, in manifest order */
	active: NodeModule[];
	/** what it announces to the hub */
	set: ModuleSet;
	/** one line per module that isn't here, in the order they were considered */
	notes: string[];
	/** the handler for an action, or an explanation of why there isn't one */
	dispatch(action: string): BoundHandler | null;
	/** every active module's slice of a frame, plus whatever failed collecting */
	collect(): Promise<{ parts: TelemetryParts; errors: Record<string, string> }>;
}

export async function loadModules(
	ctx: Omit<NodeModuleContext, "host">,
	requested: ModuleSet,
	policy: ModulePolicy,
	modules: NodeModule[] = BUILTIN_MODULES,
): Promise<LoadedModules> {
	const active: NodeModule[] = [];
	const set: ModuleSet = {};
	const notes: string[] = [];
	const contexts = new Map<ModuleId, NodeModuleContext>();

	for (const module of modules) {
		const { id, label, required } = module.manifest;
		set[id] = false;

		if (!required && !moduleOn(requested, id)) {
			notes.push(`${id}: disabled by config`);
			continue;
		}

		const denied = checkGrants(module.manifest, policy);
		if (denied.length) {
			notes.push(`${id}: ${denied.join("; ")}`);
			continue;
		}

		const scoped: NodeModuleContext = {
			...ctx,
			host: createModuleHost(module.manifest, policy),
		};

		try {
			if (module.available && !(await module.available(scoped))) {
				notes.push(`${id}: ${label} is not available on this host`);
				continue;
			}
		} catch (err) {
			notes.push(
				`${id}: availability check failed — ${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}

		contexts.set(id, scoped);
		active.push(module);
		set[id] = true;
	}

	const handlers = new Map<string, BoundHandler>();
	for (const module of active) {
		for (const [action, handler] of Object.entries(module.actions ?? {})) {
			const scoped = contexts.get(module.manifest.id)!;
			handlers.set(action, (req) => handler(req, scoped));
		}
	}

	return {
		active,
		set,
		notes,

		dispatch(action) {
			const handler = handlers.get(action);
			if (handler) return handler;
			// A known action belonging to a module that isn't loaded deserves a
			// better answer than "no such action" — the caller asked for something
			// real that this node chose not to offer. Installed modules aren't in
			// the builtin table, so their manifests come along too.
			const owner = moduleForAction(
				action,
				modules.map((module) => module.manifest),
			);
			if (owner) {
				throw new RemoteError(
					"module_disabled",
					`'${action}' needs the '${owner}' module, which is not enabled on this node`,
				);
			}
			return null;
		},

		async collect() {
			const parts: TelemetryParts = {};
			const errors: Record<string, string> = {};

			await Promise.all(
				active.map(async (module) => {
					if (!module.collect) return;
					const id = module.manifest.id;
					try {
						const slice = await module.collect(contexts.get(id)!);
						// Every module owns different keys except this one: `extras` is
						// where installed modules put their reports, so it merges rather
						// than the last module to finish winning.
						const { extras, ...rest } = slice;
						Object.assign(parts, rest);
						if (extras) parts.extras = { ...parts.extras, ...extras };
					} catch (err) {
						// Collectors degrade, never throw the snapshot away.
						errors[id] = err instanceof Error ? err.message : String(err);
					}
				}),
			);

			return { parts, errors };
		},
	};
}
