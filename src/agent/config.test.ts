import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfig } from "./config.ts";

/** The hub-directed switches default on and can each be refused. */

const dir = await mkdtemp(join(tmpdir(), "stats-config-"));
const cleared = [
	"STATS_HUB",
	"STATS_NODE_TOKEN",
	"STATS_NODE_ID",
	"STATS_NODE_NAME",
	"STATS_MODULES",
	"STATS_ALLOW_REMOTE_UPDATE",
	"STATS_ALLOW_HUB_MODULES",
];

beforeEach(() => {
	for (const name of cleared) delete process.env[name];
	// Keep the suite off whatever this machine actually has installed.
	process.env.STATS_MODULE_DIR = join(dir, "modules");
});

afterAll(async () => {
	delete process.env.STATS_MODULE_DIR;
	await rm(dir, { recursive: true, force: true });
});

async function write(name: string, body: Record<string, unknown>) {
	const path = join(dir, name);
	await Bun.write(path, JSON.stringify(body));
	return path;
}

describe("the switches the hub needs", () => {
	test("all default on", async () => {
		const path = await write("plain.json", { hub: "hub.lan" });
		const config = await loadAgentConfig({ config: path });
		expect(config.allowRemoteUpdate).toBe(true);
		expect(config.allowHubModules).toBe(true);
		expect(config.allowHubSshKeys).toBe(true);
	});

	test("the config file can still say no", async () => {
		const path = await write("refusing.json", {
			hub: "hub.lan",
			allowRemoteUpdate: false,
			allowHubModules: false,
		});
		const config = await loadAgentConfig({ config: path });
		expect(config.allowRemoteUpdate).toBe(false);
		expect(config.allowHubModules).toBe(false);
	});

	test("so do an env var and a flag", async () => {
		const path = await write("env.json", { hub: "hub.lan" });

		process.env.STATS_ALLOW_HUB_MODULES = "0";
		const env = await loadAgentConfig({ config: path });
		expect(env.allowHubModules).toBe(false);
		// Untouched by the one that was set.
		expect(env.allowRemoteUpdate).toBe(true);

		const flagged = await loadAgentConfig({
			config: path,
			allowRemoteUpdate: false,
		});
		expect(flagged.allowRemoteUpdate).toBe(false);
	});
});
