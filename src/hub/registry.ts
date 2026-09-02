import { headline } from "../modules/external.ts";
import { type ModuleSet, narrowModules } from "../modules/manifest.ts";
import type { PeerLink } from "../proto/link.ts";
import type { HelloPayload } from "../proto/messages.ts";
import type {
	HostIdentity,
	HubConfig,
	NodeCapabilities,
	NodeOverride,
	NodeSummary,
	Telemetry,
} from "../types.ts";
import { type MetricStore, statusMessage } from "./db.ts";
import {
	type NodeModuleView,
	nodePlatform,
	plannedModules,
	resolveNodeModules,
} from "./modules.ts";

/**
 * Who is connected, what they last said, and how to reach them.
 *
 * A node exists here from the first time it says Hello until someone forgets
 * it: disconnecting makes it offline, not absent, because "the box that should
 * be here isn't" is the single most useful thing a dashboard can tell you.
 */

export interface NodeRecord {
	id: string;
	name: string;
	tags: string[];
	notes: string | null;
	link: PeerLink | null;
	capabilities: NodeCapabilities | null;
	/** name, addresses and platform, from Hello — never module-derived */
	host: HostIdentity | null;
	telemetry: Telemetry | null;
	version: string | null;
	protocol: number | null;
	connectedAt: number | null;
	lastSeen: number | null;
	remoteAddress: string | null;
}

export type RegistryEvent =
	| { type: "node"; node: NodeSummary }
	| {
			type: "status";
			nodeId: string;
			status: "online" | "offline";
			message: string;
			ts: number;
	  }
	| { type: "alert"; nodeId: string; kind: string; message: string; ts: number }
	| { type: "telemetry"; nodeId: string; telemetry: Telemetry };

type Listener = (event: RegistryEvent) => void;

export class UnauthorizedNode extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export class NodeRegistry {
	private nodes = new Map<string, NodeRecord>();
	private listeners = new Set<Listener>();
	private overrides = new Map<string, NodeOverride>();
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private config: HubConfig,
		private store: MetricStore,
	) {
		for (const override of config.nodes)
			this.overrides.set(override.id, override);

		// Nodes seen in a previous run start offline, so the grid isn't empty after
		// a hub restart and a machine that never came back is still visible.
		for (const known of store.knownNodes()) {
			const override = this.overrides.get(known.id);
			this.nodes.set(known.id, {
				id: known.id,
				name: override?.name ?? known.name,
				tags: override?.tags ?? [],
				notes: override?.notes ?? null,
				link: null,
				capabilities: null,
				// Restored from SQLite, which keeps a hostname but not the rest of the
				// identity; the next Hello fills it in.
				host: null,
				telemetry: null,
				version: known.version,
				protocol: null,
				connectedAt: null,
				lastSeen: known.lastSeen,
				remoteAddress: null,
			});
		}
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: RegistryEvent) {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// a broken subscriber must not stall the registry
			}
		}
	}

	/**
	 * Checks a node's credentials and registers its link. Throws
	 * {@link UnauthorizedNode} rather than returning a result, so the caller can
	 * turn it straight into an Error frame.
	 */
	attach(
		hello: HelloPayload,
		link: PeerLink,
		remoteAddress: string | null,
	): NodeRecord {
		const id = hello.node?.id?.trim();
		if (!id || !/^[a-zA-Z0-9_.-]{1,128}$/.test(id)) {
			throw new UnauthorizedNode(
				"bad_request",
				`invalid node id '${hello.node?.id ?? ""}'`,
			);
		}

		const override = this.overrides.get(id);
		const expected = override?.token ?? this.config.nodeToken;
		if (expected && hello.token !== expected) {
			throw new UnauthorizedNode("unauthorized", "node token rejected");
		}
		if (!override && !this.config.allowUnknownNodes) {
			throw new UnauthorizedNode(
				"unknown_node",
				`node '${id}' is not listed in the hub config and allowUnknownNodes is false`,
			);
		}

		const existing = this.nodes.get(id);
		if (existing?.link && !existing.link.closed) {
			// Two processes claiming one id would fight over telemetry; the newcomer
			// wins, since the usual cause is a restart whose old socket is still open.
			existing.link.close(
				"replaced by a newer connection for this node id",
				4001,
			);
		}

		const record: NodeRecord = {
			id,
			name: override?.name ?? hello.node.name ?? id,
			tags: override?.tags ?? [],
			notes: override?.notes ?? null,
			link,
			capabilities: this.narrow(hello.capabilities),
			// A node that predates the identity block still has telemetry to fall
			// back on; one that loads no modules has nothing else at all.
			host: hello.host ?? existing?.host ?? null,
			telemetry: existing?.telemetry ?? null,
			version: hello.node.version ?? null,
			protocol: hello.node.protocol ?? null,
			connectedAt: Date.now(),
			lastSeen: Date.now(),
			remoteAddress,
		};
		this.nodes.set(id, record);

		this.store.seen({
			id,
			name: record.name,
			version: record.version,
			hostname: hello.host?.hostname ?? hello.facts?.hostname ?? null,
		});
		const message = statusMessage(
			record.name,
			"online",
			remoteAddress ?? undefined,
		);
		this.store.recordEvent(id, "online", message);
		this.emit({
			type: "status",
			nodeId: id,
			status: "online",
			message,
			ts: Date.now(),
		});
		this.emit({ type: "node", node: this.summarise(record) });
		return record;
	}

	/** The hub can only take capabilities away from what a node offers. */
	private narrow(capabilities: NodeCapabilities | undefined): NodeCapabilities {
		// A node old enough to predate modules announces none, and gets none: it
		// still reports telemetry, it just can't be asked to do anything.
		const modules = narrowModules(
			capabilities?.modules ?? {},
			this.config.modules,
		);
		return {
			control: capabilities?.control ?? false,
			// The node's own answer, passed through untouched: whether it accepts
			// hub-directed modules is its decision, and narrowing is not the place
			// to have an opinion about it.
			acceptsHubModules: capabilities?.acceptsHubModules === true,
			modules,
			// A manifest for a module the hub just switched off would put a tab in
			// the dashboard for something the node will refuse to talk about.
			externals: (capabilities?.externals ?? []).filter(
				(external) => modules[external.id] === true,
			),
		};
	}

	detach(id: string, link: PeerLink, reason: string) {
		const record = this.nodes.get(id);
		// A late close from a replaced socket must not evict the live one.
		if (!record || record.link !== link) return;

		record.link = null;
		record.connectedAt = null;
		const message = statusMessage(record.name, "offline", reason);
		this.store.recordEvent(id, "offline", message);
		this.emit({
			type: "status",
			nodeId: id,
			status: "offline",
			message,
			ts: Date.now(),
		});
		this.emit({ type: "node", node: this.summarise(record) });
	}

	telemetry(id: string, telemetry: Telemetry) {
		const record = this.nodes.get(id);
		if (!record) return;

		const previous = record.telemetry;
		record.telemetry = telemetry;
		record.lastSeen = Date.now();
		// History is the system module's data; a node without it still connects,
		// still raises alerts and still appears — it just has no graph.
		if (telemetry.stats) this.store.record(id, telemetry.stats);
		if (telemetry.host) record.host = telemetry.host;
		this.store.seen({
			id,
			name: record.name,
			version: record.version,
			hostname: telemetry.host?.hostname ?? telemetry.stats?.hostname ?? null,
		});

		for (const alert of diffAlerts(previous, telemetry)) {
			this.store.recordEvent(id, alert.kind, alert.message);
			this.emit({ type: "alert", nodeId: id, ...alert, ts: Date.now() });
		}

		this.emit({ type: "telemetry", nodeId: id, telemetry });
		this.emit({ type: "node", node: this.summarise(record) });
	}

	get(id: string): NodeRecord | undefined {
		return this.nodes.get(id);
	}

	/* ---------- modules ---------- */

	/**
	 * What this node should be running, per the hub. Sent in Welcome, so a node
	 * picks up intent recorded while it was offline simply by reconnecting.
	 * Narrowing is unconditional; widening depends on the node's opt-in, and
	 * plannedModules() is where those two stop being symmetric.
	 */
	plannedModules(id: string): ModuleSet {
		const record = this.nodes.get(id);
		return plannedModules({
			announced: record?.capabilities?.modules ?? {},
			desired: this.store.desiredModules(id),
			fleet: this.config.modules,
			acceptsHubModules: record?.capabilities?.acceptsHubModules === true,
		});
	}

	/** One node's rows on the hub's module page: intent beside reality. */
	moduleView(record: NodeRecord): NodeModuleView {
		return {
			nodeId: record.id,
			name: record.name,
			online: Boolean(record.link && !record.link.closed),
			platform: nodePlatform(
				record.host?.platform ?? record.telemetry?.host?.platform ?? null,
			),
			acceptsHubModules: record.capabilities?.acceptsHubModules === true,
			modules: resolveNodeModules({
				announced: record.capabilities?.modules ?? {},
				desired: this.store.desiredModules(record.id),
				fleet: this.config.modules,
				acceptsHubModules: record.capabilities?.acceptsHubModules === true,
				platform: nodePlatform(
					record.host?.platform ?? record.telemetry?.host?.platform ?? null,
				),
				externals: record.capabilities?.externals,
			}),
		};
	}

	/** Records the hub's intent. Null for a module drops the hub's opinion. */
	setDesiredModules(id: string, modules: Record<string, boolean | null>) {
		const set: Record<string, boolean> = {};
		for (const [moduleId, wanted] of Object.entries(modules)) {
			if (wanted === null) this.store.clearDesiredModule(id, moduleId);
			else set[moduleId] = wanted;
		}
		if (Object.keys(set).length) this.store.setDesiredModules(id, set);
	}

	/** The live link for a node, or an explanation of why there isn't one. */
	linkFor(id: string): PeerLink {
		const record = this.nodes.get(id);
		if (!record)
			throw new UnauthorizedNode(
				"unknown_node",
				`no node '${id}' has ever connected`,
			);
		if (!record.link || record.link.closed) {
			throw new UnauthorizedNode("node_offline", `node '${id}' is offline`);
		}
		return record.link;
	}

	list(): NodeRecord[] {
		return [...this.nodes.values()].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
	}

	summaries(): NodeSummary[] {
		return this.list().map((record) => this.summarise(record));
	}

	forget(id: string) {
		const record = this.nodes.get(id);
		if (record?.link && !record.link.closed) {
			throw new UnauthorizedNode(
				"node_online",
				`node '${id}' is connected; disconnect it first`,
			);
		}
		this.nodes.delete(id);
		this.store.forget(id);
	}

	/** Marks nodes offline when their socket died without telling us. */
	startSweeper() {
		this.sweepTimer = setInterval(
			() => {
				const cutoff = Date.now() - this.config.nodeTimeoutMs;
				for (const record of this.nodes.values()) {
					if (!record.link || record.link.closed) continue;
					if ((record.lastSeen ?? 0) >= cutoff) continue;
					record.link.close("no telemetry within the timeout", 4002);
					this.detach(record.id, record.link, "telemetry stopped");
				}
			},
			Math.max(5000, this.config.nodeTimeoutMs / 2),
		);
		this.sweepTimer.unref?.();
	}

	stop() {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
		for (const record of this.nodes.values())
			record.link?.close("hub shutting down", 1001);
		this.listeners.clear();
	}

	summarise(record: NodeRecord): NodeSummary {
		const t = record.telemetry;
		const online = Boolean(record.link && !record.link.closed);
		const projects = t?.projects ?? [];

		return {
			id: record.id,
			name: record.name,
			status: online ? "online" : "offline",
			tags: record.tags,
			notes: record.notes,
			lastSeen: record.lastSeen,
			connectedAt: record.connectedAt,
			latencyMs: record.link?.latencyMs ?? null,
			remoteAddress: record.remoteAddress,
			version: record.version,
			protocol: record.protocol,
			capabilities: record.capabilities,
			// Identity first: it is the one thing that doesn't depend on a module
			// having loaded, which is the whole point of it being separate.
			hostname:
				record.host?.hostname ??
				t?.host?.hostname ??
				t?.stats?.hostname ??
				t?.facts?.hostname ??
				null,
			addresses: record.host?.addresses ?? t?.host?.addresses ?? [],
			platform: record.host?.platform ?? t?.host?.platform ?? null,
			facts: t?.facts ?? null,
			// Everything below is "as of the last telemetry"; on an offline node the
			// UI dims it rather than pretending it's current.
			uptimeSec: t?.stats?.uptimeSec ?? null,
			cpu: t?.stats?.cpu.usage ?? null,
			cores: t?.stats?.cpu.cores ?? null,
			loadavg: t?.stats?.loadavg ?? null,
			mem: t?.stats
				? { used: t.stats.mem.used, total: t.stats.mem.total }
				: null,
			disks: t?.stats?.disks ?? [],
			temps: t?.stats?.temps ?? [],
			net: t?.stats
				? {
						rxRate: t.stats.net.reduce((sum, n) => sum + (n.rxRate ?? 0), 0),
						txRate: t.stats.net.reduce((sum, n) => sum + (n.txRate ?? 0), 0),
					}
				: null,
			containers: t
				? {
						total: t.containers.length,
						running: t.containers.filter((c) => c.state === "running").length,
						unhealthy: t.containers.filter((c) => c.health === "unhealthy")
							.length,
					}
				: null,
			systemd: t?.systemd ?? null,
			// Only a node that actually reached Proxmox gets a summary; an empty one
			// would put a guests face on every card in the fleet.
			proxmox: t?.proxmox?.available ? t.proxmox : null,
			// Same rule as proxmox: only a node that actually reached one gets a
			// summary, so the face appears on the Pi-hole's card and nowhere else.
			pihole: t?.pihole?.available ? t.pihole : null,
			projects: t
				? {
						total: projects.length,
						running: projects.filter((p) => p.summary === "running").length,
						degraded: projects.filter((p) => p.summary === "degraded").length,
					}
				: null,
			// Scalars only: a summary goes to every browser on every tick, and the
			// rows behind an installed module's table ride in telemetry instead.
			extras: Object.fromEntries(
				Object.entries(t?.extras ?? {}).map(([id, report]) => [
					id,
					headline(report),
				]),
			),
			collectorErrors: t?.errors ?? {},
		};
	}
}

/**
 * Turns two consecutive telemetry frames into the handful of things worth
 * interrupting someone about. Edge-triggered on purpose: a unit that has been
 * failed for a week shouldn't alert every three seconds.
 */
export function diffAlerts(
	previous: Telemetry | null,
	current: Telemetry,
): { kind: string; message: string }[] {
	const alerts: { kind: string; message: string }[] = [];
	if (!previous) return alerts;

	const wasFailed = new Set(previous.systemd.failed);
	for (const unit of current.systemd.failed) {
		if (!wasFailed.has(unit))
			alerts.push({ kind: "unit-failed", message: `${unit} failed` });
	}

	const before = new Map(
		previous.projects.flatMap((p) =>
			p.processes.map((proc) => [`${p.id}/${proc.id}`, proc]),
		),
	);
	for (const project of current.projects) {
		for (const proc of project.processes) {
			const key = `${project.id}/${proc.id}`;
			const was = before.get(key);
			if (!was) continue;

			if (
				proc.state !== was.state &&
				(proc.state === "crashed" || proc.state === "fatal")
			) {
				const how = proc.lastExitSignal
					? `killed by ${proc.lastExitSignal}`
					: `exit ${proc.lastExitCode ?? "?"}`;
				alerts.push({
					kind: "process-down",
					message:
						proc.state === "fatal"
							? `${project.name}/${proc.name} gave up: ${proc.error ?? how}`
							: `${project.name}/${proc.name} crashed (${how})`,
				});
			}
			if (proc.health === "unhealthy" && was.health !== "unhealthy") {
				alerts.push({
					kind: "process-unhealthy",
					message: `${project.name}/${proc.name} is unhealthy: ${proc.healthDetail ?? "healthcheck failing"}`,
				});
			}
			if (
				proc.state === "running" &&
				(was.state === "crashed" || was.state === "restarting")
			) {
				alerts.push({
					kind: "process-recovered",
					message: `${project.name}/${proc.name} is running again`,
				});
			}
		}
	}

	return alerts;
}
