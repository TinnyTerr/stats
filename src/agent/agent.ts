import { collectFacts } from "../collect/facts.ts";
import { emptyProxmoxSummary } from "../collect/proxmox.ts";
import { defaultPolicy } from "../modules/host.ts";
import { MessageType } from "../proto/frame.ts";
import { type InboundRequest, PeerLink, RemoteError } from "../proto/link.ts";
import {
	type HelloPayload,
	NodeAction,
	type SnapshotResult,
	type UpdateApplyParams,
	type UpdateApplyResult,
	type UpdateCheckResult,
	type WelcomePayload,
} from "../proto/messages.ts";
import type { NodeCapabilities, Telemetry } from "../types.ts";
import {
	applyUpdate,
	checkForUpdate,
	currentUnit,
	restartUnit,
} from "../update.ts";
import { versionInfo } from "../version.ts";
import type { AgentConfig } from "./config.ts";
import { loadExternalModules } from "./modules/external.ts";
import {
	BUILTIN_MODULES,
	type LoadedModules,
	loadModules,
} from "./modules/index.ts";
import { Supervisor } from "./supervisor.ts";
import { TerminalManager } from "./terminal.ts";

/**
 * The node half. It dials the hub rather than listening, which is the whole
 * point of the rework: servers behind NAT, a firewall or a dynamic address only
 * need outbound access to one port, and the hub needs no inbound reach at all.
 *
 * One WebSocket carries everything — telemetry out, control in, log and
 * terminal streams both ways.
 *
 * What a node can actually do is assembled at startup from src/agent/modules/:
 * this file knows how to collect a frame from whatever loaded and how to route
 * an action to whichever module owns it, and nothing about docker, systemd or
 * ptys beyond that.
 */

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export interface AgentHandle {
	stop(): Promise<void>;
	/** resolves the first time the hub accepts this node */
	connected: Promise<void>;
	/** what the node loaded; resolves once the module set is settled */
	modules: Promise<LoadedModules>;
}

export function startNode(config: AgentConfig): AgentHandle {
	const supervisor = new Supervisor(config.projectPaths);
	const terminals = new TerminalManager(config.modules.terminal !== false);

	let socket: WebSocket | null = null;
	let link: PeerLink | null = null;
	let telemetryTimer: ReturnType<typeof setInterval> | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectDelay = RECONNECT_MIN_MS;
	let stopped = false;
	let seq = 0;
	/** Set by Welcome; a node never sends faster than the hub asked for. */
	let intervalMs = config.telemetryIntervalMs;
	let sending = false;

	let announceConnected!: () => void;
	const connected = new Promise<void>((resolve) => {
		announceConnected = resolve;
	});

	/* ---------- modules ---------- */

	let loaded: LoadedModules | null = null;
	const installed = config.installed ?? [];

	const modules = (async () => {
		// Installed modules are imported first and then join the builtins as
		// equals: from loadModules down, nothing distinguishes them.
		const external = await loadExternalModules(
			installed,
			config.moduleSettings ?? {},
		);
		const result = await loadModules(
			{ config, supervisor, terminals, control: config.control },
			config.modules,
			defaultPolicy(config.trustedModules),
			[...BUILTIN_MODULES, ...external.modules],
		);
		result.notes.unshift(...external.notes);

		loaded = result;
		const active = result.active.map((m) => m.manifest.id).join(", ");
		console.log(`modules: ${active || "none"}`);
		for (const note of result.notes) console.log(`  ${note}`);
		return result;
	})();

	/** The manifests for installed modules that actually loaded. */
	function externals() {
		return installed
			.filter((module) => loaded?.set[module.manifest.id])
			.map((module) => module.manifest);
	}

	function capabilities(): NodeCapabilities {
		return {
			modules: loaded?.set ?? {},
			control: config.control,
			externals: externals(),
		};
	}

	/* ---------- collection ---------- */

	/**
	 * A frame is the sum of what the active modules produced. Sections nobody
	 * filled in stay empty rather than absent, so the hub and the dashboard don't
	 * have to care which modules a given node runs.
	 */
	async function collect(): Promise<{
		telemetry: Telemetry;
		snapshot: SnapshotResult;
	}> {
		const active = loaded ?? (await modules);
		const { parts, errors } = await active.collect();

		if (!parts.stats || !parts.facts) {
			throw new Error(
				`the system module produced nothing: ${errors.system ?? "unknown reason"}`,
			);
		}

		const projectErrors = supervisor.definitions.errors;
		if (projectErrors.length) errors.projectsFile = projectErrors.join("; ");

		const snapshot: SnapshotResult = {
			stats: parts.stats,
			facts: parts.facts,
			systemd: parts.systemd ?? {
				available: false,
				version: null,
				state: null,
				total: 0,
				active: 0,
				failed: [],
			},
			units: parts.units ?? [],
			containers: parts.containers ?? [],
			processes: parts.processes ?? [],
			ports: parts.ports ?? [],
			projects: parts.projects ?? [],
			proxmox: parts.proxmox ?? emptyProxmoxSummary(),
			guests: parts.guests ?? [],
			extras: parts.extras ?? {},
			errors,
		};

		return {
			telemetry: {
				node: { id: config.id, name: config.name, ...versionInfo },
				seq: ++seq,
				...snapshot,
			},
			snapshot,
		};
	}

	async function sendTelemetry() {
		// Collection can outlast the interval on a loaded box; skip rather than pile up.
		if (!link || link.closed || sending) return;
		sending = true;
		try {
			const { telemetry } = await collect();
			if (link && !link.closed) link.send(MessageType.Telemetry, telemetry);
		} catch (err) {
			console.error(
				`telemetry failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			sending = false;
		}
	}

	/* ---------- control ---------- */

	async function handle(req: InboundRequest): Promise<unknown> {
		const active = loaded ?? (await modules);

		// The two actions the agent itself owns: everything else belongs to a
		// module, and dispatch() explains it when the owner isn't loaded.
		switch (req.action) {
			case NodeAction.Snapshot:
				return (await collect()).snapshot;

			case NodeAction.Modules:
				return {
					modules: active.set,
					control: config.control,
					notes: active.notes,
					externals: externals(),
				};

			// Read-only, and allowed even on a node that refuses to be updated —
			// "you are three versions behind and won't take one" is exactly what
			// the dashboard should be able to say.
			case NodeAction.UpdateCheck: {
				const status = await checkForUpdate();
				return {
					current: status.current,
					latest: status.latest,
					behind: status.behind,
					asset: status.asset,
					allowed: config.allowRemoteUpdate === true,
				} satisfies UpdateCheckResult;
			}

			case NodeAction.UpdateApply:
				return await selfUpdate(req.params as UpdateApplyParams);
		}

		const handler = active.dispatch(req.action);
		if (!handler) {
			throw new RemoteError(
				"unknown_action",
				`this node does not handle '${req.action}'`,
			);
		}
		return await handler(req);
	}

	/* ---------- self-update ---------- */

	/**
	 * The hub can ask for this; it cannot say where from. Everything about which
	 * release, which build and which checksum is decided here, against the forge
	 * this node was configured with — see src/update.ts.
	 */
	async function selfUpdate(
		params: UpdateApplyParams = {},
	): Promise<UpdateApplyResult> {
		if (!config.allowRemoteUpdate) {
			throw new RemoteError(
				"forbidden",
				"this node does not accept remote updates — start it with --allow-remote-update, or run 'stats update' on the host",
			);
		}
		if (!config.control) {
			throw new RemoteError(
				"forbidden",
				"control actions are disabled on this node",
			);
		}

		const result = await applyUpdate({
			version: typeof params.version === "string" ? params.version : undefined,
		});
		const unit = await currentUnit();
		const restarting = params.restart !== false && unit !== null;

		if (restarting) {
			// The response has to reach the hub before systemd takes this process
			// away, so the restart is scheduled rather than awaited. The binary is
			// already swapped either way; the delay only decides whether the caller
			// hears about it.
			setTimeout(() => void restartUnit(unit!), 750).unref?.();
		}

		return { from: result.from, to: result.to, unit, restarting };
	}

	/* ---------- connection lifecycle ---------- */

	function scheduleReconnect(why: string) {
		if (stopped || reconnectTimer) return;
		const delay = reconnectDelay;
		// Full jitter, so a hub restart doesn't get a thundering herd of nodes.
		const jittered = Math.round(delay / 2 + Math.random() * (delay / 2));
		console.warn(
			`disconnected (${why}); reconnecting in ${Math.round(jittered / 1000)}s`,
		);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, jittered);
		reconnectTimer.unref?.();
		reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	}

	function teardown(why: string) {
		if (telemetryTimer) clearInterval(telemetryTimer);
		telemetryTimer = null;
		link?.dispose(why);
		link = null;
		terminals.closeAll();
	}

	function connect() {
		if (stopped) return;

		const ws = new WebSocket(config.hubUrl);
		ws.binaryType = "arraybuffer";
		socket = ws;

		const peer = new PeerLink(
			{
				send: (data) => {
					if (ws.readyState === WebSocket.OPEN) ws.send(data);
				},
				close: (code, reason) => ws.close(code, reason),
			},
			{
				// The hub allocates odd ids, the node even ones.
				parity: "even",
				name: `node ${config.id}`,
				onError: (err) => {
					// An Error frame with correlation 0 is the hub talking about the link
					// itself — a rejected Hello, most often.
					if (err instanceof RemoteError) {
						console.error(
							`hub rejected this node: ${err.code} — ${err.message}`,
						);
						// Bad credentials won't fix themselves in a second; back all the way off.
						if (err.code === "unauthorized" || err.code === "unknown_node") {
							reconnectDelay = RECONNECT_MAX_MS;
						}
						return;
					}
					console.error(`link: ${err.message}`);
				},
			},
		);
		link = peer;
		peer.onRequest((req) => handle(req));

		peer.on(MessageType.Welcome, (frame) => {
			const welcome = JSON.parse(
				new TextDecoder().decode(frame.payload),
			) as WelcomePayload;
			reconnectDelay = RECONNECT_MIN_MS;
			intervalMs = Math.max(
				1000,
				welcome.telemetryIntervalMs || config.telemetryIntervalMs,
			);

			const skewMs = Math.abs(Date.now() - welcome.time);
			const skew =
				skewMs > 60_000
					? `, clock differs by ${Math.round(skewMs / 1000)}s`
					: "";
			console.log(
				`connected to hub ${welcome.hub.version} as '${welcome.name}' ` +
					`(telemetry every ${Math.round(intervalMs / 1000)}s${skew})`,
			);

			void sendTelemetry();
			telemetryTimer = setInterval(() => void sendTelemetry(), intervalMs);
			peer.startHeartbeat(Math.max(15_000, intervalMs * 3));
			announceConnected();
		});

		ws.onopen = async () => {
			// Modules are probed once, at load: a docker socket that appears later
			// is picked up on the next reconnect, which is also when the hub gets a
			// chance to hear about it.
			await modules;
			const hello: HelloPayload = {
				node: { id: config.id, name: config.name, ...versionInfo },
				token: config.token,
				capabilities: capabilities(),
				facts: await collectFacts(),
				startedAt: startedAt,
			};
			peer.send(MessageType.Hello, hello);
		};

		ws.onmessage = (event) => {
			const data = event.data;
			if (data instanceof ArrayBuffer) peer.receive(data);
			else if (typeof data === "string")
				peer.receive(new TextEncoder().encode(data));
		};

		ws.onclose = (event) => {
			teardown(`socket closed (${event.code})`);
			scheduleReconnect(event.reason || `code ${event.code}`);
		};

		ws.onerror = () => {
			// onclose always follows, and carries the detail worth printing.
			if (ws.readyState !== WebSocket.CLOSED) ws.close();
		};
	}

	const startedAt = Date.now();

	// Projects come up before the link does: a node that can't reach its hub
	// should still be running what it was told to run.
	void supervisor
		.load()
		.then((files) => {
			const count = files.projects.reduce(
				(sum, p) => sum + p.processes.length,
				0,
			);
			if (files.sources.length) {
				console.log(
					`projects: ${files.projects.length} from ${files.sources.join(", ")} (${count} process(es))`,
				);
			}
			for (const error of files.errors) console.warn(`projects: ${error}`);
		})
		.catch((err: unknown) => {
			console.error(
				`projects failed to load: ${err instanceof Error ? err.message : String(err)}`,
			);
		})
		.finally(connect);

	// A process crashing or coming back is worth reporting straight away rather
	// than at the next tick.
	supervisor.onChange(() => {
		if (link && !link.closed) void sendTelemetry();
	});

	return {
		connected,
		modules,
		async stop() {
			stopped = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			teardown("shutting down");
			socket?.close(1000, "shutting down");
			await supervisor.shutdown();
		},
	};
}
