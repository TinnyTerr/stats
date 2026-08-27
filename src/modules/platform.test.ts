import { describe, expect, test } from "bun:test";
import { parseExternalManifest, toModuleManifest } from "./external.ts";
import type { ModuleManifest } from "./manifest.ts";
import {
	parsePlatforms,
	platformsFromEntry,
	resolveEntry,
	supportsPlatform,
} from "./platform.ts";

/**
 * The platform declaration is load-bearing in three places — the loader drops a
 * module that doesn't claim this host, the store resolves a per-platform entry,
 * and the hub's module page explains "n/a" with it — so what "portable" means
 * is worth pinning down rather than rediscovering.
 */

describe("platform support", () => {
	test("an empty list is portable, a non-empty one is a closed set", () => {
		expect(supportsPlatform([], "win32")).toBe(true);
		expect(supportsPlatform(undefined, "win32")).toBe(true);
		expect(supportsPlatform(null, "win32")).toBe(true);

		expect(supportsPlatform(["linux"], "linux")).toBe(true);
		expect(supportsPlatform(["linux"], "win32")).toBe(false);
		expect(supportsPlatform(["linux", "darwin"], "darwin")).toBe(true);
	});

	test("a platform we have no name for runs portable modules only", () => {
		// The node still connects and still reports its identity; what it can't do
		// is match a module that named specific platforms.
		expect(supportsPlatform([], null)).toBe(true);
		expect(supportsPlatform(["linux"], null)).toBe(false);
	});

	test("unknown platform names are reported, not silently dropped", () => {
		const problems: string[] = [];
		expect(parsePlatforms(["linux", "windows"], "platforms", problems)).toEqual(
			["linux"],
		);
		expect(problems[0]).toContain("unknown platform 'windows'");
	});
});

describe("entry points", () => {
	test("a string entry serves every platform", () => {
		expect(resolveEntry("./node.ts", "win32")).toBe("./node.ts");
		expect(resolveEntry("./node.ts", null)).toBe("./node.ts");
		expect(platformsFromEntry("./node.ts")).toBeNull();
	});

	test("a map picks the platform's file, and default catches the rest", () => {
		const entry = { linux: "./linux.ts", default: "./other.ts" };
		expect(resolveEntry(entry, "linux")).toBe("./linux.ts");
		expect(resolveEntry(entry, "darwin")).toBe("./other.ts");
		// A default means the module claims to run anywhere, so it derives nothing.
		expect(platformsFromEntry(entry)).toBeNull();
	});

	test("a map with no default supports exactly what it named", () => {
		const entry = { linux: "./linux.ts", win32: "./windows.ts" };
		expect(platformsFromEntry(entry)).toEqual(["linux", "win32"]);
		expect(resolveEntry(entry, "darwin")).toBeNull();
	});
});

describe("external manifests", () => {
	const base = {
		id: "widget",
		label: "Widget",
		grants: ["http"],
		actions: [],
		tab: null,
		face: null,
	};

	test("a per-platform entry declares the module's platforms on its own", () => {
		const { manifest, problems } = parseExternalManifest({
			...base,
			entry: { linux: "./linux.ts", darwin: "./mac.ts" },
		});
		expect(problems).toEqual([]);
		expect(manifest?.platforms).toEqual(["linux", "darwin"]);
		// And it survives the trip into the table the builtins live in.
		expect(toModuleManifest(manifest!).platforms).toEqual(["linux", "darwin"]);
	});

	test("an explicit list wins over what the entry implies", () => {
		const { manifest } = parseExternalManifest({
			...base,
			platforms: ["linux"],
			entry: { linux: "./linux.ts", default: "./any.ts" },
		});
		expect(manifest?.platforms).toEqual(["linux"]);
	});

	test("declaring a platform with no entry for it is refused", () => {
		const { manifest, problems } = parseExternalManifest({
			...base,
			platforms: ["linux", "win32"],
			entry: { linux: "./linux.ts" },
		});
		expect(manifest).toBeNull();
		expect(problems.join("\n")).toContain(
			"platforms lists 'win32' but entry has no 'win32' or 'default'",
		);
	});

	test("a typo in an entry map is named rather than ignored", () => {
		const { problems } = parseExternalManifest({
			...base,
			entry: { windows: "./windows.ts" },
		});
		expect(problems.join("\n")).toContain("entry.windows: unknown platform");
	});

	test("a plain module is portable, which is the common case", () => {
		const { manifest, problems } = parseExternalManifest({
			...base,
			entry: "./node.ts",
		});
		expect(problems).toEqual([]);
		expect(manifest?.platforms).toEqual([]);
		const asManifest: ModuleManifest = toModuleManifest(manifest!);
		expect(supportsPlatform(asManifest.platforms, "win32")).toBe(true);
	});
});
