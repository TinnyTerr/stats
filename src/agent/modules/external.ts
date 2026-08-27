import { pathToFileURL } from "node:url";
import {
	emptyReport,
	type ModuleReport,
	type ModuleValue,
	toModuleManifest,
} from "../../modules/external.ts";
import type { ModuleHost } from "../../modules/host.ts";
import { currentPlatform, resolveEntry } from "../../modules/platform.ts";
import type { InstalledModule } from "../../modules/store.ts";
import { RemoteError } from "../../proto/link.ts";
import type { NodeModule, NodeModuleContext } from "./mod.ts";
import { requireControl } from "./mod.ts";

/**
 * The node half of an installed module.
 *
 * What a module author writes is deliberately smaller than what the builtins
 * get: a gated host, its own settings, and request/response actions. No
 * supervisor, no terminal manager, no streams — those are the parts of the node
 * that can be turned against the machine it runs on, and an installed module
 * asking for them should be a pull request against this repo instead.
 */

export interface ExternalContext {
	/** the same gated surface every module gets — see src/modules/host.ts */
	host: ModuleHost;
	/** the node's switch for anything that changes state */
	control: boolean;
	/** this module's block from the node's `moduleSettings` */
	settings: Record<string, unknown>;
	/** the module's own directory, for files it ships with */
	dir: string;
}

export type ExternalAction = (
	params: Record<string, unknown>,
	ctx: ExternalContext,
) => Promise<unknown> | unknown;

/** The default export of a module's entry file. */
export interface ExternalNodeModule {
	available?(ctx: ExternalContext): Promise<boolean> | boolean;
	collect?(
		ctx: ExternalContext,
	): Promise<Partial<ModuleReport>> | Partial<ModuleReport>;
	actions?: Record<string, ExternalAction>;
}

/**
 * Caps. A module that reports a hundred thousand rows would be sent to every
 * browser several times a minute, so the frame is trimmed rather than the node
 * being taken down by someone else's bug.
 */
const MAX_ROWS = 500;
const MAX_VALUES = 64;
const MAX_TEXT = 512;

function value(raw: unknown): ModuleValue | undefined {
	if (raw === null) return null;
	switch (typeof raw) {
		case "boolean":
			return raw;
		case "number":
			return Number.isFinite(raw) ? raw : null;
		case "string":
			return raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}…` : raw;
		default:
			return undefined;
	}
}

function record(raw: unknown, limit: number): Record<string, ModuleValue> {
	if (!raw || typeof raw !== "object") return {};
	const out: Record<string, ModuleValue> = {};
	for (const [key, item] of Object.entries(raw as Record<string, unknown>)) {
		if (Object.keys(out).length >= limit) break;
		const clean = value(item);
		if (clean !== undefined) out[key] = clean;
	}
	return out;
}

/**
 * Everything crossing into a telemetry frame goes through here: the frame is
 * JSON on a wire and then props in a browser, and neither should ever see a
 * function, a cycle or a megabyte of string because a module returned one.
 */
export function sanitiseReport(raw: unknown): ModuleReport {
	if (!raw || typeof raw !== "object") return emptyReport();
	const source = raw as Partial<ModuleReport>;

	const rows: Record<string, ModuleValue>[] = [];
	for (const row of Array.isArray(source.rows) ? source.rows : []) {
		if (rows.length >= MAX_ROWS) break;
		rows.push(record(row, MAX_VALUES));
	}

	const status = source.status;
	const detail = typeof source.detail === "string" ? source.detail : null;

	return {
		values: record(source.values, MAX_VALUES),
		rows,
		status:
			status === "warn" || status === "crit" || status === "ok"
				? status
				: undefined,
		detail:
			detail && detail.length > MAX_TEXT ? detail.slice(0, MAX_TEXT) : detail,
	};
}

/**
 * Imports a module's entry and wraps it as an ordinary {@link NodeModule}, so
 * everything downstream — the grant check, the dispatch table, collection —
 * treats it exactly like docker or systemd.
 */
export async function toNodeModule(
	installed: InstalledModule,
	settings: Record<string, unknown> = {},
): Promise<NodeModule> {
	const id = installed.manifest.id;
	// The loader already dropped modules that don't declare this platform, so an
	// entry missing here means a manifest that declared one and shipped none.
	const platform = currentPlatform();
	const entryPath = resolveEntry(installed.manifest.entry, platform);
	if (!entryPath) {
		throw new Error(
			`module '${id}' has no entry for ${platform ?? process.platform}`,
		);
	}
	const entry = Bun.resolveSync(entryPath, installed.dir);
	const loaded = (await import(pathToFileURL(entry).href)) as {
		default?: ExternalNodeModule;
	};
	const impl = loaded.default;
	if (!impl || typeof impl !== "object") {
		throw new Error(
			`${entryPath} has no default export — a module entry exports { available?, collect?, actions? }`,
		);
	}

	const context = (ctx: NodeModuleContext): ExternalContext => ({
		host: ctx.host,
		control: ctx.control,
		settings,
		dir: installed.dir,
	});

	const actions: NodeModule["actions"] = {};
	for (const name of installed.manifest.actions) {
		const handler = impl.actions?.[name];
		actions[name] = async (req, ctx) => {
			if (!handler) {
				throw new RemoteError(
					"unknown_action",
					`module '${id}' declares '${name}' but its entry doesn't implement it`,
				);
			}
			// Declared actions change something by definition — a module that only
			// reports doesn't need one — so they all sit behind the control switch.
			requireControl(ctx);
			return await handler(
				(req.params ?? {}) as Record<string, unknown>,
				context(ctx),
			);
		};
	}

	return {
		manifest: toModuleManifest(installed.manifest),

		available: impl.available
			? async (ctx) => Boolean(await impl.available!(context(ctx)))
			: undefined,

		collect: impl.collect
			? async (ctx) => ({
					extras: { [id]: sanitiseReport(await impl.collect!(context(ctx))) },
				})
			: undefined,

		actions: Object.keys(actions).length ? actions : undefined,
	};
}

/**
 * Loads every installed module, keeping going past the ones that throw. A
 * module whose entry doesn't import is a module that isn't there, reported the
 * same way as one whose host can't serve it.
 */
export async function loadExternalModules(
	installed: readonly InstalledModule[],
	settings: Record<string, Record<string, unknown>> = {},
): Promise<{ modules: NodeModule[]; notes: string[] }> {
	const modules: NodeModule[] = [];
	const notes: string[] = [];

	for (const module of installed) {
		try {
			modules.push(
				await toNodeModule(module, settings[module.manifest.id] ?? {}),
			);
		} catch (err) {
			notes.push(
				`${module.manifest.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	return { modules, notes };
}
