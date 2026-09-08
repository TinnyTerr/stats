import type { ServerWebSocket } from "bun";
import projectsSchema from "../../schema/projects.schema.json" with {
	type: "json",
};
import index from "../../web/index.html";
import { json, requireToken, unauthorized } from "../http.ts";
import { toModuleManifest } from "../modules/external.ts";
import { moduleForAction, moduleOn } from "../modules/manifest.ts";
import { MessageType } from "../proto/frame.ts";
import { type InboundRequest, PeerLink, RemoteError } from "../proto/link.ts";
import {
	type CaIssueParams,
	type CaIssueResult,
	type EventsParams,
	type HelloPayload,
	type HistoryParams,
	HubAction,
	type HubInfoResult,
	type ModulesApplyResult,
	type ModulesFleetParams,
	type ModulesFleetResult,
	type ModulesSetParams,
	type ModulesSetResult,
	NodeAction,
	type NodeScoped,
	type WelcomePayload,
} from "../proto/messages.ts";
import type { HubConfig } from "../types.ts";
import { versionInfo } from "../version.ts";
import { ensureHubCa, issueCert } from "./ca.ts";
import { MetricStore } from "./db.ts";
import { startNotionSync } from "./notion.ts";
import { NodeRegistry, UnauthorizedNode } from "./registry.ts";

/**
 * The hub: listens, never dials. Nodes connect to /node and browsers to /ws,
 * both speaking the same binary protocol, and the hub sits in the middle
 * relaying control requests and streams between them.
 *
 *   node ──ws──▶ /node ─┐
 *   node ──ws──▶ /node ─┼─ registry ─── /ws ◀──ws── browser
 *   node ──ws──▶ /node ─┘      │
 *                            SQLite (history, events, known nodes)
 */

interface SocketData {
	role: "node" | "browser";
	link: PeerLink;
	/** set once the node says Hello */
	nodeId: string | null;
	remoteAddress: string | null;
}

/** Actions whose reply is a stream rather than a single result. */
const STREAMING_ACTIONS = new Set(["logs.tail", "terminal.open"]);

/** How long a relayed one-shot may take before the browser gets an error. */
const RELAY_TIMEOUT_MS = 30_000;

/**
 * Actions that legitimately outlast a click. Timing out on the browser's side
 * wouldn't stop a node mid-update — it would just tell the operator it failed
 * while it carried on, and invite them to press the button again.
 */
const SLOW_ACTIONS = new Map<string, number>([
	[NodeAction.UpdateApply, 10 * 60_000],
]);

export function startHub(config: HubConfig) {
	const store = new MetricStore(config.dbPath);
	const registry = new NodeRegistry(config, store);
	const browsers = new Set<PeerLink>();
	// Outbound-only mirror; null unless hub.json configures it.
	const notion = startNotionSync(config.notion, registry);

	registry.subscribe((event) => {
		// One push shape for every browser: the frame type says "telemetry", the
		// payload's `event` field says which kind.
		const payload =
			event.type === "node"
				? { event: "node", node: event.node }
				: event.type === "telemetry"
					? {
							event: "telemetry",
							nodeId: event.nodeId,
							telemetry: event.telemetry,
						}
					: event.type === "status"
						? {
								event: "status",
								nodeId: event.nodeId,
								status: event.status,
								message: event.message,
								ts: event.ts,
							}
						: {
								event: "alert",
								nodeId: event.nodeId,
								kind: event.kind,
								message: event.message,
								ts: event.ts,
							};

		for (const browser of browsers) {
			if (browser.closed) continue;
			browser.send(MessageType.Telemetry, payload);
		}
	});

	registry.startSweeper();
	store.prune(config.retentionHours);
	const pruneTimer = setInterval(
		() => store.prune(config.retentionHours),
		600_000,
	);
	pruneTimer.unref?.();

	/* ---------- browser control requests ---------- */

	/** Copies one request, and any stream it opens, to the node that owns it. */
	async function relay(req: InboundRequest, nodeId: string): Promise<unknown> {
		const link = registry.linkFor(nodeId);
		// The node would refuse this anyway; refusing it here means a disabled
		// module costs nothing on the wire and says the same thing every time.
		const capabilities = registry.get(nodeId)?.capabilities;
		// The builtin table doesn't know an installed module's actions, so the
		// node's own manifests are consulted alongside it.
		const owner = moduleForAction(
			req.action,
			(capabilities?.externals ?? []).map(toModuleManifest),
		);
		if (owner && !moduleOn(capabilities?.modules, owner)) {
			throw new RemoteError(
				"module_disabled",
				`the '${owner}' module is not enabled on node '${nodeId}'`,
			);
		}
		// The node has no use for the routing field, and shouldn't have to ignore it.
		const { nodeId: _routing, ...params } = (req.params ?? {}) as NodeScoped &
			Record<string, unknown>;

		if (!STREAMING_ACTIONS.has(req.action)) {
			return await link.request(req.action, params, {
				timeoutMs: SLOW_ACTIONS.get(req.action) ?? RELAY_TIMEOUT_MS,
			});
		}

		req.stream.open();
		const upstream = link.openStream(req.action, params, {
			onData: (payload, binary) => req.stream.raw(payload, binary),
			onEnd: (error) => req.stream.end(error),
		});
		// Browser → node: terminal keystrokes and anything else the caller writes.
		req.onData((payload, binary) => upstream.raw(payload, binary));
		req.signal.addEventListener("abort", () => upstream.end(), { once: true });

		return await upstream.ready;
	}

	async function handleBrowserRequest(req: InboundRequest): Promise<unknown> {
		const params = (req.params ?? {}) as Record<string, unknown>;

		switch (req.action) {
			case HubAction.Info:
				return {
					...versionInfo,
					modules: config.modules,
					nodes: registry.list().length,
					time: Date.now(),
				} satisfies HubInfoResult;

			case HubAction.Nodes:
				return registry.summaries();

			case HubAction.Node: {
				const record = registry.get(String(params.nodeId ?? ""));
				if (!record)
					throw new RemoteError("unknown_node", `no node '${params.nodeId}'`);
				return {
					summary: registry.summarise(record),
					telemetry: record.telemetry,
				};
			}

			case HubAction.History: {
				const p = params as unknown as HistoryParams;
				const minutes = Number(p.minutes ?? 60);
				const window = Number.isFinite(minutes)
					? Math.min(Math.max(minutes, 1), 24 * 60)
					: 60;
				// The cap is what a browser can plot, not what the table holds: a
				// caller asking for buckets is asking for the whole window at a
				// resolution it can draw.
				const buckets = Number(p.buckets ?? 0);
				const until = Date.now();
				return store.history(String(p.nodeId ?? ""), until - window * 60_000, {
					untilMs: until,
					buckets:
						Number.isFinite(buckets) && buckets > 0
							? Math.min(Math.max(Math.round(buckets), 2), 1000)
							: undefined,
				});
			}

			case HubAction.Events: {
				const p = params as unknown as EventsParams;
				const minutes = Number(p.minutes ?? 1440);
				const window = Number.isFinite(minutes)
					? Math.min(Math.max(minutes, 1), 7 * 24 * 60)
					: 1440;
				return store.events(Date.now() - window * 60_000, 200, p.nodeId);
			}

			case HubAction.Forget: {
				registry.forget(String(params.nodeId ?? ""));
				return { ok: true, nodes: registry.summaries() };
			}

			case HubAction.Modules: {
				const p = params as ModulesFleetParams;
				const records = p.nodeId
					? [registry.get(p.nodeId)].filter((r) => r !== undefined)
					: registry.list();
				return {
					nodes: records.map((record) => registry.moduleView(record)),
					fleet: config.modules,
				} satisfies ModulesFleetResult;
			}

			case HubAction.CaIssue: {
				if (config.modules.ca === false) {
					throw new RemoteError(
						"ca_disabled",
						"the ca module is switched off for this fleet in hub.json",
					);
				}
				const p = params as unknown as CaIssueParams;
				if (!p.commonName?.trim()) {
					throw new RemoteError("bad_request", "commonName is required");
				}
				return (await issueCert(config.dbPath, {
					commonName: p.commonName.trim(),
					sans: p.sans?.map((s) => s.trim()).filter(Boolean),
					days: p.days,
				})) satisfies CaIssueResult;
			}

			case HubAction.ModulesSet: {
				const p = params as unknown as ModulesSetParams;
				const record = registry.get(p.nodeId);
				if (!record) {
					throw new RemoteError("unknown_node", `no node '${p.nodeId}'`);
				}
				registry.setDesiredModules(p.nodeId, p.modules ?? {});

				// Intent is recorded either way. Pushing it now is the difference
				// between "it takes effect" and "it takes effect when that machine
				// next dials in", which the page needs to be able to say.
				let applied = false;
				let refused: string | undefined;
				if (record.link && !record.link.closed) {
					const result = (await relay(
						{
							action: NodeAction.ModulesApply,
							params: { modules: registry.plannedModules(p.nodeId) },
						} as InboundRequest,
						p.nodeId,
					).catch(() => null)) as ModulesApplyResult | null;
					applied = result?.accepted === true;
					if (result && !result.accepted) refused = result.reason;
				}

				return {
					nodeId: p.nodeId,
					modules: registry.moduleView(record).modules,
					applied,
					refused,
				} satisfies ModulesSetResult;
			}

			default: {
				const nodeId = params.nodeId;
				if (typeof nodeId !== "string" || !nodeId) {
					throw new RemoteError(
						"bad_request",
						`'${req.action}' is not a hub action and carries no nodeId to relay it to`,
					);
				}
				return await relay(req, nodeId);
			}
		}
	}

	/* ---------- sockets ---------- */

	function makeLink(
		ws: ServerWebSocket<SocketData>,
		name: string,
		parity: "odd" | "even",
	) {
		// A browser has no sync gunzip, so it would drop every frame we compressed.
		// permessage-deflate gets the bytes back at the transport layer instead,
		// where the browser inflates them before we ever see them.
		const isBrowser = ws.data.role === "browser";
		return new PeerLink(
			{
				send: (data) => {
					// Backpressure here means a browser that stopped reading; dropping the
					// frame is better than growing the buffer without limit.
					if (ws.readyState === WebSocket.OPEN) ws.send(data, isBrowser);
				},
				close: (code, reason) => ws.close(code, reason),
			},
			{
				parity,
				name,
				compress: !isBrowser,
				onError: (err) => console.error(`${name}: ${err.message}`),
			},
		);
	}

	async function onNodeHello(
		ws: ServerWebSocket<SocketData>,
		payload: Uint8Array,
	) {
		const link = ws.data.link;
		let hello: HelloPayload;
		try {
			hello = JSON.parse(new TextDecoder().decode(payload)) as HelloPayload;
		} catch {
			link.error("bad_request", "Hello is not valid JSON");
			ws.close(4000, "bad hello");
			return;
		}

		try {
			const record = registry.attach(hello, link, ws.data.remoteAddress);
			ws.data.nodeId = record.id;

			const welcome: WelcomePayload = {
				hub: versionInfo,
				name: record.name,
				telemetryIntervalMs: config.telemetryIntervalMs,
				// The plan for *this* node, not the fleet switches: narrowing folded
				// together with whatever the module page recorded for it, including
				// while it was offline. See src/hub/modules.ts.
				modules: registry.plannedModules(record.id),
				time: Date.now(),
				// Subtractive like every other fleet switch: hub.json can turn `ca`
				// off everywhere, and a hub with no openssl to generate one just
				// sends nothing rather than failing the handshake over it.
				ca:
					config.modules.ca === false
						? undefined
						: await ensureHubCa(config.dbPath).catch((err) => {
								console.warn(`local CA unavailable: ${err.message}`);
								return undefined;
							}),
			};
			link.send(MessageType.Welcome, welcome);
			console.log(
				`node '${record.id}' (${record.name}) connected from ${ws.data.remoteAddress ?? "unknown"}` +
					` — stats ${record.version ?? "?"}, protocol ${record.protocol ?? "?"}`,
			);
			if (record.protocol !== versionInfo.protocol) {
				console.warn(
					`warning: node '${record.id}' speaks protocol ${record.protocol}, hub speaks ` +
						`${versionInfo.protocol} — update it`,
				);
			}
		} catch (err) {
			const code = err instanceof UnauthorizedNode ? err.code : "error";
			const message = err instanceof Error ? err.message : String(err);
			console.warn(
				`node rejected from ${ws.data.remoteAddress ?? "unknown"}: ${message}`,
			);
			link.error(code, message);
			// Give the frame a moment to flush before the socket goes away.
			setTimeout(() => ws.close(4003, code), 50);
		}
	}

	const server = Bun.serve<SocketData>({
		port: config.port,
		hostname: config.host,
		// Terminals and log tails are idle for long stretches; the protocol's own
		// heartbeat is what detects a dead peer.
		idleTimeout: 0,

		routes: {
			"/": index,

			"/api/health": () =>
				json({
					ok: true,
					role: "hub",
					...versionInfo,
					nodes: registry.list().length,
					online: registry.list().filter((n) => n.link && !n.link.closed)
						.length,
					time: Date.now(),
				}),

			/** Served so a projects file can point its $schema at its own hub. */
			"/schema/projects.schema.json": () =>
				json(projectsSchema, 200, { "cache-control": "public, max-age=300" }),

			/** A read-only REST mirror of the browser protocol, for curl and scripts. */
			"/api/nodes": (req: Request) =>
				requireToken(req, config.token)
					? json(registry.summaries())
					: unauthorized(),

			"/api/nodes/:id": (req: Request) => {
				if (!requireToken(req, config.token)) return unauthorized();
				const { id } = (req as Request & { params: { id: string } }).params;
				const record = registry.get(id);
				if (!record) return json({ error: `unknown node '${id}'` }, 404);
				return json({
					...registry.summarise(record),
					telemetry: record.telemetry,
				});
			},

			"/api/nodes/:id/history": (req: Request) => {
				if (!requireToken(req, config.token)) return unauthorized();
				const { id } = (req as Request & { params: { id: string } }).params;
				const query = new URL(req.url).searchParams;
				const minutes = Number(query.get("minutes") ?? 60);
				const window = Number.isFinite(minutes)
					? Math.min(minutes, 24 * 60)
					: 60;
				// Same deal as the socket action: a long window is only honest when
				// it is bucketed, since the row cap otherwise takes a slice of it.
				const buckets = Number(query.get("buckets") ?? 0);
				const until = Date.now();
				return json(
					store.history(id, until - window * 60_000, {
						untilMs: until,
						buckets:
							Number.isFinite(buckets) && buckets > 0
								? Math.min(Math.max(Math.round(buckets), 2), 1000)
								: undefined,
					}),
				);
			},

			"/api/events": (req: Request) => {
				if (!requireToken(req, config.token)) return unauthorized();
				const minutes = Number(
					new URL(req.url).searchParams.get("minutes") ?? 1440,
				);
				const window = Number.isFinite(minutes) ? minutes : 1440;
				return json(store.events(Date.now() - window * 60_000));
			},
		},

		fetch(req, srv) {
			const url = new URL(req.url);
			const remoteAddress = srv.requestIP(req)?.address ?? null;

			if (url.pathname === "/node") {
				// The node's own token is checked in Hello, where a mismatch can be
				// reported in-protocol rather than as a bare HTTP status.
				const upgraded = srv.upgrade(req, {
					data: {
						role: "node",
						link: null as never,
						nodeId: null,
						remoteAddress,
					},
				});
				return upgraded
					? undefined
					: json({ error: "websocket upgrade failed" }, 400);
			}

			if (url.pathname === "/ws") {
				if (!requireToken(req, config.token)) return unauthorized();
				const upgraded = srv.upgrade(req, {
					data: {
						role: "browser",
						link: null as never,
						nodeId: null,
						remoteAddress,
					},
				});
				return upgraded
					? undefined
					: json({ error: "websocket upgrade failed" }, 400);
			}

			return json({ error: "not found" }, 404);
		},

		websocket: {
			// Terminal output and log tails are bursty; a bigger backpressure limit
			// keeps Bun from closing a socket mid-scrollback.
			backpressureLimit: 16 * 1024 * 1024,

			// Negotiated with browsers only: node links gzip their own payloads, and
			// deflating those again would cost CPU for nothing. See makeLink.
			perMessageDeflate: true,

			open(ws) {
				const isNode = ws.data.role === "node";
				const link = makeLink(
					ws,
					isNode ? `node@${ws.data.remoteAddress ?? "?"}` : "browser",
					// The hub allocates odd correlation ids on every link it terminates.
					"odd",
				);
				ws.data.link = link;

				if (isNode) {
					link.on(MessageType.Hello, (frame) => onNodeHello(ws, frame.payload));
					link.on(MessageType.Telemetry, (frame) => {
						if (!ws.data.nodeId) return;
						try {
							registry.telemetry(
								ws.data.nodeId,
								JSON.parse(new TextDecoder().decode(frame.payload)),
							);
						} catch (err) {
							console.error(
								`bad telemetry from ${ws.data.nodeId}: ${String(err)}`,
							);
						}
					});
					// A node may ask the hub for nothing; anything it sends is a mistake.
					link.onRequest((req) => {
						throw new RemoteError(
							"unsupported",
							`the hub does not handle '${req.action}'`,
						);
					});
					return;
				}

				browsers.add(link);
				link.onRequest((req) => handleBrowserRequest(req));
				// Paint immediately rather than after the first node reports.
				link.send(MessageType.Telemetry, {
					event: "nodes",
					nodes: registry.summaries(),
				});
			},

			message(ws, raw) {
				const link = ws.data.link;
				if (!link) return;
				if (typeof raw === "string")
					link.receive(new TextEncoder().encode(raw));
				else link.receive(raw);
			},

			close(ws, code, reason) {
				const link = ws.data.link;
				if (!link) return;
				link.dispose(reason || `socket closed (${code})`);
				if (ws.data.role === "browser") {
					browsers.delete(link);
				} else if (ws.data.nodeId) {
					registry.detach(
						ws.data.nodeId,
						link,
						reason || `socket closed (${code})`,
					);
				}
			},
		},

		error: (err) => json({ error: err.message }, 500),

		development: process.env.NODE_ENV !== "production" && {
			hmr: true,
			console: true,
		},
	});

	const shutdown = () => {
		clearInterval(pruneTimer);
		notion?.stop();
		registry.stop();
		store.close();
		void server.stop(true);
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	return { server, registry, store, notion };
}
