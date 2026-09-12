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
import { issueCert } from "./src/hub/ca.ts";
import { loadConfig } from "./src/hub/config.ts";
import { startHub } from "./src/hub/server.ts";
import { toModuleManifest } from "./src/modules/external.ts";
import { isRoot } from "./src/modules/host.ts";
import {
	MODULE_LIST,
	moduleRunsOn,
	resolveModules,
} from "./src/modules/manifest.ts";
import { currentPlatform, PLATFORM_LABELS } from "./src/modules/platform.ts";
import {
	installedModules,
	installModule,
	isBroken,
	listModules,
	moduleStoreDir,
	removeModule,
	updateModule,
} from "./src/modules/store.ts";
import {
	applyUpdate,
	checkForUpdate,
	currentUnit,
	restartUnit,
} from "./src/update.ts";
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
                       [--no-terminal] [--no-control] [--allow-remote-update]
                       [--allow-hub-modules]
  ${invocation} modules                      list builtin and installed modules
  ${invocation} modules install <repo>       install a module from a git repository
  ${invocation} modules update [ID]          fast-forward installed modules
  ${invocation} modules remove ID            uninstall one
  ${invocation} update [--check] [--version TAG] [--no-restart]
                       replace this binary with the latest release
  ${invocation} cert <common-name> [--san a,b] [--days 825] [--out DIR]
                       sign a leaf cert with the fleet CA, next to hub.json
  ${invocation} check  [--projects PATH]      validate the projects file and exit
  ${invocation} version

A node running as root is unrestricted: every module gets every grant, and the
hub — the source of truth for the fleet — may switch modules on and ask for an
update without either --allow flag. Run it as anyone else and both are off
until asked for, and modules only reach what they declared.

Environment:
  STATS_CONFIG        hub config path (default ./hub.json)
  STATS_AGENT_CONFIG  node config path (default /etc/stats/agent.json)
  STATS_HUB           hub URL for a node
  STATS_NODE_TOKEN    token the node presents to the hub
  STATS_NODE_ID       node id (default /etc/machine-id, else hostname)
  STATS_NODE_NAME     display name (default hostname)
  STATS_PROJECTS      projects file or directory (colon-separated)
  STATS_MODULES       modules to load, e.g. "docker,systemd" or "-terminal"
  STATS_MODULE_DIR    where installed modules live (default /var/lib/stats/modules
                      as root, ~/.local/share/stats/modules otherwise)
  STATS_HOST          forge to check for updates (default github.com)
  STATS_REPO          owner/repo for updates (default tinnyterr/stats)
  STATS_ASSET         force a build, e.g. stats-linux-x64-baseline
  STATS_TERMINAL      set to 0 to refuse terminal sessions
  STATS_CONTROL       set to 0 to refuse start/stop/restart
  STATS_ALLOW_HUB_MODULES  set to 1 to let the hub turn modules on, not just off
  STATS_LOG_DIRS      dirs readable via kind=file (default /var/log)
  DOCKER_SOCKET       docker socket path (default /var/run/docker.sock)
  PROXMOX_URL         PVE API base, e.g. https://pve.lan:8006 (a node running
                      on the hypervisor uses pvesh and needs none of these)
  PROXMOX_TOKEN       user@realm!tokenid=uuid, from 'pveum user token add'
  PROXMOX_INSECURE    set to 1 to accept PVE's default self-signed certificate
`;

/* ---------- modules ---------- */

function describeBuiltins() {
	const here = currentPlatform();
	console.log(
		`modules a node can load (--modules to choose) — this host is ` +
			`${here ? PLATFORM_LABELS[here] : process.platform}:\n`,
	);
	for (const module of MODULE_LIST) {
		const runs = moduleRunsOn(module, here);
		const flags = [
			module.enabledByDefault ? "on by default" : "off by default",
			module.tab ? `tab '${module.tab}'` : null,
			`grants ${module.grants.join("+") || "none"}`,
			module.platforms.length
				? module.platforms.map((p) => PLATFORM_LABELS[p]).join("/")
				: "any platform",
		].filter(Boolean);
		// A module that can't run here is listed anyway — the table is what a node
		// *could* load, and "why isn't docker here" deserves an answer on the same
		// screen as the question.
		console.log(
			`  ${module.id.padEnd(11)} ${module.description}${runs ? "" : "  [not on this platform]"}`,
		);
		console.log(`  ${" ".repeat(11)} ${flags.join(" · ")}`);
	}
}

async function describeInstalled() {
	const store = moduleStoreDir();
	const modules = await listModules(store);
	if (!modules.length) {
		console.log(
			`\nno modules installed in ${store}\n` +
				`  ${invocation} modules install <repo>   to add one`,
		);
		return;
	}

	console.log(`\ninstalled in ${store}:\n`);
	for (const module of modules) {
		if (isBroken(module)) {
			console.log(`  ${module.id.padEnd(11)} unusable:`);
			for (const problem of module.problems) {
				console.log(`  ${" ".repeat(11)} - ${problem}`);
			}
			continue;
		}
		const { manifest, record } = module;
		const flags = [
			manifest.version ? `v${manifest.version}` : null,
			manifest.tab ? `tab '${manifest.tab.id ?? manifest.id}'` : null,
			`grants ${manifest.grants.join("+") || "none"}`,
			record.commit ? `commit ${record.commit.slice(0, 8)}` : null,
		].filter(Boolean);
		console.log(`  ${manifest.id.padEnd(11)} ${manifest.description}`);
		console.log(`  ${" ".repeat(11)} ${flags.join(" · ")}`);
		console.log(`  ${" ".repeat(11)} from ${record.source}`);
	}
}

const modulesUsage = `Usage:
  ${invocation} modules                          list builtin and installed modules
  ${invocation} modules install <repo> [--ref R] [--force]
  ${invocation} modules update [<id>]
  ${invocation} modules remove <id>

A module is a git repository with a stats.module.json at its root. <repo> is a
URL, a git@host:owner/repo address, owner/repo (GitHub), or a path to a
repository on this machine.`;

async function modulesCommand(sub: string | undefined) {
	switch (sub) {
		case undefined:
		case "list":
			describeBuiltins();
			await describeInstalled();
			// Whoever is reading this list wants to know whether the grants in it
			// are a limit, and that depends on who runs the node — which is very
			// often not whoever is typing this.
			console.log(
				isRoot()
					? "\na node run as root loads modules unrestricted: the grants above are a\ndeclaration of what a module touches, not a limit on what it can."
					: "\na node run as this user is held to the grants above, and to trustedModules\nfor exec and pty. A node run as root is held to neither.",
			);
			break;

		case "install": {
			const spec = process.argv[4];
			if (!spec || spec.startsWith("--")) {
				console.error(`error: no repository given\n\n${modulesUsage}`);
				process.exit(1);
			}
			// Worth saying once, plainly: this is code that will run on this host.
			console.log(`installing ${spec} — its node-side code runs on this host`);
			const { module, replaced } = await installModule(spec, {
				ref: flag("ref"),
				force: toggle("force") === true,
			});
			const { manifest } = module;
			console.log(
				`${replaced ? "replaced" : "installed"} '${manifest.id}' (${manifest.label}) in ${module.dir}`,
			);
			console.log(`  grants ${manifest.grants.join("+") || "none"}`);
			if (manifest.actions.length)
				console.log(`  actions ${manifest.actions.join(", ")}`);
			const privileged = manifest.grants.filter(
				(grant) => grant === "exec" || grant === "pty",
			);
			if (privileged.length) {
				console.warn(
					`  note: this module wants ${privileged.join(" and ")}, which hands it the machine.\n` +
						(isRoot()
							? `  A node running as root gives it that: the grants are a declaration there, not a request.`
							: `  It will not load until you add '${manifest.id}' to trustedModules in the node config.`),
				);
			}
			console.log("restart the node to load it");
			break;
		}

		case "update": {
			const id = process.argv[4];
			const targets = id
				? [id]
				: (await installedModules()).map((module) => module.manifest.id);
			if (!targets.length) {
				console.log("nothing installed to update");
				break;
			}
			for (const target of targets) {
				const { from, to } = await updateModule(target);
				console.log(
					from === to
						? `${target}: already up to date`
						: `${target}: ${from?.slice(0, 8) ?? "?"} → ${to?.slice(0, 8) ?? "?"}`,
				);
			}
			console.log("restart the node to pick up the changes");
			break;
		}

		case "remove": {
			const id = process.argv[4];
			if (!id) {
				console.error(`error: no module named\n\n${modulesUsage}`);
				process.exit(1);
			}
			console.log(`removed ${await removeModule(id)}`);
			break;
		}

		default:
			console.error(`error: unknown subcommand '${sub}'\n\n${modulesUsage}`);
			process.exit(1);
	}
}

/* ---------- update ---------- */

/**
 * Exit codes are the point of `--check`: it goes in a loop over a fleet, and
 * "up to date" and "an update is waiting" have to be distinguishable without
 * parsing prose.
 *
 *   0   up to date (or the update was applied)
 *   10  an update is available (--check only)
 *   1   something went wrong
 */
async function updateCommand() {
	const check = toggle("check") === true;
	const wanted = flag("version");
	const noRestart = toggle("restart") === false;

	const status = await checkForUpdate();
	const target = wanted ?? status.latest;

	console.log(
		`current ${status.current}, ${status.latest} is the latest release`,
	);

	if (check) {
		if (status.behind) {
			console.log(
				`an update is available: ${status.current} → ${status.latest}`,
			);
			process.exit(10);
		}
		console.log("up to date");
		return;
	}

	if (!wanted && !status.behind) {
		console.log("nothing to do");
		return;
	}

	console.log(`installing ${target} (${status.asset})`);
	const result = await applyUpdate({ version: wanted });
	console.log(`${result.from} → ${result.to} at ${result.binary}`);

	if (noRestart) {
		console.log("left the service alone — restart it to pick this up");
		return;
	}

	const unit = await currentUnit();
	if (!unit) {
		// Run over ssh rather than from the unit, which is the normal case: there
		// is no service *here* to restart, and guessing at one would be worse.
		console.log(
			"not running under systemd — restart the service to pick this up:\n" +
				"  systemctl restart stats-node   (or stats-hub)",
		);
		return;
	}
	console.log(`restarting ${unit}`);
	await restartUnit(unit);
}

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

		case "modules":
			await modulesCommand(process.argv[3]);
			break;

		case "update":
			await updateCommand();
			break;

		case "cert": {
			const commonName = process.argv[3];
			if (!commonName || commonName.startsWith("--")) {
				console.error(
					`error: no common name given\n\nUsage:\n  ${invocation} cert <common-name> [--san a,b] [--days 825] [--out DIR] [--config hub.json]\n\n` +
						`Signs a one-off leaf cert with the fleet's own CA (src/hub/ca.ts) — the\n` +
						`same CA every node already trusts via the 'ca' module — and writes\n` +
						`<out>/<common-name>.{cert,key,chain}.pem. Needs hub.json's dbPath, since\n` +
						`that's where the CA lives; run this on the hub, or with --config pointed\n` +
						`at a copy of it.`,
				);
				process.exit(1);
			}
			const config = await loadConfig(flag("config"));
			const sans = flag("san")
				?.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const days = flag("days") ? Number(flag("days")) : undefined;
			const out = flag("out") ?? ".";
			const issued = await issueCert(config.dbPath, { commonName, sans, days });
			await Bun.write(`${out}/${commonName}.cert.pem`, issued.cert);
			await Bun.write(`${out}/${commonName}.key.pem`, issued.key);
			await Bun.write(
				`${out}/${commonName}.chain.pem`,
				`${issued.cert}${issued.caCert}`,
			);
			console.log(
				`wrote ${commonName}.{cert,key,chain}.pem to ${out === "." ? "." : out}`,
			);
			console.log(
				"the key exists only in that file — the hub keeps no copy of a leaf's key",
			);
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
				allowRemoteUpdate: toggle("allow-remote-update"),
				allowHubModules: toggle("allow-hub-modules"),
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
				// loopback, so there is exactly one code path for collection — which
				// includes loading whatever this machine has installed.
				const installed = await installedModules().catch(() => []);
				const node = startNode({
					hubUrl: `ws://127.0.0.1:${config.port}/node`,
					token: config.nodeToken,
					id: process.env.STATS_NODE_ID ?? "hub-local",
					name: process.env.STATS_NODE_NAME ?? "This machine",
					tags: ["hub"],
					telemetryIntervalMs: config.telemetryIntervalMs,
					// The hub's own switches apply, and STATS_MODULES still trims
					// further — this node is in the hub's process, but it is a node.
					modules: resolveModules(
						{
							...config.modules,
							...(process.env.STATS_MODULES
								? parseModuleList(
										process.env.STATS_MODULES,
										installed.map((module) => module.manifest.id),
									)
								: {}),
						},
						[],
						installed.map((module) => toModuleManifest(module.manifest)),
					),
					control: true,
					projectPaths: (process.env.STATS_PROJECTS ?? "./projects.json").split(
						":",
					),
					trustedModules: MODULE_LIST.map((module) => module.id),
					// This node is the hub's own machine, so the hub is as much the
					// source of truth here as anywhere — under root it takes both
					// directions, same as a node that went through loadAgentConfig.
					allowHubModules: isRoot(),
					allowRemoteUpdate: isRoot(),
					installed,
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
