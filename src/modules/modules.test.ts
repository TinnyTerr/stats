import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../agent/config.ts";
import { loadModules } from "../agent/modules/index.ts";
import type { NodeModule, NodeModuleContext } from "../agent/modules/mod.ts";
import type { Supervisor } from "../agent/supervisor.ts";
import type { TerminalManager } from "../agent/terminal.ts";
import {
	checkGrants,
	createModuleHost,
	defaultPolicy,
	hostPolicy,
	ModuleDenied,
	type ModulePolicy,
	rootPolicy,
} from "./host.ts";
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
 * only take modules away, and a module reaches nothing it didn't declare —
 * that last one for as long as the node isn't root, which is the subject of the
 * final block.
 */

const policy = defaultPolicy(BUILTIN_MODULE_IDS);

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
	test("a module only reaches what it declared", async () => {
		const host = createModuleHost(manifest({ grants: ["read"] }), policy);

		expect(await host.readFile("/proc/uptime")).toMatch(/\d/);
		await expect(host.fetch("http://example.invalid")).rejects.toThrow(
			ModuleDenied,
		);
		await expect(
			host.socket("/var/run/docker.sock", "http://localhost/_ping"),
		).rejects.toThrow(ModuleDenied);
		await expect(host.exec(["true"])).rejects.toThrow(ModuleDenied);
	});

	test("reads are confined to the policy's roots", async () => {
		const host = createModuleHost(manifest({ grants: ["read"] }), policy);
		await expect(host.readFile("/etc/../root/.ssh/id_rsa")).rejects.toThrow(
			ModuleDenied,
		);
		await expect(host.readFile("/home/someone/notes")).rejects.toThrow(
			/outside the read roots/,
		);
	});

	test("a socket that isn't in the policy is refused", async () => {
		const host = createModuleHost(manifest({ grants: ["socket"] }), policy);
		await expect(
			host.socket("/tmp/other.sock", "http://localhost/"),
		).rejects.toThrow(/not in the allowed sockets/);
	});

	test("privileged grants need the module to be trusted", () => {
		const untrusting: ModulePolicy = { ...policy, trusted: new Set<string>() };
		expect(checkGrants(manifest({ grants: ["exec"] }), untrusting)[0]).toMatch(
			/privileged 'exec'/,
		);
		expect(checkGrants(manifest({ grants: ["exec"] }), policy)).toEqual([]);
		// The open set stays open whether or not anyone trusts you.
		expect(checkGrants(manifest({ grants: ["http"] }), untrusting)).toEqual([]);
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
		const loaded = await loadModules(
			ctx,
			resolveModules({ docker: false }),
			policy,
			[fake("system", { collect: async () => ({}) }), fake("docker")],
		);

		expect(loaded.set.docker).toBe(false);
		expect(loaded.notes).toContain("docker: disabled by config");
		// Asking for its action explains itself rather than 404ing.
		expect(() => loaded.dispatch("container.action")).toThrow(
			/'docker' module, which is not enabled/,
		);
	});

	test("an unavailable module is dropped, not reported as broken", async () => {
		const loaded = await loadModules(ctx, resolveModules({}), policy, [
			fake("docker", { available: async () => false }),
		]);
		expect(loaded.set.docker).toBe(false);
		expect(loaded.active).toEqual([]);
		expect(loaded.notes[0]).toMatch(/not available on this host/);
	});

	test("one module failing to collect doesn't cost the others their data", async () => {
		const loaded = await loadModules(ctx, resolveModules({}), policy, [
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

	test("a module that wants more than the policy allows never loads", async () => {
		const loaded = await loadModules(
			ctx,
			resolveModules({}),
			{ ...policy, trusted: new Set<string>() },
			[fake("systemd")],
		);
		expect(loaded.set.systemd).toBe(false);
		expect(loaded.notes[0]).toMatch(/privileged 'exec'/);
	});
});

describe("a root node", () => {
	const root = rootPolicy();

	test("hostPolicy picks the policy from who we are", () => {
		expect(hostPolicy(BUILTIN_MODULE_IDS, true).unrestricted).toBe(true);
		expect(hostPolicy(BUILTIN_MODULE_IDS, false).unrestricted).toBeUndefined();
		// The restricted one is still the restricted one.
		expect(hostPolicy([], false).readRoots).not.toContain("/");
	});

	test("nothing is refused at load, trusted or not", () => {
		expect(checkGrants(manifest({ grants: ["exec", "pty"] }), root)).toEqual(
			[],
		);
		// Trust is what the unprivileged policy reads; here the list is empty and
		// it makes no difference.
		expect(root.trusted.size).toBe(0);
	});

	test("a module reaches past what it declared", async () => {
		const path = join(tmpdir(), `stats-root-policy-${Date.now()}`);
		await Bun.write(path, "outside every read root");

		// No grants at all: under the unprivileged policy this host refuses
		// everything, and under this one it refuses nothing.
		const host = createModuleHost(manifest({ grants: [] }), root);
		expect(await host.readFile(path)).toBe("outside every read root");

		const result = await host.exec(["/bin/echo", "hi"]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("hi");

		// A socket outside the allowed list fails the way dialling a socket that
		// isn't there fails, not the way a denial does.
		const denial = await host
			.socket("/tmp/stats-nothing-here.sock", "http://localhost/")
			.then(
				() => null,
				(err: unknown) => err,
			);
		expect(denial).not.toBeInstanceOf(ModuleDenied);

		await unlink(path);
	});

	test("a module the trust list never heard of still loads", async () => {
		const loaded = await loadModules(
			{
				config: {} as AgentConfig,
				supervisor: {} as Supervisor,
				terminals: {} as TerminalManager,
				control: true,
			},
			resolveModules({}),
			root,
			[{ manifest: MODULES.systemd }],
			"linux",
		);
		expect(loaded.set.systemd).toBe(true);
		expect(loaded.notes).toEqual([]);
	});
});
