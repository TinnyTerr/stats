import { narrowModules } from "../modules/manifest.ts";
import type { PeerLink } from "../proto/link.ts";
import type { HelloPayload } from "../proto/messages.ts";
import type {
	HubConfig,
	NodeCapabilities,
	NodeOverride,
	NodeSummary,
	Telemetry,
} from "../types.ts";
import { type MetricStore, statusMessage } from "./db.ts";

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
			hostname: hello.facts?.hostname ?? null,
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
		return {
			control: capabilities?.control ?? false,
			modules: narrowModules(capabilities?.modules ?? {}, this.config.modules),
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
		this.store.record(id, telemetry.stats);
		this.store.seen({
			id,
			name: record.name,
			version: record.version,
			hostname: telemetry.stats.hostname,
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
			hostname: t?.stats.hostname ?? t?.facts.hostname ?? null,
			facts: t?.facts ?? null,
			// Everything below is "as of the last telemetry"; on an offline node the
			// UI dims it rather than pretending it's current.
			uptimeSec: t?.stats.uptimeSec ?? null,
			cpu: t?.stats.cpu.usage ?? null,
			cores: t?.stats.cpu.cores ?? null,
			loadavg: t?.stats.loadavg ?? null,
			mem: t ? { used: t.stats.mem.used, total: t.stats.mem.total } : null,
			disks: t?.stats.disks ?? [],
			temps: t?.stats.temps ?? [],
			net: t
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
			projects: t
				? {
						total: projects.length,
						running: projects.filter((p) => p.summary === "running").length,
						degraded: projects.filter((p) => p.summary === "degraded").length,
					}
				: null,
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
