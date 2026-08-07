import { Database } from "bun:sqlite";
import type { SystemStats } from "../types.ts";

/**
 * Rolling metric history, kept in SQLite so sparklines survive a hub restart.
 * Only the handful of scalars a chart needs are stored; the full snapshot
 * stays in memory since it's only ever read as "current".
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
  serverId: string;
  kind: string;
  message: string;
}

export class MetricStore {
  private db: Database;
  private insertMetric;
  private insertEvent;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    // WAL keeps the poller's writes from blocking dashboard reads.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();

    this.insertMetric = this.db.prepare(
      `INSERT INTO metrics
         (server_id, ts, cpu, mem_used, mem_total, load1, rx_rate, tx_rate, disk_used, disk_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertEvent = this.db.prepare(
      `INSERT INTO events (server_id, ts, kind, message) VALUES (?, ?, ?, ?)`,
    );
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id  TEXT    NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_metrics_server_ts ON metrics (server_id, ts);

      CREATE TABLE IF NOT EXISTS events (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT    NOT NULL,
        ts        INTEGER NOT NULL,
        kind      TEXT    NOT NULL,
        message   TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
    `);
  }

  record(serverId: string, stats: SystemStats) {
    const rx = stats.net.reduce((sum, n) => sum + (n.rxRate ?? 0), 0);
    const tx = stats.net.reduce((sum, n) => sum + (n.txRate ?? 0), 0);
    // Root-ish view of storage: sum the real mounts rather than pick one.
    const diskUsed = stats.disks.reduce((sum, d) => sum + d.used, 0);
    const diskTotal = stats.disks.reduce((sum, d) => sum + d.total, 0);

    this.insertMetric.run(
      serverId,
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

  recordEvent(serverId: string, kind: string, message: string) {
    this.insertEvent.run(serverId, Date.now(), kind, message);
  }

  history(serverId: string, sinceMs: number, limit = 2000): MetricRow[] {
    return this.db
      .query(
        `SELECT ts, cpu, mem_used AS memUsed, mem_total AS memTotal, load1,
                rx_rate AS rxRate, tx_rate AS txRate,
                disk_used AS diskUsed, disk_total AS diskTotal
           FROM metrics
          WHERE server_id = ? AND ts >= ?
          ORDER BY ts ASC
          LIMIT ?`,
      )
      .all(serverId, sinceMs, limit) as MetricRow[];
  }

  events(sinceMs: number, limit = 200): EventRow[] {
    return this.db
      .query(
        `SELECT ts, server_id AS serverId, kind, message
           FROM events
          WHERE ts >= ?
          ORDER BY ts DESC
          LIMIT ?`,
      )
      .all(sinceMs, limit) as EventRow[];
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
