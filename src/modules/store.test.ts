import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
	loadExternalModules,
	sanitiseReport,
	toNodeModule,
} from "../agent/modules/external.ts";
import { parseExternalManifest, toModuleManifest } from "./external.ts";
import { createModuleHost, defaultPolicy } from "./host.ts";
import { moduleOn, narrowModules, resolveModules } from "./manifest.ts";
import {
	installedModules,
	installModule,
	isBroken,
	listModules,
	removeModule,
	resolveSource,
	updateModule,
} from "./store.ts";

/**
 * The store is tested against real git repositories in a temp directory: the
 * whole point of the feature is that a module arrives as a clone, and a fake
 * that skipped git would test everything except the part that can break.
 */

let root: string;
let store: string;
/** a git repository holding a valid module */
let origin: string;

const MANIFEST = {
	id: "weather",
	label: "Weather",
	description: "Reports the weather, for a very small value of weather.",
	version: "1.0.0",
	entry: "./node.ts",
	grants: ["http"],
	actions: ["weather.refresh"],
	tab: {
		label: "weather",
		columns: [
			{ key: "city", label: "City" },
			{ key: "tempC", label: "Temp", align: "right", suffix: "°C" },
			{ key: "state", label: "State", format: "state" },
		],
	},
	face: {
		tiles: [{ label: "Cities", value: "cities" }],
		meter: { label: "Reporting", value: "reporting", of: "cities" },
	},
};

const ENTRY = `export default {
	available: () => true,
	collect: (ctx) => ({
		values: { cities: 2, reporting: 2, name: ctx.settings.name ?? "unset" },
		rows: [
			{ city: "Bristol", tempC: 14, state: "ok" },
			{ city: "Leeds", tempC: 11, state: "ok" },
		],
		status: "ok",
	}),
	actions: {
		"weather.refresh": async (params) => ({ refreshed: params.city ?? "all" }),
	},
};
`;

async function makeRepo(
	dir: string,
	files: Record<string, string>,
): Promise<string> {
	for (const [name, contents] of Object.entries(files)) {
		await Bun.write(join(dir, name), contents);
	}
	await $`git init -q -b main`.cwd(dir).quiet();
	await $`git config user.email test@example.com`.cwd(dir).quiet();
	await $`git config user.name Test`.cwd(dir).quiet();
	await $`git add -A`.cwd(dir).quiet();
	await $`git commit -q -m initial`.cwd(dir).quiet();
	return dir;
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "stats-store-"));
	store = join(root, "store");
	origin = await makeRepo(join(root, "origin"), {
		"stats.module.json": JSON.stringify(MANIFEST, null, "\t"),
		"node.ts": ENTRY,
	});
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("resolveSource", () => {
	test("accepts everything someone would paste", () => {
		expect(resolveSource("https://git.example.com/x/y.git")).toBe(
			"https://git.example.com/x/y.git",
		);
		expect(resolveSource("git@github.com:owner/repo.git")).toBe(
			"git@github.com:owner/repo.git",
		);
		expect(resolveSource("owner/repo")).toBe("https://github.com/owner/repo");
		expect(resolveSource("github:owner/repo")).toBe(
			"https://github.com/owner/repo",
		);
		expect(resolveSource("/srv/modules/thing")).toBe("/srv/modules/thing");
	});

	test("refuses what isn't a repository", () => {
		expect(() => resolveSource("")).toThrow(/no repository/);
		expect(() => resolveSource("not a repo")).toThrow(/doesn't look like/);
	});
});

describe("parseExternalManifest", () => {
	test("accepts the example manifest", () => {
		const { manifest, problems } = parseExternalManifest(MANIFEST);
		expect(problems).toEqual([]);
		expect(manifest?.id).toBe("weather");
		expect(manifest?.tab?.columns).toHaveLength(3);
	});

	test("refuses an id that would shadow a builtin", () => {
		const { manifest, problems } = parseExternalManifest(
			{ ...MANIFEST, id: "docker" },
			["docker", "systemd"],
		);
		expect(manifest).toBeNull();
		expect(problems.join()).toMatch(/ships with stats/);
	});

	test("keeps actions inside the module's own namespace", () => {
		// Otherwise an installed module could declare `unit.action` and quietly
		// take over systemd's dispatch entry.
		const { problems } = parseExternalManifest({
			...MANIFEST,
			actions: ["unit.action"],
		});
		expect(problems.join()).toMatch(/must be named 'weather.something'/);
	});

	test("reports every problem at once, named", () => {
		const { manifest, problems } = parseExternalManifest({
			id: "Weather Module",
			grants: ["http", "telepathy"],
			tab: { columns: [{ label: "no key" }] },
		});
		expect(manifest).toBeNull();
		expect(problems.join("\n")).toMatch(/lowercase letters/);
		expect(problems.join("\n")).toMatch(/unknown grant 'telepathy'/);
		expect(problems.join("\n")).toMatch(/tab\.columns\[0\]: key is required/);
	});

	test("refuses more tiles than a card can show", () => {
		const { problems } = parseExternalManifest({
			...MANIFEST,
			face: {
				tiles: [1, 2, 3, 4].map((n) => ({ label: `t${n}`, value: `v${n}` })),
			},
		});
		expect(problems.join()).toMatch(/the card fits 3/);
	});

	test("an installed module becomes an ordinary manifest row", () => {
		const { manifest } = parseExternalManifest(MANIFEST);
		const row = toModuleManifest(manifest!);
		expect(row.required).toBe(false);
		expect(row.enabledByDefault).toBe(true);
		expect(row.tab).toBe("weather");
		expect(row.actions).toEqual(["weather.refresh"]);
	});
});

describe("installing", () => {
	test("clones a repository into the store and records where it came from", async () => {
		const { module, replaced } = await installModule(origin, {
			storeDir: store,
		});

		expect(replaced).toBe(false);
		expect(module.manifest.id).toBe("weather");
		expect(module.dir).toBe(join(store, "weather"));
		expect(module.record.source).toBe(origin);
		expect(module.record.commit).toMatch(/^[0-9a-f]{40}$/);

		const installed = await installedModules(store);
		expect(installed.map((entry) => entry.manifest.id)).toEqual(["weather"]);
	});

	test("refuses to replace an installed id without being told to", async () => {
		expect(installModule(origin, { storeDir: store })).rejects.toThrow(
			/already installed/,
		);
		const again = await installModule(origin, { storeDir: store, force: true });
		expect(again.replaced).toBe(true);
	});

	test("a repository that isn't a module leaves nothing behind", async () => {
		const notAModule = await makeRepo(join(root, "not-a-module"), {
			"README.md": "# nope",
		});
		expect(installModule(notAModule, { storeDir: store })).rejects.toThrow(
			/not a stats module/,
		);

		// The clone happened in a scratch directory, so a failed install can't
		// leave a half-module for the next node restart to pick up.
		const entries = await listModules(store);
		expect(
			entries.map((entry) => (isBroken(entry) ? entry.id : entry.manifest.id)),
		).toEqual(["weather"]);
	});

	test("a manifest whose entry is missing is reported, not installed", async () => {
		const noEntry = await makeRepo(join(root, "no-entry"), {
			"stats.module.json": JSON.stringify({
				...MANIFEST,
				id: "ghost",
				actions: ["ghost.refresh"],
			}),
		});
		expect(installModule(noEntry, { storeDir: store })).rejects.toThrow(
			/does not exist/,
		);
	});

	test("update fast-forwards to whatever the source has now", async () => {
		await Bun.write(
			join(origin, "stats.module.json"),
			JSON.stringify({ ...MANIFEST, version: "1.1.0" }, null, "\t"),
		);
		await $`git add -A`.cwd(origin).quiet();
		await $`git commit -q -m bump`.cwd(origin).quiet();

		const { from, to, module } = await updateModule("weather", store);
		expect(from).not.toBe(to);
		expect(module.manifest.version).toBe("1.1.0");
	});

	test("remove takes the directory with it", async () => {
		await removeModule("weather", store);
		expect(await installedModules(store)).toEqual([]);
		expect(removeModule("weather", store)).rejects.toThrow(/not installed/);
	});

	test("an id that isn't one never becomes a path", async () => {
		expect(removeModule("../../etc", store)).rejects.toThrow(/not a module id/);
	});
});

describe("the node half", () => {
	test("loads the entry and collects through it", async () => {
		const { module: installed } = await installModule(origin, {
			storeDir: store,
			force: true,
		});
		const node = await toNodeModule(installed, { name: "from settings" });

		const host = createModuleHost(node.manifest, defaultPolicy([]));
		const ctx = {
			host,
			config: {} as never,
			supervisor: {} as never,
			terminals: {} as never,
			control: true,
		};

		expect(await node.available!(ctx)).toBe(true);

		const parts = await node.collect!(ctx);
		const report = parts.extras!.weather!;
		expect(report.values).toEqual({
			cities: 2,
			reporting: 2,
			name: "from settings",
		});
		expect(report.rows).toHaveLength(2);
		expect(report.status).toBe("ok");
	});

	test("actions are refused when the node has control switched off", async () => {
		const installed = (await installedModules(store))[0]!;
		const node = await toNodeModule(installed);
		const handler = node.actions!["weather.refresh"]!;
		const host = createModuleHost(node.manifest, defaultPolicy([]));

		const req = { params: { city: "Bristol" } } as never;
		await expect(
			handler(req, {
				host,
				config: {} as never,
				supervisor: {} as never,
				terminals: {} as never,
				control: false,
			}),
		).rejects.toThrow(/control actions are disabled/);

		expect(
			await handler(req, {
				host,
				config: {} as never,
				supervisor: {} as never,
				terminals: {} as never,
				control: true,
			}),
		).toEqual({ refreshed: "Bristol" });
	});

	test("a module that won't import is absent, not fatal", async () => {
		const broken = await makeRepo(join(root, "broken"), {
			"stats.module.json": JSON.stringify({
				...MANIFEST,
				id: "broken",
				actions: [],
			}),
			"node.ts": "export default 42;",
		});
		const { module } = await installModule(broken, { storeDir: store });

		const loaded = await loadExternalModules([module]);
		expect(loaded.modules).toEqual([]);
		expect(loaded.notes.join()).toMatch(/no default export/);
	});

	test("an installed module cannot use a grant it didn't declare", async () => {
		// The manifest asks for http and nothing else, so the host it is handed
		// refuses exec even though the policy would otherwise allow it.
		const installed = (await installedModules(store)).find(
			(entry) => entry.manifest.id === "weather",
		)!;
		const node = await toNodeModule(installed);
		const host = createModuleHost(node.manifest, defaultPolicy(["weather"]));
		expect(host.exec(["id"])).rejects.toThrow(/not allowed to exec/);
	});
});

describe("sanitiseReport", () => {
	test("drops anything that isn't a plain value", () => {
		const report = sanitiseReport({
			values: { n: 1, s: "x", b: true, nil: null, fn: () => {}, obj: {} },
			rows: [{ a: 1, nested: { deep: true } }],
		});
		expect(report.values).toEqual({ n: 1, s: "x", b: true, nil: null });
		expect(report.rows).toEqual([{ a: 1 }]);
	});

	test("turns a garbage return into an empty report", () => {
		expect(sanitiseReport(undefined)).toEqual({ values: {}, rows: [] });
		expect(sanitiseReport("nope").rows).toEqual([]);
	});

	test("caps rows so one module can't bloat every frame", () => {
		const rows = Array.from({ length: 900 }, (_, i) => ({ i }));
		expect(sanitiseReport({ rows }).rows).toHaveLength(500);
	});

	test("keeps NaN and Infinity off the wire", () => {
		// They serialise to null in JSON anyway; making that explicit means the
		// browser never renders "null" where a number was promised.
		const report = sanitiseReport({ values: { a: NaN, b: Infinity } });
		expect(report.values).toEqual({ a: null, b: null });
	});
});

describe("installed modules in the module set", () => {
	test("default on, and nameable in --modules like any other", () => {
		const weather = toModuleManifest(parseExternalManifest(MANIFEST).manifest!);

		expect(resolveModules({}, [], [weather]).weather).toBe(true);
		expect(resolveModules({ weather: false }, [], [weather]).weather).toBe(
			false,
		);

		const errors: string[] = [];
		resolveModules({ wether: true }, errors, [weather]);
		expect(errors.join()).toMatch(/unknown module 'wether'/);
	});

	test("the hub can switch one off without ever having heard of it", () => {
		// narrowModules works off the node's own keys, so a fleet-wide switch
		// reaches a module that only exists on one machine.
		expect(narrowModules({ weather: true }, {}).weather).toBe(true);
		expect(narrowModules({ weather: true }, { weather: false }).weather).toBe(
			false,
		);
		// And it still can't hand back one the node didn't load.
		expect(moduleOn(narrowModules({}, { weather: true }), "weather")).toBe(
			false,
		);
	});
});
