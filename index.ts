#!/usr/bin/env bun

/**
 * Entry point for both roles:
 *
 *   bun index.ts hub                          # laptop: dashboard, listens for nodes
 *   bun index.ts node --hub ws://laptop:3000  # each server: dials the hub
 */

import { startNode } from "./src/agent/agent.ts";
import {
	type AgentOverrides,
	loadAgentConfig,
	parseModuleList,
} from "./src/agent/config.ts";
import { loadProjects } from "./src/agent/projects.ts";
import { loadConfig } from "./src/hub/config.ts";
import { startHub } from "./src/hub/server.ts";
import { MODULE_LIST, resolveModules } from "./src/modules/manifest.ts";
import { PROTOCOL, VERSION } from "./src/version.ts";

function flag(name: string): string | undefined {
	const args = process.argv.slice(3);
	const i = args.indexOf(`--${name}`);
	if (i !== -1 && args[i + 1] && !args[i + 1]!.startsWith("--"))
		return args[i + 1];
	const inline = args.find((a) => a.startsWith(`--${name}=`));
	return inline?.split("=").slice(1).join("=");
}

/** Presence flags, with an explicit `--no-x` negation. */
function toggle(name: string): boolean | undefined {
	const args = process.argv.slice(3);
	if (args.includes(`--no-${name}`)) return false;
	if (args.includes(`--${name}`)) return true;
	return undefined;
}

/** `stats` when running as a compiled binary, `bun index.ts` from source. */
const invocation = Bun.main.startsWith("/$bunfs/") ? "stats" : "bun index.ts";

const usage = `stats ${VERSION} — server fleet dashboard (protocol ${PROTOCOL})

Nodes dial the hub over a WebSocket and stream telemetry to it; the hub relays
control — log tails, terminals, project start/stop — back down the same socket.

Usage:
  ${invocation} hub    [--config hub.json] [--port 3000] [--host 127.0.0.1]
  ${invocation} node   --hub ws://hub:3000 [--token T] [--id ID] [--name NAME]
                       [--tags a,b] [--interval 3000] [--projects PATH]
                       [--modules docker,systemd | --modules -terminal]
                       [--no-terminal] [--no-control]
  ${invocation} modules                      list the modules a node can load
  ${invocation} check  [--projects PATH]      validate the projects file and exit
  ${invocation} version

Environment:
  STATS_CONFIG        hub config path (default ./hub.json)
  STATS_AGENT_CONFIG  node config path (default /etc/stats/agent.json)
  STATS_HUB           hub URL for a node
  STATS_NODE_TOKEN    token the node presents to the hub
  STATS_NODE_ID       node id (default /etc/machine-id, else hostname)
  STATS_NODE_NAME     display name (default hostname)
  STATS_PROJECTS      projects file or directory (colon-separated)
  STATS_MODULES       modules to load, e.g. "docker,systemd" or "-terminal"
  STATS_TERMINAL      set to 0 to refuse terminal sessions
  STATS_CONTROL       set to 0 to refuse start/stop/restart
  STATS_LOG_DIRS      dirs readable via kind=file (default /var/log)
  DOCKER_SOCKET       docker socket path (default /var/run/docker.sock)
`;

/**
 * Wrapped in a function rather than run at the top level so the entry point
 * stays free of top-level await — `bun build --compile --bytecode` needs a
 * CommonJS-compatible graph, and that buys a noticeably faster cold start.
 */
async function main(role: string | undefined) {
	switch (role) {
		case "version":
		case "--version":
		case "-v":
			console.log(`stats ${VERSION} (protocol ${PROTOCOL})`);
			break;

		case "modules": {
			console.log("modules a node can load (--modules to choose):\n");
			for (const module of MODULE_LIST) {
				const flags = [
					module.required ? "required" : null,
					module.enabledByDefault ? "on by default" : "off by default",
					module.tab ? `tab '${module.tab}'` : null,
					`grants ${module.grants.join("+")}`,
				].filter(Boolean);
				console.log(`  ${module.id.padEnd(11)} ${module.description}`);
				console.log(`  ${" ".repeat(11)} ${flags.join(" · ")}`);
			}
			break;
		}

		case "check": {
			const paths = flag("projects")?.split(":");
			const loaded = await loadProjects(paths);
			if (!loaded.sources.length) {
				console.log("no projects file found — nothing to check");
				break;
			}
			console.log(`read ${loaded.sources.join(", ")}`);
			for (const project of loaded.projects) {
				const procs =
					project.processes.map((p) => p.id).join(", ") || "no processes";
				console.log(`  ${project.id.padEnd(24)} ${procs}`);
			}
			if (loaded.errors.length) {
				console.error(`\n${loaded.errors.length} problem(s):`);
				for (const error of loaded.errors) console.error(`  - ${error}`);
				process.exit(1);
			}
			console.log(`\n${loaded.projects.length} project(s), no problems.`);
			break;
		}

		case "node":
		case "agent": {
			if (role === "agent") {
				console.warn(
					"note: 'agent' is now called 'node' — the old name still works",
				);
			}
			const overrides: AgentOverrides = {
				hub: flag("hub"),
				token: flag("token"),
				id: flag("id"),
				name: flag("name"),
				tags: flag("tags"),
				interval: flag("interval"),
				projects: flag("projects"),
				config: flag("config"),
				modules: flag("modules"),
				terminal: toggle("terminal"),
				control: toggle("control"),
			};
			const config = await loadAgentConfig(overrides);

			console.log(
				`stats node ${VERSION} — id '${config.id}' (${config.name}) → ${config.hubUrl}`,
			);
			if (!config.token) {
				console.warn(
					"warning: no token set — anyone who can reach the hub can register as a node. " +
						"Set STATS_NODE_TOKEN.",
				);
			}
			if (config.modules.terminal) {
				console.warn(
					"note: the terminal module is loaded — the hub can open a shell on this " +
						"host. Pass --no-terminal to refuse.",
				);
			}

			const node = startNode(config);
			const stop = () => {
				void node.stop().finally(() => process.exit(0));
			};
			process.on("SIGINT", stop);
			process.on("SIGTERM", stop);
			break;
		}

		case "hub": {
			const config = await loadConfig(flag("config"));
			const portOverride = flag("port");
			const hostOverride = flag("host");
			if (portOverride) config.port = Number(portOverride);
			if (hostOverride) config.host = hostOverride;

			const { registry, notion } = startHub(config);
			console.log(
				`stats hub ${VERSION} listening on http://${config.host}:${config.port}`,
			);
			console.log(`nodes connect to ws://${config.host}:${config.port}/node`);
			const known = registry.list().length;
			if (known) console.log(`${known} node(s) known from previous runs`);
			if (notion) {
				console.log(
					`mirroring projects to Notion database ${config.notion?.database} every ${
						(config.notion?.intervalMs ?? 0) / 1000
					}s`,
				);
			}
			if (!config.nodeToken) {
				console.warn(
					"warning: no nodeToken set — any host that can reach this port can register. " +
						"Set one in hub.json.",
				);
			}

			if (config.embeddedNode) {
				// The hub watching its own machine: a node like any other, over
				// loopback, so there is exactly one code path for collection.
				const node = startNode({
					hubUrl: `ws://127.0.0.1:${config.port}/node`,
					token: config.nodeToken,
					id: process.env.STATS_NODE_ID ?? "hub-local",
					name: process.env.STATS_NODE_NAME ?? "This machine",
					tags: ["hub"],
					telemetryIntervalMs: config.telemetryIntervalMs,
					// The hub's own switches apply, and STATS_MODULES still trims
					// further — this node is in the hub's process, but it is a node.
					modules: resolveModules({
						...config.modules,
						...(process.env.STATS_MODULES
							? parseModuleList(process.env.STATS_MODULES)
							: {}),
					}),
					control: true,
					projectPaths: (process.env.STATS_PROJECTS ?? "./projects.json").split(
						":",
					),
					trustedModules: MODULE_LIST.map((module) => module.id),
				});
				process.on("SIGINT", () => void node.stop());
				process.on("SIGTERM", () => void node.stop());
			}
			break;
		}

		default:
			console.log(usage);
			process.exit(role ? 1 : 0);
	}
}

main(process.argv[2]).catch((err: unknown) => {
	console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
