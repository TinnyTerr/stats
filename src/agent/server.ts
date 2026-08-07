import type { LogQuery, LogSourceKind, Snapshot } from "../types.ts";
import { collectContainers, DockerUnavailable, dockerAvailable } from "../collect/docker.ts";
import { streamLogs } from "../collect/logs.ts";
import {
  collectListeningPorts,
  collectProcesses,
  collectServices,
} from "../collect/processes.ts";
import { collectSystem } from "../collect/system.ts";
import { json, requireToken, sseResponse, unauthorized } from "../http.ts";
import { versionInfo } from "../version.ts";

/**
 * The agent: one of these runs on every server. It is deliberately read-only —
 * it exposes no way to start, stop or exec anything, so a leaked token can
 * only disclose metrics.
 */

export interface AgentOptions {
  port: number;
  host: string;
  token: string | null;
}

/**
 * Collects everything, tolerating individual collector failures — a host
 * without docker or systemd should still report CPU and memory.
 */
export async function collectSnapshot(opts: { stats?: boolean } = {}): Promise<Snapshot> {
  const errors: Record<string, string> = {};

  const guard = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      errors[name] = err instanceof Error ? err.message : String(err);
      return fallback;
    }
  };

  const [stats, containers, processes, services, ports] = await Promise.all([
    collectSystem(),
    guard("docker", () => collectContainers({ stats: opts.stats }), []),
    guard("processes", () => collectProcesses(), []),
    guard("services", () => collectServices(), []),
    guard("ports", () => collectListeningPorts(), []),
  ]);

  return { agent: versionInfo, stats, containers, processes, services, ports, errors };
}

function parseLogQuery(url: URL): LogQuery | { error: string } {
  const kind = url.searchParams.get("kind") ?? "docker";
  const target = url.searchParams.get("target");
  if (!["docker", "journal", "file"].includes(kind)) {
    return { error: `unknown log kind '${kind}' (expected docker, journal or file)` };
  }
  if (!target) return { error: "missing 'target' query parameter" };
  const tail = Number(url.searchParams.get("tail") ?? 200);
  return {
    kind: kind as LogSourceKind,
    target,
    tail: Number.isFinite(tail) ? Math.min(Math.max(tail, 1), 5000) : 200,
  };
}

export function startAgent(opts: AgentOptions) {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    // Log follow streams are long-lived; don't let Bun time them out.
    idleTimeout: 0,

    routes: {
      "/api/health": () =>
        json({ ok: true, role: "agent", ...versionInfo, time: Date.now() }),

      "/api/stats": async (req) => {
        if (!requireToken(req, opts.token)) return unauthorized();
        return json(await collectSystem());
      },

      "/api/snapshot": async (req) => {
        if (!requireToken(req, opts.token)) return unauthorized();
        const withStats = new URL(req.url).searchParams.get("containerStats") !== "0";
        return json(await collectSnapshot({ stats: withStats }));
      },

      "/api/docker/containers": async (req) => {
        if (!requireToken(req, opts.token)) return unauthorized();
        try {
          return json(await collectContainers());
        } catch (err) {
          if (err instanceof DockerUnavailable) {
            return json({ error: err.message, available: false }, 503);
          }
          throw err;
        }
      },

      "/api/docker/available": async (req) => {
        if (!requireToken(req, opts.token)) return unauthorized();
        return json({ available: await dockerAvailable() });
      },

      "/api/processes": async (req) => {
        if (!requireToken(req, opts.token)) return unauthorized();
        const limit = Number(new URL(req.url).searchParams.get("limit") ?? 20);
        return json(await collectProcesses(Number.isFinite(limit) ? limit : 20));
      },

      "/api/services": async (req) => {
        if (!requireToken(req, opts.token)) return unauthorized();
        return json(await collectServices());
      },

      "/api/ports": async (req) => {
        if (!requireToken(req, opts.token)) return unauthorized();
        return json(await collectListeningPorts());
      },

      /** One-shot: returns the last N lines and closes. */
      "/api/logs": async (req) => {
        if (!requireToken(req, opts.token)) return unauthorized();
        const query = parseLogQuery(new URL(req.url));
        if ("error" in query) return json({ error: query.error }, 400);
        try {
          const collected = [];
          for await (const line of streamLogs(query, false, req.signal)) collected.push(line);
          return json(collected);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 502);
        }
      },

      /** Server-sent events: last N lines, then follows. */
      "/api/logs/stream": async (req) => {
        if (!requireToken(req, opts.token)) return unauthorized();
        const query = parseLogQuery(new URL(req.url));
        if ("error" in query) return json({ error: query.error }, 400);
        return sseResponse(async function* (signal) {
          try {
            for await (const line of streamLogs(query, true, signal)) {
              yield { event: "log", data: line };
            }
          } catch (err) {
            yield { event: "error", data: { message: err instanceof Error ? err.message : String(err) } };
          }
        }, req.signal);
      },
    },

    fetch: () => json({ error: "not found" }, 404),

    error: (err) => json({ error: err.message }, 500),
  });

  return server;
}
