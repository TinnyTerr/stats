import { Database } from "bun:sqlite";
import type { NodeStatus, SystemStats } from "../types.ts";

/**
 * Rolling history, kept in SQLite so charts survive a hub restart and so a node
 * that has never connected since boot still appears (offline) in the grid.
 *
 * Only the scalars a chart needs are stored. The full telemetry frame stays in
 * memory: it is only ever read as "current", and writing it would turn a
 * dashboard into a time-series database.
 */

export interface MetricRow {
	ts: number;
	cpu: number;
	memUsed: number;
	memTotal: number;
	load1: number;
	rxRate: number;
	txRate: number;
	diskUsed: number;
	diskTotal: number;
}

export interface EventRow {
	ts: number;
	nodeId: string;
	kind: string;
	message: string;
}

export interface KnownNode {
	id: string;
	name: string;
	firstSeen: number;
	lastSeen: number;
	version: string | null;
	hostname: string | null;
}

export class MetricStore {
	private db: Database;
	private insertMetric;
	private insertEvent;
	private upsertNode;

	constructor(path: string) {
		this.db = new Database(path, { create: true });
		// WAL keeps telemetry writes from blocking dashboard reads.
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.migrate();

		this.insertMetric = this.db.prepare(
			`INSERT INTO metrics
         (node_id, ts, cpu, mem_used, mem_total, load1, rx_rate, tx_rate, disk_used, disk_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.insertEvent = this.db.prepare(
			`INSERT INTO events (node_id, ts, kind, message) VALUES (?, ?, ?, ?)`,
		);
		this.upsertNode = this.db.prepare(
			`INSERT INTO nodes (id, name, first_seen, last_seen, version, hostname)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         last_seen = excluded.last_seen,
         version = excluded.version,
         hostname = excluded.hostname`,
		);
	}

	/**
	 * The 0.1 schema keyed everything on `server_id` and had no nodes table.
	 * Rather than migrate rows nobody will miss — the data is a rolling window of
	 * at most a day — the old tables are dropped outright.
	 */
	private migrate() {
		const hasLegacy = this.db
			.query(
				`SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'metrics'
            AND sql LIKE '%server_id%'`,
			)
			.get();
		if (hasLegacy) {
			this.db.exec(
				"DROP TABLE IF EXISTS metrics; DROP TABLE IF EXISTS events;",
			);
		}

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id    TEXT    NOT NULL,
        ts         INTEGER NOT NULL,
        cpu        REAL    NOT NULL,
        mem_used   INTEGER NOT NULL,
        mem_total  INTEGER NOT NULL,
        load1      REAL    NOT NULL,
        rx_rate    REAL    NOT NULL,
        tx_rate    REAL    NOT NULL,
        disk_used  INTEGER NOT NULL,
        disk_total INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_node_ts ON metrics (node_id, ts);

      CREATE TABLE IF NOT EXISTS events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT    NOT NULL,
        ts      INTEGER NOT NULL,
        kind    TEXT    NOT NULL,
        message TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);

      CREATE TABLE IF NOT EXISTS nodes (
        id         TEXT PRIMARY KEY,
        name       TEXT    NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL,
        version    TEXT,
        hostname   TEXT
      );

      -- What the operator asked for from the hub's module page, per node and
      -- module. Deliberately its own table rather than columns on nodes: this
      -- is intent, and it has to outlive a node being forgotten and re-added,
      -- survive the node being offline when it was set, and be readable for a
      -- node that has never connected at all.
      CREATE TABLE IF NOT EXISTS node_modules (
        node_id   TEXT    NOT NULL,
        module_id TEXT    NOT NULL,
        enabled   INTEGER NOT NULL,
        set_at    INTEGER NOT NULL,
        PRIMARY KEY (node_id, module_id)
      );
    `);
	}

	record(nodeId: string, stats: SystemStats) {
		const rx = stats.net.reduce((sum, n) => sum + (n.rxRate ?? 0), 0);
		const tx = stats.net.reduce((sum, n) => sum + (n.txRate ?? 0), 0);
		// Root-ish view of storage: sum the real mounts rather than pick one.
		const diskUsed = stats.disks.reduce((sum, d) => sum + d.used, 0);
		const diskTotal = stats.disks.reduce((sum, d) => sum + d.total, 0);

		this.insertMetric.run(
			nodeId,
			stats.timestamp,
			stats.cpu.usage,
			stats.mem.used,
			stats.mem.total,
			stats.loadavg[0],
			rx,
			tx,
			diskUsed,
			diskTotal,
		);
	}

	recordEvent(nodeId: string, kind: string, message: string) {
		this.insertEvent.run(nodeId, Date.now(), kind, message);
	}

	/** Remembers a node so it shows as offline rather than vanishing. */
	seen(node: {
		id: string;
		name: string;
		version?: string | null;
		hostname?: string | null;
	}) {
		const now = Date.now();
		this.upsertNode.run(
			node.id,
			node.name,
			now,
			now,
			node.version ?? null,
			node.hostname ?? null,
		);
	}

	knownNodes(): KnownNode[] {
		return this.db
			.query(
				`SELECT id, name, first_seen AS firstSeen, last_seen AS lastSeen, version, hostname
           FROM nodes ORDER BY name`,
			)
			.all() as KnownNode[];
	}

	/** The hub's per-node module intent, empty when nothing was ever set. */
	desiredModules(nodeId: string): Record<string, boolean> {
		const rows = this.db
			.query(
				"SELECT module_id AS id, enabled FROM node_modules WHERE node_id = ?",
			)
			.all(nodeId) as { id: string; enabled: number }[];
		const desired: Record<string, boolean> = {};
		for (const row of rows) desired[row.id] = row.enabled === 1;
		return desired;
	}

	/** Every node the hub has an opinion about, for the fleet module page. */
	allDesiredModules(): Record<string, Record<string, boolean>> {
		const rows = this.db
			.query(
				"SELECT node_id AS node, module_id AS id, enabled FROM node_modules",
			)
			.all() as { node: string; id: string; enabled: number }[];
		const all: Record<string, Record<string, boolean>> = {};
		for (const row of rows) {
			const forNode = all[row.node] ?? {};
			forNode[row.id] = row.enabled === 1;
			all[row.node] = forNode;
		}
		return all;
	}

	/**
	 * Records intent for the modules named and leaves the rest alone. Partial on
	 * purpose: two operators on two browsers toggling different modules should
	 * not overwrite each other, and "not mentioned" has to keep meaning "no
	 * opinion" rather than collapsing to false.
	 */
	setDesiredModules(nodeId: string, modules: Record<string, boolean>) {
		const stmt = this.db.prepare(
			`INSERT INTO node_modules (node_id, module_id, enabled, set_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(node_id, module_id) DO UPDATE SET
         enabled = excluded.enabled,
         set_at  = excluded.set_at`,
		);
		const now = Date.now();
		for (const [id, enabled] of Object.entries(modules)) {
			stmt.run(nodeId, id, enabled ? 1 : 0, now);
		}
	}

	/** Drops the hub's opinion about one module, back to "no opinion". */
	clearDesiredModule(nodeId: string, moduleId: string) {
		this.db.run(
			"DELETE FROM node_modules WHERE node_id = ? AND module_id = ?",
			[nodeId, moduleId],
		);
	}

	forget(nodeId: string) {
		this.db.run("DELETE FROM node_modules WHERE node_id = ?", [nodeId]);
		this.db.run("DELETE FROM nodes WHERE id = ?", [nodeId]);
		this.db.run("DELETE FROM metrics WHERE node_id = ?", [nodeId]);
		this.db.run("DELETE FROM events WHERE node_id = ?", [nodeId]);
	}

	/**
	 * The rolling series for one node, oldest first.
	 *
	 * `buckets` is the only way to ask for a long window honestly. At a three
	 * second tick a day is nearly thirty thousand rows, so a bare `LIMIT` can
	 * only ever return a slice of it — and a slice of the *start* of the window,
	 * which draws a chart labelled "24 hours" out of its first ninety minutes.
	 * Asking for N buckets averages each sample into a fixed-width slot instead,
	 * so the shape spans the whole window at whatever resolution the caller can
	 * actually draw. Without it the rows are exact and the cap takes the most
	 * recent ones, because a truncated series should lose its tail, not its head.
	 */
	history(
		nodeId: string,
		sinceMs: number,
		options: {
			/** cap on exact rows returned; ignored when bucketing */
			limit?: number;
			/** average the window into this many even slots */
			buckets?: number;
			/**
			 * The far edge of the window. Defaults to now, and exists so the slot
			 * width is a property of the window the caller asked for rather than of
			 * the moment the query happened to run.
			 */
			untilMs?: number;
		} = {},
	): MetricRow[] {
		const { limit = 2000, buckets, untilMs = Date.now() } = options;

		if (buckets && buckets > 0) {
			// Slots are measured from the start of the window, not from the epoch:
			// aligning them to absolute time would hand back an arbitrary number of
			// buckets depending on where `sinceMs` happened to fall. The last index
			// is clamped so a sample landing exactly on the far edge joins the final
			// slot instead of opening one of its own.
			//
			// The totals are constants that ride along, so averaging them is a no-op
			// except across a disk being resized mid-window.
			const width = Math.max(1, Math.ceil((untilMs - sinceMs) / buckets));
			return this.db
				.query(
					`SELECT ? + MIN((ts - ?) / ?, ?) * ? AS ts,
                  AVG(cpu) AS cpu, AVG(mem_used) AS memUsed,
                  AVG(mem_total) AS memTotal, AVG(load1) AS load1,
                  AVG(rx_rate) AS rxRate, AVG(tx_rate) AS txRate,
                  AVG(disk_used) AS diskUsed, AVG(disk_total) AS diskTotal
             FROM metrics
            WHERE node_id = ? AND ts >= ?
            GROUP BY MIN((ts - ?) / ?, ?)
            ORDER BY ts ASC`,
				)
				.all(
					sinceMs,
					sinceMs,
					width,
					buckets - 1,
					width,
					nodeId,
					sinceMs,
					sinceMs,
					width,
					buckets - 1,
				) as MetricRow[];
		}

		return (
			this.db
				.query(
					`SELECT ts, cpu, mem_used AS memUsed, mem_total AS memTotal, load1,
                  rx_rate AS rxRate, tx_rate AS txRate,
                  disk_used AS diskUsed, disk_total AS diskTotal
             FROM metrics
            WHERE node_id = ? AND ts >= ?
            ORDER BY ts DESC
            LIMIT ?`,
				)
				.all(nodeId, sinceMs, limit) as MetricRow[]
		).reverse();
	}

	events(sinceMs: number, limit = 200, nodeId?: string): EventRow[] {
		const where = nodeId ? "WHERE ts >= ? AND node_id = ?" : "WHERE ts >= ?";
		const args: (string | number)[] = nodeId
			? [sinceMs, nodeId, limit]
			: [sinceMs, limit];
		return this.db
			.query(
				`SELECT ts, node_id AS nodeId, kind, message
           FROM events ${where}
          ORDER BY ts DESC
          LIMIT ?`,
			)
			.all(...args) as EventRow[];
	}

	/** Drops samples older than the retention window. Cheap enough to run often. */
	prune(retentionHours: number) {
		const cutoff = Date.now() - retentionHours * 3600_000;
		this.db.run("DELETE FROM metrics WHERE ts < ?", [cutoff]);
		this.db.run("DELETE FROM events WHERE ts < ?", [cutoff]);
	}

	close() {
		this.db.close();
	}
}

/** Shared shape for the online/offline events the registry writes. */
export function statusMessage(
	name: string,
	status: NodeStatus,
	detail?: string,
): string {
	return status === "online"
		? `${name} connected${detail ? ` (${detail})` : ""}`
		: `${name} disconnected${detail ? `: ${detail}` : ""}`;
}
