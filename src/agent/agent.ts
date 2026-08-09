import {
	collectContainers,
	containerAction,
	DockerUnavailable,
	dockerAvailable,
} from "../collect/docker.ts";
import { collectFacts } from "../collect/facts.ts";
import { streamLogs } from "../collect/logs.ts";
import {
	collectListeningPorts,
	collectProcesses,
} from "../collect/processes.ts";
import { collectSystem } from "../collect/system.ts";
import {
	collectSystemdSummary,
	collectUnits,
	showUnit,
	systemdAvailable,
	unitAction,
} from "../collect/systemd.ts";
import { MessageType } from "../proto/frame.ts";
import { type InboundRequest, PeerLink, RemoteError } from "../proto/link.ts";
import {
	type ContainerActionParams,
	type HelloPayload,
	type LogsTailParams,
	NodeAction,
	type ProjectActionParams,
	type ProjectsListResult,
	type SnapshotResult,
	type TerminalCloseParams,
	type TerminalOpenParams,
	type TerminalResizeParams,
	type UnitActionParams,
	type UnitShowParams,
	type WelcomePayload,
} from "../proto/messages.ts";
import type {
	LogLine,
	LogQuery,
	NodeCapabilities,
	Telemetry,
} from "../types.ts";
import { versionInfo } from "../version.ts";
import type { AgentConfig } from "./config.ts";
import { Supervisor } from "./supervisor.ts";
import { TerminalManager } from "./terminal.ts";

/**
 * The node half. It dials the hub rather than listening, which is the whole
 * point of the rework: servers behind NAT, a firewall or a dynamic address only
 * need outbound access to one port, and the hub needs no inbound reach at all.
 *
 * One WebSocket carries everything — telemetry out, control in, log and
 * terminal streams both ways.
 */

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Lines pushed per frame when tailing; batching keeps a busy log cheap. */
const LOG_BATCH = 25;
const LOG_BATCH_MS = 100;

export interface AgentHandle {
	stop(): Promise<void>;
	/** resolves the first time the hub accepts this node */
	connected: Promise<void>;
}

export function startNode(config: AgentConfig): AgentHandle {
	const supervisor = new Supervisor(config.projectPaths);
	const terminals = new TerminalManager(config.terminal);

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

	const capabilities: NodeCapabilities = {
		terminal: config.terminal,
		control: config.control,
		projects: true,
		docker: false,
		systemd: false,
		logs: true,
	};

	/* ---------- collection ---------- */

	async function collect(): Promise<{
		telemetry: Telemetry;
		snapshot: SnapshotResult;
	}> {
		const errors: Record<string, string> = {};
		const guard = async <T>(
			name: string,
			fn: () => Promise<T>,
			fallback: T,
		): Promise<T> => {
			try {
				return await fn();
			} catch (err) {
				errors[name] = err instanceof Error ? err.message : String(err);
				return fallback;
			}
		};

		const [stats, facts, containers, processes, units, ports, projects] =
			await Promise.all([
				collectSystem(),
				// Cached and self-healing: every probe inside it already tolerates absence.
				collectFacts(),
				guard("docker", () => collectContainers(), []),
				guard("processes", () => collectProcesses(), []),
				guard("systemd", () => collectUnits(), []),
				guard("ports", () => collectListeningPorts(), []),
				guard("projects", () => supervisor.status(), []),
			]);

		const systemd = await collectSystemdSummary(units);
		const projectErrors = supervisor.definitions.errors;
		if (projectErrors.length) errors.projectsFile = projectErrors.join("; ");

		const snapshot: SnapshotResult = {
			stats,
			facts,
			systemd,
			units,
			containers,
			processes,
			ports,
			projects,
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

	/** Streams log lines to the hub in small batches until the peer hangs up. */
	async function streamLogsTo(req: InboundRequest, query: LogQuery) {
		// Said up front: a quiet log would otherwise look like a handler with no
		// stream at all, and the correlation id would close under it.
		req.stream.open();
		let batch: LogLine[] = [];
		let timer: ReturnType<typeof setTimeout> | null = null;

		const flush = () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (!batch.length || req.stream.closed) return;
			req.stream.json(batch);
			batch = [];
		};
		const push = (line: LogLine) => {
			batch.push(line);
			if (batch.length >= LOG_BATCH) flush();
			else if (!timer) timer = setTimeout(flush, LOG_BATCH_MS);
		};

		if (query.kind === "project") {
			// target is "<projectId>/<processId>"
			const slash = query.target.indexOf("/");
			if (slash === -1)
				throw new RemoteError(
					"bad_request",
					"project log target must be 'project/process'",
				);
			supervisor.tail(
				query.target.slice(0, slash),
				query.target.slice(slash + 1),
				query.tail,
				push,
				req.signal,
			);
			flush();
			if (!query.follow) req.stream.end();
			return;
		}

		void (async () => {
			try {
				for await (const line of streamLogs(query, req.signal)) {
					if (req.signal.aborted) break;
					push(line);
				}
				flush();
				req.stream.end();
			} catch (err) {
				flush();
				if (!req.signal.aborted) {
					req.stream.end({
						code: "log_error",
						message: err instanceof Error ? err.message : String(err),
					});
				}
			}
		})();
	}

	function requireControl() {
		if (!config.control) {
			throw new RemoteError(
				"forbidden",
				"control actions are disabled on this node",
			);
		}
	}

	async function handle(req: InboundRequest): Promise<unknown> {
		const params = (req.params ?? {}) as Record<string, unknown>;

		switch (req.action) {
			case NodeAction.Snapshot:
				return (await collect()).snapshot;

			case NodeAction.FactsRefresh:
				return await collectFacts(true);

			case NodeAction.LogsTail: {
				const p = params as unknown as LogsTailParams;
				const query: LogQuery = {
					kind: p.kind ?? "journal",
					target: String(p.target ?? ""),
					tail: Math.min(Math.max(Number(p.tail) || 200, 1), 5000),
					follow: p.follow !== false,
				};
				if (!query.target)
					throw new RemoteError("bad_request", "missing log target");
				await streamLogsTo(req, query);
				return { streaming: true, ...query };
			}

			case NodeAction.TerminalOpen: {
				const p = params as unknown as TerminalOpenParams;
				if (!config.terminal) {
					throw new RemoteError(
						"forbidden",
						"terminals are disabled on this node",
					);
				}
				const context = p.projectId
					? await supervisor.shellContext(p.projectId)
					: null;
				// Output starts whenever the shell feels like it, which is usually
				// after this handler has already returned.
				req.stream.open();

				const result = await terminals.open({
					...p,
					cwd: p.cwd ?? context?.cwd ?? undefined,
					env: context?.env,
					onData: (data) => req.stream.bytes(data),
					onExit: (code, signal) => {
						if (req.stream.closed) return;
						// A last line so the pane says why it went away rather than freezing.
						req.stream.json({
							event: "exit",
							code,
							signal,
							message: `\r\n[session ended: ${signal ?? `exit ${code ?? 0}`}]\r\n`,
						});
						req.stream.end();
					},
				});

				// Keystrokes arrive as binary frames on this same correlation id.
				req.onData((payload, binary) => {
					if (binary) terminals.write(result.sessionId, payload);
				});
				req.signal.addEventListener(
					"abort",
					() => terminals.close(result.sessionId),
					{ once: true },
				);
				return result;
			}

			case NodeAction.TerminalResize: {
				const p = params as unknown as TerminalResizeParams;
				terminals.resize(p.sessionId, p.cols, p.rows);
				return { ok: true };
			}

			case NodeAction.TerminalClose: {
				terminals.close((params as unknown as TerminalCloseParams).sessionId);
				return { ok: true };
			}

			case NodeAction.UnitShow:
				return await showUnit(
					String((params as unknown as UnitShowParams).unit ?? ""),
				);

			case NodeAction.UnitAction: {
				requireControl();
				const p = params as unknown as UnitActionParams;
				return await unitAction(p.unit, p.verb);
			}

			case NodeAction.ContainerAction: {
				requireControl();
				const p = params as unknown as ContainerActionParams;
				try {
					return await containerAction(p.container, p.verb);
				} catch (err) {
					if (err instanceof DockerUnavailable) {
						throw new RemoteError("docker_unavailable", err.message);
					}
					throw err;
				}
			}

			case NodeAction.ProjectsList: {
				const { projects, sources, errors } = supervisor.definitions;
				return { projects, sources, errors } satisfies ProjectsListResult;
			}

			case NodeAction.ProjectsReload: {
				requireControl();
				const loaded = await supervisor.load();
				return {
					projects: loaded.projects,
					sources: loaded.sources,
					errors: loaded.errors,
				} satisfies ProjectsListResult;
			}

			case NodeAction.ProjectAction: {
				requireControl();
				const p = params as unknown as ProjectActionParams;
				if (p.verb === "start")
					await supervisor.start(p.projectId, p.processId);
				else if (p.verb === "stop")
					await supervisor.stop(p.projectId, p.processId);
				else if (p.verb === "restart")
					await supervisor.restart(p.projectId, p.processId);
				else throw new RemoteError("bad_request", `unknown verb '${p.verb}'`);
				return { ok: true, projects: await supervisor.status() };
			}

			default:
				throw new RemoteError(
					"unknown_action",
					`this node does not handle '${req.action}'`,
				);
		}
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
			const hello: HelloPayload = {
				node: { id: config.id, name: config.name, ...versionInfo },
				token: config.token,
				capabilities: {
					...capabilities,
					docker: await dockerAvailable(),
					systemd: await systemdAvailable(),
				},
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
		.then((loaded) => {
			const count = loaded.projects.reduce(
				(sum, p) => sum + p.processes.length,
				0,
			);
			if (loaded.sources.length) {
				console.log(
					`projects: ${loaded.projects.length} from ${loaded.sources.join(", ")} (${count} process(es))`,
				);
			}
			for (const error of loaded.errors) console.warn(`projects: ${error}`);
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
		async stop() {
			stopped = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			teardown("shutting down");
			socket?.close(1000, "shutting down");
			await supervisor.shutdown();
		},
	};
}
