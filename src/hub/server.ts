import type { ServerWebSocket } from "bun";
import index from "../../web/index.html";
import type { HubConfig, LogQuery, LogSourceKind, ServerState } from "../types.ts";
import { json, requireToken, sseResponse, unauthorized } from "../http.ts";
import { versionInfo } from "../version.ts";
import { MetricStore } from "./db.ts";
import { Poller } from "./poller.ts";

/**
 * The hub: runs on the laptop, fans out to every configured server, serves the
 * dashboard and its API.
 */

interface WsData {
  subscribed: Set<string> | null; // null = all servers
}

/** Snapshots are large; the list view only needs the headline numbers. */
function summarise(state: ServerState) {
  const s = state.snapshot;
  return {
    id: state.config.id,
    name: state.config.name,
    driver: state.config.driver,
    tags: state.config.tags ?? [],
    notes: state.config.notes ?? null,
    status: state.status,
    lastSeen: state.lastSeen,
    latencyMs: state.latencyMs,
    error: state.error,
    hostname: s?.stats.hostname ?? null,
    uptimeSec: s?.stats.uptimeSec ?? null,
    cpu: s?.stats.cpu.usage ?? null,
    cores: s?.stats.cpu.cores ?? null,
    loadavg: s?.stats.loadavg ?? null,
    mem: s ? { used: s.stats.mem.used, total: s.stats.mem.total } : null,
    disks: s?.stats.disks ?? [],
    temps: s?.stats.temps ?? [],
    net: s
      ? {
          rxRate: s.stats.net.reduce((sum, n) => sum + (n.rxRate ?? 0), 0),
          txRate: s.stats.net.reduce((sum, n) => sum + (n.txRate ?? 0), 0),
        }
      : null,
    containers: s
      ? {
          total: s.containers.length,
          running: s.containers.filter((c) => c.state === "running").length,
          unhealthy: s.containers.filter((c) => c.health === "unhealthy").length,
        }
      : null,
    services: s?.services.length ?? null,
    collectorErrors: s?.errors ?? {},
    // null for agents predating versioning; the UI renders that as "unknown".
    agentVersion: s?.agent?.version ?? null,
    agentProtocol: s?.agent?.protocol ?? null,
  };
}

function parseLogQuery(url: URL): LogQuery | { error: string } {
  const kind = url.searchParams.get("kind") ?? "docker";
  const target = url.searchParams.get("target");
  if (!["docker", "journal", "file"].includes(kind)) {
    return { error: `unknown log kind '${kind}'` };
  }
  if (!target) return { error: "missing 'target' query parameter" };
  const tail = Number(url.searchParams.get("tail") ?? 200);
  return {
    kind: kind as LogSourceKind,
    target,
    tail: Number.isFinite(tail) ? Math.min(Math.max(tail, 1), 5000) : 200,
  };
}

export function startHub(config: HubConfig) {
  const store = new MetricStore(config.dbPath);
  const poller = new Poller(config, store);
  const sockets = new Set<ServerWebSocket<WsData>>();

  poller.subscribe((state) => {
    const message = JSON.stringify({ type: "server", data: summarise(state) });
    for (const ws of sockets) {
      const filter = ws.data.subscribed;
      if (filter && !filter.has(state.config.id)) continue;
      ws.send(message);
    }
  });

  poller.start();

  /** Wraps a route so it 401s unless the hub token matches (when configured). */
  const auth =
    (handler: (req: Request) => Response | Promise<Response>) =>
    (req: Request) =>
      requireToken(req, config.token) ? handler(req) : unauthorized();

  /** Resolves :id into a poller state, or a 404. */
  const withServer = (
    req: Request & { params: { id: string } },
    handler: (state: ServerState) => Response | Promise<Response>,
  ) => {
    const state = poller.getState(req.params.id);
    if (!state) return json({ error: `unknown server '${req.params.id}'` }, 404);
    return handler(state);
  };

  const server = Bun.serve<WsData>({
    port: config.port,
    hostname: config.host,
    idleTimeout: 0,

    routes: {
      "/": index,

      "/api/health": () =>
        json({
          ok: true,
          role: "hub",
          ...versionInfo,
          servers: config.servers.length,
          time: Date.now(),
        }),

      /** Everything the dashboard's list view needs, in one call. */
      "/api/servers": auth(() => json(poller.getStates().map(summarise))),

      "/api/servers/:id": auth((req) =>
        withServer(req as never, (state) =>
          json({ ...summarise(state), snapshot: state.snapshot }),
        ),
      ),

      "/api/servers/:id/stats": auth((req) =>
        withServer(req as never, (state) => json(state.snapshot?.stats ?? null)),
      ),

      "/api/servers/:id/containers": auth((req) =>
        withServer(req as never, (state) => json(state.snapshot?.containers ?? [])),
      ),

      "/api/servers/:id/processes": auth((req) =>
        withServer(req as never, (state) => json(state.snapshot?.processes ?? [])),
      ),

      "/api/servers/:id/services": auth((req) =>
        withServer(req as never, (state) => json(state.snapshot?.services ?? [])),
      ),

      "/api/servers/:id/ports": auth((req) =>
        withServer(req as never, (state) => json(state.snapshot?.ports ?? [])),
      ),

      /** Time series for charts. `minutes` defaults to one hour. */
      "/api/servers/:id/history": auth((req) =>
        withServer(req as never, (state) => {
          const url = new URL(req.url);
          const minutes = Number(url.searchParams.get("minutes") ?? 60);
          const window = Number.isFinite(minutes) ? Math.min(minutes, 24 * 60) : 60;
          return json(store.history(state.config.id, Date.now() - window * 60_000));
        }),
      ),

      /** Live log tail, proxied from whichever source backs this server. */
      "/api/servers/:id/logs/stream": auth((req) => {
        const params = (req as Request & { params: { id: string } }).params;
        const source = poller.getSource(params.id);
        if (!source) return json({ error: `unknown server '${params.id}'` }, 404);

        const query = parseLogQuery(new URL(req.url));
        if ("error" in query) return json({ error: query.error }, 400);

        return sseResponse(async function* (signal) {
          try {
            for await (const line of source.logs(query, signal)) {
              yield { event: "log", data: line };
            }
          } catch (err) {
            yield {
              event: "error",
              data: { message: err instanceof Error ? err.message : String(err) },
            };
          }
        }, req.signal);
      }),

      /** Online/offline transitions across all servers. */
      "/api/events": auth((req) => {
        const minutes = Number(new URL(req.url).searchParams.get("minutes") ?? 60 * 24);
        const window = Number.isFinite(minutes) ? minutes : 60 * 24;
        return json(store.events(Date.now() - window * 60_000));
      }),

      /** Forces an immediate poll instead of waiting for the interval. */
      "/api/refresh": {
        POST: auth(async () => {
          await poller.pollAll();
          return json(poller.getStates().map(summarise));
        }),
      },
    },

    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (!requireToken(req, config.token)) return unauthorized();
        const only = url.searchParams.get("servers");
        const upgraded = srv.upgrade(req, {
          data: { subscribed: only ? new Set(only.split(",")) : null } satisfies WsData,
        });
        return upgraded ? undefined : json({ error: "websocket upgrade failed" }, 400);
      }
      return json({ error: "not found" }, 404);
    },

    websocket: {
      open(ws) {
        sockets.add(ws);
        // Send current state immediately so the UI paints without waiting a tick.
        ws.send(
          JSON.stringify({ type: "snapshot", data: poller.getStates().map(summarise) }),
        );
      },
      message(ws, raw) {
        try {
          const msg = JSON.parse(String(raw)) as { type?: string; servers?: string[] };
          if (msg.type === "subscribe") {
            ws.data.subscribed = msg.servers?.length ? new Set(msg.servers) : null;
          }
        } catch {
          // ignore malformed client frames
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },

    error: (err) => json({ error: err.message }, 500),

    development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
  });

  const shutdown = () => {
    poller.stop();
    store.close();
    void server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, poller, store };
}
