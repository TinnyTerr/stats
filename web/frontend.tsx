import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Container, ListeningPort, LogLine, ProcessInfo } from "../src/types.ts";
import { api, connectLogs, connectServerFeed, type ServerSummary } from "./api.ts";
import "./index.css";

/* ---------- formatting ---------- */

const bytes = (n: number | null | undefined) => {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

const rate = (n: number | null | undefined) => (n == null ? "—" : `${bytes(n)}/s`);
const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}%`);

const duration = (sec: number | null | undefined) => {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
};

const clock = (ts: number) => new Date(ts).toLocaleTimeString();

/* ---------- primitives ---------- */

function Meter({ value, label }: { value: number | null; label: string }) {
  const level = value == null ? "idle" : value > 0.9 ? "crit" : value > 0.7 ? "warn" : "ok";
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-value">{pct(value)}</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${level}`} style={{ width: `${(value ?? 0) * 100}%` }} />
      </div>
    </div>
  );
}

/** Dependency-free sparkline; the history endpoint returns plain numbers. */
function Sparkline({ points, height = 32 }: { points: number[]; height?: number }) {
  if (points.length < 2) return <div className="spark empty" style={{ height }} />;
  const max = Math.max(...points, 0.01);
  const step = 100 / (points.length - 1);
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${(100 - (p / max) * 100).toFixed(2)}`)
    .join(" ");
  return (
    <svg className="spark" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }}>
      <path d={path} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ---------- server card ---------- */

function ServerCard({
  server,
  selected,
  onSelect,
  hubVersion,
}: {
  server: ServerSummary;
  selected: boolean;
  onSelect: () => void;
  /** null until /api/health answers; a mismatch against it is worth flagging */
  hubVersion: string | null;
}) {
  const [history, setHistory] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .history(server.id, 30)
        .then((rows) => !cancelled && setHistory(rows.map((r) => r.cpu)))
        .catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [server.id]);

  const primaryDisk = server.disks[0] ?? null;
  const collectorIssues = Object.entries(server.collectorErrors);

  return (
    <button
      type="button"
      className={`card ${selected ? "selected" : ""} ${server.status}`}
      onClick={onSelect}
    >
      <header>
        <span className={`dot ${server.status}`} />
        <h2>{server.name}</h2>
        <span className="host">{server.hostname ?? server.id}</span>
      </header>

      {server.status === "offline" ? (
        <p className="error">{server.error ?? "unreachable"}</p>
      ) : (
        <>
          <div className="metrics">
            <Meter value={server.cpu} label="CPU" />
            <Meter
              value={server.mem ? server.mem.used / server.mem.total : null}
              label="Memory"
            />
            <Meter value={primaryDisk?.usage ?? null} label={primaryDisk?.mount ?? "Disk"} />
          </div>

          <Sparkline points={history} />

          <dl className="facts">
            <div>
              <dt>Uptime</dt>
              <dd>{duration(server.uptimeSec)}</dd>
            </div>
            <div>
              <dt>Load</dt>
              <dd>{server.loadavg ? server.loadavg[0].toFixed(2) : "—"}</dd>
            </div>
            <div>
              <dt>Net</dt>
              <dd>
                ↓{rate(server.net?.rxRate)} ↑{rate(server.net?.txRate)}
              </dd>
            </div>
            <div>
              <dt>Containers</dt>
              <dd>
                {server.containers
                  ? `${server.containers.running}/${server.containers.total}`
                  : "—"}
                {server.containers?.unhealthy ? (
                  <span className="badge crit">{server.containers.unhealthy} unhealthy</span>
                ) : null}
              </dd>
            </div>
          </dl>
        </>
      )}

      <footer>
        {server.tags.map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
        {collectorIssues.map(([name]) => (
          <span key={name} className="tag warn" title={server.collectorErrors[name]}>
            {name} unavailable
          </span>
        ))}
        {server.status === "online" && hubVersion && server.agentVersion !== hubVersion && (
          <span className="tag warn" title={`hub is ${hubVersion}`}>
            agent {server.agentVersion ?? "pre-0.1.0"}
          </span>
        )}
        {server.latencyMs != null && <span className="latency">{server.latencyMs}ms</span>}
      </footer>
    </button>
  );
}

/* ---------- detail tabs ---------- */

function ContainersTab({ serverId }: { serverId: string }) {
  const [rows, setRows] = useState<Container[]>([]);

  useEffect(() => {
    const load = () => api.containers(serverId).then(setRows).catch(() => setRows([]));
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [serverId]);

  if (!rows.length) return <p className="empty-state">No containers reported.</p>;

  // Group by compose project so a stack reads as one unit.
  const groups = new Map<string, Container[]>();
  for (const c of rows) {
    const key = c.project ?? "standalone";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  return (
    <div className="stack">
      {[...groups].map(([project, containers]) => (
        <section key={project}>
          <h4>{project}</h4>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Image</th>
                <th>State</th>
                <th>CPU</th>
                <th>Memory</th>
                <th>Ports</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className={`dot ${c.state === "running" ? "online" : "offline"}`} />
                    {c.name}
                  </td>
                  <td className="dim">{c.image}</td>
                  <td>
                    {c.status}
                    {c.health && c.health !== "healthy" && (
                      <span className="badge crit">{c.health}</span>
                    )}
                  </td>
                  <td>{pct(c.cpu)}</td>
                  <td>{bytes(c.memUsage)}</td>
                  <td className="dim">
                    {c.ports
                      .filter((p) => p.publicPort)
                      .map((p) => `${p.publicPort}→${p.privatePort}`)
                      .join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function ProcessesTab({ serverId }: { serverId: string }) {
  const [rows, setRows] = useState<ProcessInfo[]>([]);

  useEffect(() => {
    const load = () => api.processes(serverId).then(setRows).catch(() => setRows([]));
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [serverId]);

  return (
    <table>
      <thead>
        <tr>
          <th>PID</th>
          <th>User</th>
          <th>CPU</th>
          <th>Memory</th>
          <th>Uptime</th>
          <th>Command</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.pid}>
            <td className="dim">{p.pid}</td>
            <td>{p.user}</td>
            <td>{pct(p.cpu)}</td>
            <td>{bytes(p.rssBytes)}</td>
            <td>{duration(p.elapsedSec)}</td>
            <td className="mono truncate" title={p.args}>
              {p.args || p.command}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PortsTab({ serverId }: { serverId: string }) {
  const [rows, setRows] = useState<ListeningPort[]>([]);

  useEffect(() => {
    api.ports(serverId).then(setRows).catch(() => setRows([]));
  }, [serverId]);

  if (!rows.length) return <p className="empty-state">No listening ports reported.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Port</th>
          <th>Proto</th>
          <th>Address</th>
          <th>Process</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={`${p.proto}-${p.address}-${p.port}`}>
            <td>{p.port}</td>
            <td className="dim">{p.proto}</td>
            <td className="mono">{p.address}</td>
            <td>
              {p.process ?? "—"}
              {p.pid && <span className="dim"> ({p.pid})</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const MAX_LOG_LINES = 2000;

function LogsTab({ serverId }: { serverId: string }) {
  const [kind, setKind] = useState("docker");
  const [target, setTarget] = useState("");
  const [active, setActive] = useState<{ kind: string; target: string } | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.containers(serverId).then(setContainers).catch(() => setContainers([]));
    setActive(null);
    setLines([]);
  }, [serverId]);

  useEffect(() => {
    if (!active) return;
    setLines([]);
    setError(null);
    return connectLogs(
      serverId,
      { kind: active.kind, target: active.target, tail: 300 },
      (line) => setLines((prev) => [...prev, line].slice(-MAX_LOG_LINES)),
      setError,
    );
  }, [serverId, active]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  return (
    <div className="logs">
      <form
        className="log-controls"
        onSubmit={(e) => {
          e.preventDefault();
          if (target.trim()) setActive({ kind, target: target.trim() });
        }}
      >
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="docker">Container</option>
          <option value="journal">systemd unit</option>
          <option value="file">File</option>
        </select>

        {kind === "docker" && containers.length > 0 ? (
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Select a container…</option>
            {containers.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={kind === "journal" ? "nginx.service" : "/var/log/syslog"}
          />
        )}

        <button type="submit" disabled={!target.trim()}>
          Tail
        </button>
        {active && (
          <button type="button" onClick={() => setActive(null)}>
            Stop
          </button>
        )}
      </form>

      {error && <p className="error">{error}</p>}

      <div className="log-output">
        {lines.map((line, i) => (
          <div key={i} className={`log-line ${line.stream}`}>
            <span className="log-ts">{clock(line.ts)}</span>
            <span>{line.message}</span>
          </div>
        ))}
        {active && !lines.length && !error && <p className="empty-state">Waiting for output…</p>}
        {!active && <p className="empty-state">Pick a source and press Tail.</p>}
        <div ref={bottom} />
      </div>
    </div>
  );
}

const TABS = ["containers", "processes", "ports", "logs"] as const;
type Tab = (typeof TABS)[number];

function ServerDetail({ server, onClose }: { server: ServerSummary; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("containers");

  return (
    <aside className="detail">
      <header>
        <div>
          <h2>{server.name}</h2>
          <p className="dim">
            {server.hostname ?? server.id}
            {server.notes ? ` — ${server.notes}` : ""}
            {server.agentVersion ? ` · agent ${server.agentVersion}` : ""}
          </p>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>

      <div className="detail-body">
        {tab === "containers" && <ContainersTab serverId={server.id} />}
        {tab === "processes" && <ProcessesTab serverId={server.id} />}
        {tab === "ports" && <PortsTab serverId={server.id} />}
        {tab === "logs" && <LogsTab serverId={server.id} />}
      </div>
    </aside>
  );
}

/* ---------- app ---------- */

function App() {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [connected, setConnected] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hubVersion, setHubVersion] = useState<string | null>(null);

  const upsert = useCallback((incoming: ServerSummary) => {
    setServers((prev) => {
      const i = prev.findIndex((s) => s.id === incoming.id);
      if (i === -1) return [...prev, incoming];
      const next = [...prev];
      next[i] = incoming;
      return next;
    });
  }, []);

  useEffect(() => connectServerFeed(setServers, upsert, setConnected), [upsert]);

  // Fetched once: the hub only changes version across a restart, which drops
  // the WebSocket and remounts nothing — a reload is the honest way to update.
  useEffect(() => {
    api
      .health()
      .then((h) => setHubVersion(h.version))
      .catch(() => setHubVersion(null));
  }, []);

  const selected = useMemo(
    () => servers.find((s) => s.id === selectedId) ?? null,
    [servers, selectedId],
  );

  const offline = servers.filter((s) => s.status === "offline").length;

  return (
    <div className={`app ${selected ? "with-detail" : ""}`}>
      <header className="topbar">
        <h1>stats</h1>
        {hubVersion && <span className="version">v{hubVersion}</span>}
        <span className={`conn ${connected ? "on" : "off"}`}>
          {connected ? "live" : "reconnecting…"}
        </span>
        <span className="dim">
          {servers.length} servers{offline ? ` · ${offline} offline` : ""}
        </span>
        <button type="button" onClick={() => void api.refresh().then(setServers)}>
          Refresh
        </button>
      </header>

      <main className="grid">
        {servers.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            selected={server.id === selectedId}
            onSelect={() => setSelectedId(server.id === selectedId ? null : server.id)}
            hubVersion={hubVersion}
          />
        ))}
        {!servers.length && (
          <p className="empty-state">
            No servers yet. Add them to <code>servers.json</code> and restart the hub.
          </p>
        )}
      </main>

      {selected && <ServerDetail server={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
