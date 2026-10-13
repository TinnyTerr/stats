import { describe, expect, test } from "bun:test";
import { mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../agent/config.ts";
import { loadModules as loadModulesOn } from "../agent/modules/index.ts";
import type { NodeModule, NodeModuleContext } from "../agent/modules/mod.ts";
import type { Supervisor } from "../agent/supervisor.ts";
import type { TerminalManager } from "../agent/terminal.ts";
import { createModuleHost } from "./host.ts";
import {
	BUILTIN_MODULE_IDS,
	MODULE_LIST,
	MODULES,
	type ModuleManifest,
	moduleForAction,
	narrowModules,
	resolveModules,
} from "./manifest.ts";

/**
 * The module layer's promises: a config resolves to a complete set, the hub can
 * only take modules away, and a module is not held to what it declared.
 */

/**
 * The gates under test here are config and availability. The platform
 * gate is pinned to Linux — the builtin manifests the fakes borrow name it —
 * so the same answers come back whichever host runs the suite.
 */
const loadModules = (
	ctx: Parameters<typeof loadModulesOn>[0],
	requested: Parameters<typeof loadModulesOn>[1],
	modules: Parameters<typeof loadModulesOn>[2],
) => loadModulesOn(ctx, requested, modules, "linux");

function manifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
	return { ...MODULES.docker, ...overrides };
}

describe("the manifest", () => {
	test("every module's actions belong to exactly one module", () => {
		const seen = new Map<string, string>();
		for (const module of MODULE_LIST) {
			for (const action of module.actions) {
				expect(seen.get(action)).toBeUndefined();
				seen.set(action, module.id);
				expect(moduleForAction(action)).toBe(module.id);
			}
		}
		expect(moduleForAction("snapshot")).toBeNull();
	});

	test("resolving fills in every id and refuses unknown ones", () => {
		const resolved = resolveModules({ docker: false });
		expect(Object.keys(resolved).sort()).toEqual(
			[...BUILTIN_MODULE_IDS].sort(),
		);
		expect(resolved.docker).toBe(false);
		expect(resolved.systemd).toBe(true);

		const errors: string[] = [];
		resolveModules({ dcoker: false }, errors);
		expect(errors[0]).toMatch(/unknown module 'dcoker'/);
	});

	test("the hub narrows a node's modules and can never widen them", () => {
		const node = resolveModules({ terminal: false });
		const hub = resolveModules({ docker: false });
		const narrowed = narrowModules(node, hub);

		expect(narrowed.docker).toBe(false); // the hub said no
		expect(narrowed.terminal).toBe(false); // the node said no
		expect(narrowed.systemd).toBe(true); // both said yes

		// A hub that turns everything on still can't hand a node what it refused.
		expect(narrowModules(node, resolveModules({})).terminal).toBe(false);
	});
});

describe("the module host", () => {
	test("a module reaches past what it declared", async () => {
		const path = join(tmpdir(), `stats-host-${Date.now()}`);
		await Bun.write(path, "outside every read root");

		// No grants at all, and nothing is refused.
		const host = createModuleHost(manifest({ grants: [] }));
		expect(await host.readFile(path)).toBe("outside every read root");
		await unlink(path);

		// Bun itself, which is the one executable every host running this has.
		const result = await host.exec([
			process.execPath,
			"-e",
			"console.log('hi')",
		]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("hi");
	});
});

describe("loading", () => {
	const ctx = {
		config: {} as AgentConfig,
		supervisor: {} as Supervisor,
		terminals: {} as TerminalManager,
		control: true,
	} satisfies Omit<NodeModuleContext, "host">;

	const fake = (
		id: (typeof BUILTIN_MODULE_IDS)[number],
		extra: Partial<NodeModule> = {},
	): NodeModule => ({ manifest: MODULES[id], ...extra });

	test("a disabled module contributes nothing and says why", async () => {
		const loaded = await loadModules(ctx, resolveModules({ docker: false }), [
			fake("system", { collect: async () => ({}) }),
			fake("docker"),
		]);

		expect(loaded.set.docker).toBe(false);
		expect(loaded.notes).toContain("docker: disabled by config");
		// Asking for its action explains itself rather than 404ing.
		expect(() => loaded.dispatch("container.action")).toThrow(
			/'docker' module, which is not enabled/,
		);
	});

	test("an unavailable module is dropped, not reported as broken", async () => {
		const loaded = await loadModules(ctx, resolveModules({}), [
			fake("docker", { available: async () => false }),
		]);
		expect(loaded.set.docker).toBe(false);
		expect(loaded.active).toEqual([]);
		expect(loaded.notes[0]).toMatch(/not available on this host/);
	});

	test("one module failing to collect doesn't cost the others their data", async () => {
		const loaded = await loadModules(ctx, resolveModules({}), [
			fake("processes", {
				collect: async () => ({ processes: [] }),
			}),
			fake("docker", {
				collect: async () => {
					throw new Error("socket went away");
				},
			}),
		]);

		const { parts, errors } = await loaded.collect();
		expect(parts.processes).toEqual([]);
		expect(errors.docker).toBe("socket went away");
	});
});
