import { selectProbe } from "../collect/probe.ts";
import { emptyProxmoxSummary } from "../collect/proxmox.ts";
import { hostPolicy } from "../modules/host.ts";
import {
	type ModuleSet,
	moduleOn,
	narrowModules,
} from "../modules/manifest.ts";
import { MessageType } from "../proto/frame.ts";
import { type InboundRequest, PeerLink, RemoteError } from "../proto/link.ts";
import {
	type HelloPayload,
	type ModulesApplyParams,
	type ModulesApplyResult,
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
import { collectIdentity } from "./identity.ts";
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

	/**
	 * The set the hub last asked for, from Welcome or from a modules.apply. Null
	 * until a hub has an opinion, which is also the state of every node whose
	 * operator never touches the module page.
	 */
	let hubModules: ModuleSet | null = null;

	/**
	 * The hub's local CA, from the last Welcome. Read live by the `ca` module
	 * rather than captured at load time, because it can arrive after the module
	 * already loaded once with nothing to trust yet.
	 */
	let trustedCa: { pem: string; fingerprint: string } | null = null;

	/**
	 * What to load: the node's own configuration, then the hub's intent folded
	 * over it. The fold is where the two directions stop being symmetric — see
	 * src/hub/modules.ts — and it is deliberately done here rather than trusted
	 * to the hub's planning: a node enforces its own opt-in.
	 */
	function requestedModules(): ModuleSet {
		if (!hubModules) return config.modules;
		const requested: ModuleSet = { ...config.modules };
		for (const [id, on] of Object.entries(hubModules)) {
			if (on === false) {
				// Always honoured. The hub could achieve this by narrowing anyway.
				requested[id] = false;
			} else if (on === true && config.allowHubModules === true) {
				requested[id] = true;
			}
		}
		return requested;
	}

	/**
	 * The set the current `loaded` was built from. The comparison for "did the
	 * hub change anything" has to be against this and not against what actually
	 * loaded: a module that was asked for and isn't available never appears in
	 * the loaded set, so comparing the two would report a difference on every
	 * connection and reload forever.
	 */
	let loadedRequest: ModuleSet = {};

	async function load(): Promise<LoadedModules> {
		// Installed modules are imported first and then join the builtins as
		// equals: from loadModules down, nothing distinguishes them.
		const external = await loadExternalModules(
			installed,
			config.moduleSettings ?? {},
		);
		const request = requestedModules();
		loadedRequest = request;
		const result = await loadModules(
			{
				config,
				supervisor,
				terminals,
				control: config.control,
				trustedCa: () => trustedCa,
			},
			request,
			hostPolicy(config.trustedModules),
			[...BUILTIN_MODULES, ...external.modules],
		);
		result.notes.unshift(...external.notes);

		loaded = result;
		const active = result.active.map((m) => m.manifest.id).join(", ");
		console.log(`modules: ${active || "none"}`);
		for (const note of result.notes) console.log(`  ${note}`);
		return result;
	}

	let modules = load();

	/**
	 * Re-runs the load with the hub's set folded in. Only ever called between
	 * connections: loading a module runs its availability check and builds it a
	 * host, and doing that under an open terminal or log tail is a much bigger
	 * promise than module management needs. The caller reconnects afterwards so
	 * the new set is announced in a fresh Hello.
	 */
	async function reloadModules(): Promise<void> {
		loaded = null;
		modules = load();
		await modules;
	}

	/** Whether the hub's intent would actually change what we asked to load. */
	function wouldChangeModules(): boolean {
		if (!loaded) return false;
		const requested = requestedModules();
		const ids = new Set([
			...Object.keys(requested),
			...Object.keys(loadedRequest),
		]);
		for (const id of ids) {
			if (moduleOn(requested, id) !== moduleOn(loadedRequest, id)) return true;
		}
		return false;
	}

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
			acceptsHubModules: config.allowHubModules === true,
		};
	}

	/* ---------- collection ---------- */

	/**
	 * A frame is the sum of what the active modules produced. Sections nobody
	 * filled in stay empty rather than absent, so the hub and the dashboard don't
	 * have to care which modules a given node runs.
	 */
	/**
	 * Facts for the handshake, straight from the probe rather than through the
	 * module: at Hello time the answer wanted is "what is this machine", and
	 * whether the operator switched the `system` module off doesn't change it.
	 * Null on a platform with no probe, which the hub renders as an unknown host.
	 */
	async function probeFacts() {
		const probe = await selectProbe();
		if (!probe || !(await probe.available())) return undefined;
		return await probe.facts().catch(() => undefined);
	}

	async function collect(): Promise<{
		telemetry: Telemetry;
		snapshot: SnapshotResult;
	}> {
		const active = loaded ?? (await modules);
		const { parts, errors } = await active.collect();

		// No system module is a supported state, not a failure: a platform with no
		// probe yet still reports its identity and everything else it loaded. If
		// the module *is* loaded and failed, that lands in `errors` and shows on
		// the node's card, which is where a collector failure belongs.

		const projectErrors = supervisor.definitions.errors;
		if (projectErrors.length) errors.projectsFile = projectErrors.join("; ");

		const snapshot: SnapshotResult = {
			host: collectIdentity(),
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
			// Optional, unlike proxmox: a node with no Pi-hole says nothing rather
			// than reporting an empty one, which is what keeps the face off cards
			// that have no business showing it.
			pihole: parts.pihole,
			piholeDetail: parts.piholeDetail,
			ca: parts.ca,
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

	/* ---------- modules the hub asked for ---------- */

	/**
	 * The hub's half of module management, seen from the node.
	 *
	 * Narrowing is always honoured and needs no opt-in — it is the rule this
	 * codebase has always had, and a hub that wants a module hidden gets it
	 * hidden. Widening is the direction that needs `allowHubModules`, and a node
	 * that hasn't opted in answers "no" rather than erroring: the hub is allowed
	 * to ask, and the module page renders the refusal as a state.
	 *
	 * The new set takes effect on reconnect rather than here. Loading a module
	 * runs its availability check and hands it a host built from the policy, and
	 * doing that mid-flight — while a terminal or a log tail is open on a module
	 * about to be dropped — is a much larger promise than this feature needs.
	 * Recording the intent and reconnecting is the whole mechanism.
	 */
	async function applyModules(
		params: ModulesApplyParams,
	): Promise<ModulesApplyResult> {
		const active = loaded ?? (await modules);

		if (config.allowHubModules !== true) {
			// Still apply the subtractive half: the hub could have done this by
			// narrowing anyway, so refusing it outright would be theatre.
			const narrowed = narrowModules(active.set, params.modules ?? {});
			hubModules = narrowed;
			return {
				accepted: false,
				modules: narrowed,
				reason:
					"this node does not accept hub-directed modules — start it with --allow-hub-modules, or run it as root, where that is the default",
				restartRequired: false,
			};
		}

		hubModules = { ...params.modules };
		const changed = wouldChangeModules();
		if (changed) {
			// Reload after this reply is on the wire, not before it: the hub asked a
			// question, and dropping the link mid-answer would look like a failure
			// rather than the node doing exactly what it was told.
			queueMicrotask(() => {
				void reloadModules().then(() => {
					socket?.close(1000, "reloading modules");
				});
			});
		}
		return {
			accepted: true,
			// What is running as this reply is written; `restartRequired` says the
			// set is about to change, and the hub's next Hello is what confirms it.
			modules: active.set,
			restartRequired: changed,
		};
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

			case NodeAction.ModulesApply:
				return await applyModules(req.params as ModulesApplyParams);
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
				"this node does not accept remote updates — start it with --allow-remote-update (the default for a node running as root), or run 'stats update' on the host",
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
		// Deliberately *not* unref'd: while the hub is unreachable this timer is
		// the only thing holding the loop open, and an unref'd one let the node
		// exit 0 between attempts — which systemd reports as a clean shutdown and
		// then restarts, so an unresolvable hub looked like a crash loop instead
		// of a node patiently retrying. stop() clears it.
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, jittered);
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

			// The hub's set arrives here on every connection, so a node picks up
			// intent recorded while it was offline without anyone touching it.
			hubModules = welcome.modules ?? null;

			// A CA that just appeared (or changed) is the one thing `ca`'s own
			// availability check can't notice on its own: it only runs at load time,
			// which for a fresh connection was before this Welcome arrived. Both
			// sides are normalised to `null` — `trustedCa?.fingerprint` reads as
			// `undefined` once optional-chained, and comparing that against a
			// hub with no CA at all (also `null`) must not read as a change.
			const caChanged =
				(welcome.ca?.fingerprint ?? null) !== (trustedCa?.fingerprint ?? null);
			trustedCa = welcome.ca ?? null;

			if (wouldChangeModules() || (caChanged && !loaded?.set.ca)) {
				console.log("hub asked for a different module set — reloading");
				void reloadModules().then(() => {
					// Reconnect rather than announce in place: Hello is the only frame
					// that carries capabilities, and a fresh connection is the one
					// moment nothing is streaming off a module about to be dropped.
					socket?.close(1000, "reloading modules");
				});
				return;
			}

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
				host: collectIdentity(),
				// Best-effort: a platform with no probe says nothing here rather than
				// holding up the handshake, and the hub renders what it was given.
				facts: await probeFacts(),
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
		// A getter, not the promise: a hub-directed set replaces it, and a caller
		// holding the first one would be looking at a module set that has since
		// been reloaded.
		get modules() {
			return modules;
		},
		async stop() {
			stopped = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			teardown("shutting down");
			socket?.close(1000, "shutting down");
			await supervisor.shutdown();
		},
	};
}
