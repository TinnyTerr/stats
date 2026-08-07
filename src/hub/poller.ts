import type { HubConfig, ServerConfig, ServerState } from "../types.ts";
import type { MetricStore } from "./db.ts";
import { createSource, type Source } from "./source.ts";
import { publicServer } from "./config.ts";
import { PROTOCOL } from "../version.ts";

/**
 * Polls every configured server on an interval, keeps the latest snapshot in
 * memory, writes the numeric series to SQLite, and notifies subscribers so the
 * hub can push over WebSocket.
 */

type Listener = (state: ServerState) => void;

const TIMEOUT_FACTOR = 3;

export class Poller {
  private states = new Map<string, ServerState>();
  private sources = new Map<string, Source>();
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping polls when a server is slower than the interval. */
  private inFlight = new Set<string>();
  /** Servers already warned about a protocol mismatch — warn once, not every poll. */
  private warnedProtocol = new Set<string>();

  constructor(
    private config: HubConfig,
    private store: MetricStore,
  ) {
    for (const server of config.servers) this.addServer(server);
  }

  private addServer(server: ServerConfig) {
    this.sources.set(server.id, createSource(server));
    this.states.set(server.id, {
      config: publicServer(server),
      status: "unknown",
      lastSeen: null,
      latencyMs: null,
      error: null,
      snapshot: null,
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(state: ServerState) {
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // a broken subscriber must not stall the poll loop
      }
    }
  }

  getState(id: string): ServerState | undefined {
    return this.states.get(id);
  }

  getStates(): ServerState[] {
    return [...this.states.values()];
  }

  getSource(id: string): Source | undefined {
    return this.sources.get(id);
  }

  /**
   * A snapshot from a different protocol still renders — fields are additive —
   * so this warns rather than marking the server offline. An agent with no
   * protocol at all predates versioning.
   */
  private checkProtocol(server: ServerConfig, protocol: number | undefined) {
    if (protocol === PROTOCOL || this.warnedProtocol.has(server.id)) return;
    this.warnedProtocol.add(server.id);
    console.warn(
      `warning: ${server.id} speaks protocol ${protocol ?? "unknown"}, hub speaks ${PROTOCOL} — ` +
        "update the agent on that server",
    );
  }

  private async pollOne(server: ServerConfig) {
    if (this.inFlight.has(server.id)) return;
    this.inFlight.add(server.id);

    const state = this.states.get(server.id)!;
    const source = this.sources.get(server.id)!;
    const started = Date.now();

    // Don't let one unreachable box hold the interval open indefinitely.
    const signal = AbortSignal.timeout(this.config.pollIntervalMs * TIMEOUT_FACTOR);

    try {
      const snapshot = await source.snapshot(signal);
      const wasOffline = state.status !== "online";

      state.snapshot = snapshot;
      state.status = "online";
      state.lastSeen = Date.now();
      state.latencyMs = Date.now() - started;
      state.error = null;

      this.checkProtocol(server, snapshot.agent?.protocol);
      this.store.record(server.id, snapshot.stats);
      if (wasOffline) this.store.recordEvent(server.id, "online", `${server.name} is reachable`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (state.status !== "offline") {
        this.store.recordEvent(server.id, "offline", `${server.name} unreachable: ${message}`);
      }
      state.status = "offline";
      state.latencyMs = Date.now() - started;
      state.error = message;
    } finally {
      this.inFlight.delete(server.id);
      this.emit(state);
    }
  }

  async pollAll() {
    await Promise.all(this.config.servers.map((server) => this.pollOne(server)));
  }

  start() {
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), this.config.pollIntervalMs);
    this.pruneTimer = setInterval(
      () => this.store.prune(this.config.retentionHours),
      600_000,
    );
    this.store.prune(this.config.retentionHours);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = null;
    this.pruneTimer = null;
  }
}
