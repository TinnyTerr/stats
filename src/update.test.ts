import { describe, expect, test } from "bun:test";
import {
	applyUpdate,
	detectAsset,
	downloadBase,
	isCompiledBinary,
	isValidTag,
} from "./update.ts";
// It lives in version.ts, not update.ts, so the dashboard can import it without
// dragging the filesystem into the browser bundle. Both sides use this one.
import { compareVersions } from "./version.ts";

/**
 * The update path is the one thing here that can brick a machine, so what's
 * tested is the set of decisions that would do it: which build gets picked,
 * which tag is allowed to become a URL, and whether "newer" means newer.
 *
 * Downloading and swapping isn't tested against the network — that's install.sh
 * territory and a real release — but every gate in front of it is.
 */

describe("compareVersions", () => {
	test("orders releases", () => {
		expect(compareVersions("0.4.0", "0.3.0")).toBeGreaterThan(0);
		expect(compareVersions("0.3.0", "0.4.0")).toBeLessThan(0);
		expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
		expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
		expect(compareVersions("0.3.10", "0.3.9")).toBeGreaterThan(0);
	});

	test("ignores a leading v and any pre-release suffix", () => {
		// The forge reports tags as "v0.4.0" and the binary reports "0.4.0";
		// treating those as different versions would make every node look behind.
		expect(compareVersions("v0.4.0", "0.4.0")).toBe(0);
		expect(compareVersions("0.4.0-rc.1", "0.4.0")).toBe(0);
	});

	test("survives junk rather than ordering it randomly", () => {
		// A node reporting something unparseable should read as "same", not as a
		// spurious "behind" badge on every card.
		expect(compareVersions("", "0.4.0")).toBeLessThan(0);
		expect(compareVersions("not-a-version", "0.0.0")).toBe(0);
	});
});

describe("isValidTag", () => {
	test("accepts release tags", () => {
		expect(isValidTag("v0.4.0")).toBe(true);
		expect(isValidTag("0.4.0")).toBe(true);
		expect(isValidTag("v1.2.3-rc.1")).toBe(true);
	});

	test("refuses anything that would escape the download URL", () => {
		// A tag becomes a path segment, so this is the gate between "install the
		// release you asked for" and "fetch whatever this string points at".
		expect(isValidTag("../../etc/passwd")).toBe(false);
		expect(isValidTag("v0.4.0/../..")).toBe(false);
		expect(isValidTag("latest")).toBe(false);
		expect(isValidTag("")).toBe(false);
		expect(isValidTag("v0.4.0 ; rm -rf /")).toBe(false);
	});
});

describe("detectAsset", () => {
	test("names a build that the release actually publishes", async () => {
		const asset = await detectAsset();
		// The six Linux targets in scripts/build.ts, plus the macOS hub-only ones.
		expect(asset).toMatch(
			/^stats-(linux-(x64|arm64)(-musl)?(-baseline)?|darwin-(x64|arm64))$/,
		);
	});

	test("matches this machine's architecture", async () => {
		const asset = await detectAsset();
		expect(asset).toContain(process.arch === "x64" ? "x64" : "arm64");
	});

	test("STATS_ASSET overrides the detection", async () => {
		// The escape hatch for a CPU we guessed wrong about — same variable
		// install.sh honours, so the two agree.
		process.env.STATS_ASSET = "stats-linux-x64-baseline";
		try {
			expect(await detectAsset()).toBe("stats-linux-x64-baseline");
		} finally {
			delete process.env.STATS_ASSET;
		}
	});
});

describe("downloadBase", () => {
	test("builds the release URL both forges serve", () => {
		expect(
			downloadBase({ host: "git.example.com", repo: "me/stats" }, "v0.4.0"),
		).toBe("https://git.example.com/me/stats/releases/download/v0.4.0");
	});
});

describe("concurrency", () => {
	test("a second update joins the first rather than racing it onto the binary", async () => {
		// Both calls stage to the same path, so overlapping them would have one
		// download land on top of the other. An impatient second click is the
		// obvious way to cause that.
		const first = applyUpdate();
		const second = applyUpdate();
		expect(first).toBe(second);

		await Promise.allSettled([first, second]);

		// And once it has settled, the next call is a fresh attempt.
		const third = applyUpdate();
		expect(third).not.toBe(first);
		await third.catch(() => {});
	});
});

describe("isCompiledBinary", () => {
	test("is false under bun index.ts, so update refuses to run from source", () => {
		// Guards the one case where swapping "the binary" would replace bun itself.
		expect(isCompiledBinary()).toBe(false);
	});
});
