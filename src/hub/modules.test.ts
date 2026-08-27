import { describe, expect, test } from "bun:test";
import { loadModules } from "../agent/modules/index.ts";
import type { NodeModule } from "../agent/modules/mod.ts";
import { defaultPolicy } from "../modules/host.ts";
import type { ModuleManifest } from "../modules/manifest.ts";
import { plannedModules, resolveNodeModules } from "./modules.ts";

/**
 * Two rules are worth holding still here, because between them they are the
 * whole of "the hub decides, but not unilaterally":
 *
 *   - the loader drops a module whose platform doesn't match, before it asks
 *     the module anything;
 *   - the hub can always take a module away, and can only add one to a node
 *     that opted in.
 */

function manifest(over: Partial<ModuleManifest> = {}): ModuleManifest {
	return {
		id: "widget",
		label: "Widget",
		description: "",
		required: false,
		enabledByDefault: true,
		platforms: [],
		grants: [],
		actions: [],
		tab: null,
		provides: [],
		...over,
	};
}

function nodeModule(
	over: Partial<ModuleManifest>,
	extra: Partial<NodeModule> = {},
): NodeModule {
	return { manifest: manifest(over), ...extra };
}

const ctx = {
	config: {} as never,
	supervisor: {} as never,
	terminals: {} as never,
	control: true,
};

describe("the loader's platform gate", () => {
	test("a module for another platform is dropped, and says why", async () => {
		const loaded = await loadModules(
			ctx,
			{ linuxonly: true, portable: true },
			defaultPolicy([]),
			[
				nodeModule({
					id: "linuxonly",
					label: "Linux only",
					platforms: ["linux"],
				}),
				nodeModule({ id: "portable", label: "Portable" }),
			],
			"win32",
		);

		expect(loaded.set.linuxonly).toBe(false);
		expect(loaded.set.portable).toBe(true);
		expect(loaded.notes.join("\n")).toContain(
			"linuxonly: supports Linux; this host is Windows",
		);
	});

	test("the gate runs before the module is consulted at all", async () => {
		let asked = false;
		const loaded = await loadModules(
			ctx,
			{ nope: true },
			defaultPolicy([]),
			[
				nodeModule(
					{ id: "nope", label: "Nope", platforms: ["win32"] },
					{
						available: async () => {
							asked = true;
							return true;
						},
					},
				),
			],
			"linux",
		);

		expect(loaded.set.nope).toBe(false);
		// Availability can read the host; asking it about a module that could never
		// run here is work done to reach a foregone conclusion.
		expect(asked).toBe(false);
	});
});

describe("what the hub plans for a node", () => {
	const announced = { docker: true, systemd: true, terminal: false };

	test("narrowing needs no consent from the node", () => {
		const planned = plannedModules({
			announced,
			desired: { docker: false },
			fleet: {},
			acceptsHubModules: false,
		});
		expect(planned.docker).toBe(false);
	});

	test("a module the hub has no opinion on is absent, not echoed back", () => {
		// The plan is intent. Echoing the node's own set back at it would read as
		// "the hub wants exactly this", and the node would narrow its config to
		// match a preference nobody expressed — which showed up as a reload on
		// every single connection.
		const planned = plannedModules({
			announced,
			desired: { docker: false },
			fleet: {},
			acceptsHubModules: true,
		});
		expect("systemd" in planned).toBe(false);
		expect("terminal" in planned).toBe(false);
	});

	test("widening is refused unless the node opted in", () => {
		const without = plannedModules({
			announced,
			desired: { terminal: true },
			fleet: {},
			acceptsHubModules: false,
		});
		// The old rule, unchanged: a module the node didn't load stays off.
		expect(without.terminal).toBe(false);

		const with_ = plannedModules({
			announced,
			desired: { terminal: true },
			fleet: {},
			acceptsHubModules: true,
		});
		expect(with_.terminal).toBe(true);
	});

	test("a fleet-wide switch beats per-node intent in both directions", () => {
		const planned = plannedModules({
			announced,
			desired: { docker: true },
			fleet: { docker: false },
			acceptsHubModules: true,
		});
		expect(planned.docker).toBe(false);
	});
});

describe("intent beside reality", () => {
	const base = {
		announced: { docker: true },
		fleet: {},
		acceptsHubModules: true,
		platform: "linux" as const,
	};

	function stateOf(
		input: Parameters<typeof resolveNodeModules>[0],
		id: string,
	) {
		return resolveNodeModules(input).find((m) => m.id === id)?.state;
	}

	test("a running module reads as on whatever the hub wanted", () => {
		// The page must never claim a module is off while the node is running it.
		expect(stateOf({ ...base, desired: { docker: false } }, "docker")).toBe(
			"on",
		);
	});

	test("asked for and absent is pending, not on", () => {
		expect(stateOf({ ...base, desired: { systemd: true } }, "systemd")).toBe(
			"pending",
		);
	});

	test("a node that won't take direction shows the ask as refused", () => {
		expect(
			stateOf(
				{ ...base, acceptsHubModules: false, desired: { systemd: true } },
				"systemd",
			),
		).toBe("refused");
	});

	test("a module the platform can't run says so rather than pending forever", () => {
		expect(
			stateOf(
				{ ...base, platform: "win32", desired: { systemd: true } },
				"systemd",
			),
		).toBe("unsupported");
	});

	test("a fleet switch reads as blocked, which a node's row can't fix", () => {
		expect(
			stateOf(
				{ ...base, fleet: { systemd: false }, desired: { systemd: true } },
				"systemd",
			),
		).toBe("blocked");
	});

	test("no opinion is no opinion", () => {
		const row = resolveNodeModules({ ...base, desired: {} }).find(
			(m) => m.id === "systemd",
		);
		expect(row?.state).toBe("off");
		expect(row?.desired).toBeNull();
	});
});
