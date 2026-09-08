import { describe, expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { loadAgentConfig, normaliseHubUrl } from "./agent/config.ts";
import {
	MODULE_LIST,
	MODULES,
	moduleRunsOn,
	modulesForPlatform,
} from "./modules/manifest.ts";
import { PROTOCOL_VERSION } from "./proto/frame.ts";
import { PROTOCOL, VERSION, versionInfo } from "./version.ts";

describe("version", () => {
	test("tracks package.json and looks like semver", () => {
		expect(VERSION).toBe(pkg.version);
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});

	test("the frame header's version is the protocol number", () => {
		// Two constants, one meaning: the byte on the wire is the contract number
		// both roles report. Letting them drift would make a mismatch invisible.
		expect(PROTOCOL_VERSION).toBe(PROTOCOL);
		expect(versionInfo).toEqual({ version: VERSION, protocol: PROTOCOL });
	});
});

describe("hub URL normalisation", () => {
	test("accepts every reasonable way of naming a hub", () => {
		expect(normaliseHubUrl("hub.lan")).toBe("ws://hub.lan:3000/node");
		expect(normaliseHubUrl("hub.lan:9000")).toBe("ws://hub.lan:9000/node");
		expect(normaliseHubUrl("http://hub.lan:3000")).toBe(
			"ws://hub.lan:3000/node",
		);
		expect(normaliseHubUrl("https://stats.example.com")).toBe(
			"wss://stats.example.com/node",
		);
		expect(normaliseHubUrl("ws://10.0.0.5:3000/node")).toBe(
			"ws://10.0.0.5:3000/node",
		);
	});

	test("keeps a custom path rather than assuming /node", () => {
		// 443 is wss's default port, so the URL serialiser drops it again.
		expect(normaliseHubUrl("wss://example.com/stats/node")).toBe(
			"wss://example.com/stats/node",
		);
	});

	test("rejects nonsense", () => {
		expect(() => normaliseHubUrl("")).toThrow(/empty/);
		expect(() => normaliseHubUrl("ftp://hub")).toThrow(/must be ws/);
	});
});

describe("agent config", () => {
	test("insists on knowing where the hub is", () => {
		expect(loadAgentConfig({ config: undefined })).rejects.toThrow(
			/no hub to connect to/,
		);
	});

	test("flags win over the environment", async () => {
		process.env.STATS_HUB = "env-host";
		process.env.STATS_NODE_NAME = "from-env";
		try {
			const config = await loadAgentConfig({
				hub: "flag-host",
				name: "from-flag",
			});
			expect(config.hubUrl).toBe("ws://flag-host:3000/node");
			expect(config.name).toBe("from-flag");

			const fromEnv = await loadAgentConfig({});
			expect(fromEnv.hubUrl).toBe("ws://env-host:3000/node");
			expect(fromEnv.name).toBe("from-env");
		} finally {
			delete process.env.STATS_HUB;
			delete process.env.STATS_NODE_NAME;
		}
	});

	test("clamps a telemetry interval that would flood the hub", async () => {
		const config = await loadAgentConfig({ hub: "h", interval: "10" });
		expect(config.telemetryIntervalMs).toBe(1000);
	});

	test("terminal and control default on, and can be refused", async () => {
		const on = await loadAgentConfig({ hub: "h" });
		expect(on.modules.terminal).toBe(true);
		expect(on.control).toBe(true);

		const off = await loadAgentConfig({
			hub: "h",
			terminal: false,
			control: false,
		});
		expect(off.modules.terminal).toBe(false);
		expect(off.control).toBe(false);
	});

	test("--modules picks a set, and a leading dash removes one", async () => {
		// The positive form is exhaustive: asking for docker means docker and
		// nothing else. Since everything is a module — including system — that
		// really does mean nothing else.
		const only = await loadAgentConfig({ hub: "h", modules: "docker" });
		expect(only.modules).toMatchObject({
			system: false,
			docker: true,
			systemd: false,
			terminal: false,
		});

		const without = await loadAgentConfig({
			hub: "h",
			modules: "-terminal,-docker",
		});
		expect(without.modules).toMatchObject({
			system: true,
			systemd: true,
			docker: false,
			terminal: false,
		});
	});

	test("every module can be switched off, including system", async () => {
		// The node's core report is its hostname and addresses; everything else,
		// system included, is a module an operator can decline. A node running no
		// modules at all is a valid node — see src/agent/identity.ts.
		const bare = await loadAgentConfig({ hub: "h", modules: "-system" });
		expect(bare.modules.system).toBe(false);

		// And nothing in the builtin table claims to be required any more, which
		// is the invariant that keeps a platform with no probes bootable.
		expect(MODULE_LIST.filter((module) => module.required)).toEqual([]);
	});

	test("a module names the platforms it runs on", async () => {
		// The declaration is what the loader gates on and what the hub shows for a
		// node it has never seen. Portable is the empty list, not a missing field.
		expect(MODULES.systemd.platforms).toEqual(["linux"]);
		expect(MODULES.projects.platforms).toEqual([]);

		expect(moduleRunsOn(MODULES.systemd, "linux")).toBe(true);
		expect(moduleRunsOn(MODULES.systemd, "win32")).toBe(false);
		// Portable means portable, including on a platform we have no name for.
		expect(moduleRunsOn(MODULES.projects, "win32")).toBe(true);
		expect(moduleRunsOn(MODULES.projects, null)).toBe(true);

		expect(modulesForPlatform("win32").map((m) => m.id)).toEqual([
			"system",
			"projects",
			"proxmox",
			"pihole",
			"logs",
			"terminal",
			"ca",
		]);
	});
});
