import type {
  Container,
  ListeningPort,
  LogLine,
  ProcessInfo,
  ServiceInfo,
} from "../src/types.ts";

/** Typed client for the hub API. Mirrors the routes in src/hub/server.ts. */

/** The list-view shape the hub's `summarise()` produces. */
export interface ServerSummary {
  id: string;
  name: string;
  driver: string;
  tags: string[];
  notes: string | null;
  status: "online" | "offline" | "unknown";
  lastSeen: number | null;
  latencyMs: number | null;
  error: string | null;
  hostname: string | null;
  uptimeSec: number | null;
  cpu: number | null;
  cores: number | null;
  loadavg: [number, number, number] | null;
  mem: { used: number; total: number } | null;
  disks: { mount: string; used: number; total: number; usage: number }[];
  temps: { name: string; celsius: number }[];
  net: { rxRate: number; txRate: number } | null;
  containers: { total: number; running: number; unhealthy: number } | null;
  services: number | null;
  collectorErrors: Record<string, string>;
  /** null when the agent predates versioning */
  agentVersion: string | null;
  agentProtocol: number | null;
}

/** `GET /api/health` — unauthenticated, so it also works before a token is set. */
export interface Health {
  ok: boolean;
  role: string;
  version: string;
  protocol: number;
  servers: number;
  time: number;
}

export interface MetricPoint {
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

/**
 * Set when the hub has a token configured. Kept in localStorage so the token
 * never has to be part of a bookmarked URL.
 */
function token(): string | null {
  return localStorage.getItem("stats.token");
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: token() ? { authorization: `Bearer ${token()}` } : {},
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => get<Health>("/api/health"),
  servers: () => get<ServerSummary[]>("/api/servers"),
  containers: (id: string) => get<Container[]>(`/api/servers/${id}/containers`),
  processes: (id: string) => get<ProcessInfo[]>(`/api/servers/${id}/processes`),
  services: (id: string) => get<ServiceInfo[]>(`/api/servers/${id}/services`),
  ports: (id: string) => get<ListeningPort[]>(`/api/servers/${id}/ports`),
  history: (id: string, minutes = 60) =>
    get<MetricPoint[]>(`/api/servers/${id}/history?minutes=${minutes}`),
  refresh: () =>
    fetch("/api/refresh", {
      method: "POST",
      headers: token() ? { authorization: `Bearer ${token()}` } : {},
    }).then((r) => r.json() as Promise<ServerSummary[]>),
};

/**
 * Live server states. Reconnects with a fixed backoff — the hub is on the same
 * machine or LAN, so there's no need for anything cleverer.
 */
export function connectServerFeed(
  onServers: (servers: ServerSummary[]) => void,
  onServer: (server: ServerSummary) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = token() ? `?token=${encodeURIComponent(token()!)}` : "";
    ws = new WebSocket(`${proto}//${location.host}/ws${qs}`);

    ws.onopen = () => onStatus(true);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "snapshot") onServers(msg.data);
      else if (msg.type === "server") onServer(msg.data);
    };
    ws.onclose = () => {
      onStatus(false);
      if (!closed) retry = setTimeout(connect, 2000);
    };
    ws.onerror = () => ws?.close();
  };

  connect();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

/** Live log tail over SSE. Returns an unsubscribe function. */
export function connectLogs(
  serverId: string,
  query: { kind: string; target: string; tail?: number },
  onLine: (line: LogLine) => void,
  onError: (message: string) => void,
): () => void {
  const params = new URLSearchParams({
    kind: query.kind,
    target: query.target,
    tail: String(query.tail ?? 200),
  });
  // EventSource can't set headers, so the token rides along as a query param.
  if (token()) params.set("token", token()!);

  const es = new EventSource(`/api/servers/${serverId}/logs/stream?${params}`);
  es.addEventListener("log", (e) => onLine(JSON.parse(e.data)));
  // Fires both for a server-sent `event: error` (which carries data) and for a
  // transport drop (which doesn't).
  es.addEventListener("error", (e) => {
    const data = (e as unknown as MessageEvent).data as string | undefined;
    onError(data ? (JSON.parse(data).message ?? "log stream error") : "log stream disconnected");
  });
  return () => es.close();
}
