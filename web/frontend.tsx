import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { HubAction } from "../src/proto/messages.ts";
import type { NodeSummary, Telemetry } from "../src/types.ts";
import {
	ago,
	bytes,
	duration,
	pct,
	rate,
	systemStateTone,
	usageTone,
} from "./format.ts";
import {
	connectHub,
	type HubConnection,
	type Push,
	setToken,
	token,
} from "./link.ts";
import {
	ContainersPanel,
	LogsPanel,
	type LogTarget,
	OverviewPanel,
	PortsPanel,
	ProcessesPanel,
	ProjectsPanel,
	ServicesPanel,
} from "./panels.tsx";
import { TerminalPanel } from "./terminal.tsx";
import {
	ActionButton,
	DistroChip,
	Dot,
	Empty,
	Meter,
	Pill,
	Sparkline,
} from "./ui.tsx";
import "./index.css";

/**
 * The dashboard. One WebSocket to the hub carries node summaries, full
 * telemetry, alerts and every control request — the panels below just render
 * whatever the latest frame said.
 */

interface Alert {
	id: number;
	nodeId: string;
	kind: string;
	message: string;
	ts: number;
}

/* ---------- node card ---------- */

function NodeCard({
	node,
	history,
	selected,
	onSelect,
}: {
	node: NodeSummary;
	history: number[];
	selected: boolean;
	onSelect: () => void;
}) {
	const offline = node.status === "offline";
	const disk = node.disks.length
		? node.disks.reduce(
				(worst, d) => (d.usage > worst.usage ? d : worst),
				node.disks[0]!,
			)
		: null;
	const memUsage = node.mem ? node.mem.used / node.mem.total : null;
	const failed = node.systemd?.failed.length ?? 0;

	return (
		<button
			type="button"
			className={`card ${selected ? "selected" : ""} ${node.status}`}
			onClick={onSelect}
		>
			<header>
				<Dot tone={offline ? "crit" : "ok"} title={node.status} />
				<h2>{node.name}</h2>
				<DistroChip facts={node.facts} />
			</header>

			<p className="card-host">
				<span className="mono">{node.hostname ?? node.id}</span>
				{node.remoteAddress && (
					<span className="dim"> · {node.remoteAddress}</span>
				)}
			</p>

			{offline ? (
				<div className="card-offline">
					<p className="error">offline</p>
					<p className="dim">last seen {ago(node.lastSeen)}</p>
				</div>
			) : (
				<>
					<div className="metrics">
						<Meter
							value={node.cpu}
							label="CPU"
							detail={
								node.loadavg ? `load ${node.loadavg[0].toFixed(2)}` : undefined
							}
						/>
						<Meter
							value={memUsage}
							label="Memory"
							detail={
								node.mem
									? `${bytes(node.mem.used)} / ${bytes(node.mem.total)}`
									: undefined
							}
						/>
						<Meter
							value={disk?.usage ?? null}
							label={disk?.mount ?? "Disk"}
							detail={disk ? bytes(disk.available) + " free" : undefined}
						/>
					</div>

					<Sparkline points={history} tone={usageTone(node.cpu)} />

					<dl className="facts">
						<div>
							<dt>Uptime</dt>
							<dd>{duration(node.uptimeSec)}</dd>
						</div>
						<div>
							<dt>Network</dt>
							<dd>
								↓{rate(node.net?.rxRate)} ↑{rate(node.net?.txRate)}
							</dd>
						</div>
						<div>
							<dt>Projects</dt>
							<dd>
								{node.projects
									? `${node.projects.running}/${node.projects.total}`
									: "—"}
								{node.projects?.degraded ? (
									<Pill tone="crit">{node.projects.degraded} degraded</Pill>
								) : null}
							</dd>
						</div>
						<div>
							<dt>Containers</dt>
							<dd>
								{node.containers
									? `${node.containers.running}/${node.containers.total}`
									: "—"}
								{node.containers?.unhealthy ? (
									<Pill tone="crit">{node.containers.unhealthy} sick</Pill>
								) : null}
							</dd>
						</div>
					</dl>
				</>
			)}

			<footer>
				{node.systemd?.state && node.systemd.state !== "running" && (
					<Pill tone={systemStateTone(node.systemd.state)}>
						systemd {node.systemd.state}
					</Pill>
				)}
				{failed > 0 && (
					<Pill tone="crit">
						{failed} failed unit{failed > 1 ? "s" : ""}
					</Pill>
				)}
				{node.tags.map((tag) => (
					<span key={tag} className="tag">
						{tag}
					</span>
				))}
				{Object.keys(node.collectorErrors).map((name) => (
					<span
						key={name}
						className="tag warn"
						title={node.collectorErrors[name]}
					>
						{name} unavailable
					</span>
				))}
				<div className="spacer" />
				{node.latencyMs != null && !offline && (
					<span className="latency">{node.latencyMs}ms</span>
				)}
			</footer>
		</button>
	);
}

/* ---------- detail ---------- */

const TABS = [
	"overview",
	"projects",
	"containers",
	"services",
	"processes",
	"ports",
	"logs",
	"terminal",
] as const;
type Tab = (typeof TABS)[number];

function NodeDetail({
	node,
	telemetry,
	hub,
	onClose,
}: {
	node: NodeSummary;
	telemetry: Telemetry | null;
	hub: HubConnection;
	onClose: () => void;
}) {
	const [tab, setTab] = useState<Tab>("overview");
	const [logTarget, setLogTarget] = useState<LogTarget | undefined>();

	const go = useCallback((next: string, context?: LogTarget) => {
		setTab(next as Tab);
		if (context) setLogTarget(context);
	}, []);

	const props = { node, telemetry, hub, go };

	return (
		<aside className="detail">
			<header className="detail-head">
				<div>
					<h2>
						<Dot tone={node.status === "online" ? "ok" : "crit"} />
						{node.name}
					</h2>
					<p className="dim">
						{node.hostname ?? node.id}
						{node.notes ? ` — ${node.notes}` : ""}
						{node.version ? ` · stats ${node.version}` : ""}
						{node.status === "offline"
							? ` · last seen ${ago(node.lastSeen)}`
							: ""}
					</p>
				</div>
				<button
					type="button"
					className="close"
					onClick={onClose}
					aria-label="Close"
				>
					×
				</button>
			</header>

			<nav className="tabs">
				{TABS.map((name) => (
					<button
						key={name}
						type="button"
						className={tab === name ? "active" : ""}
						onClick={() => setTab(name)}
					>
						{name}
						{name === "projects" && node.projects?.degraded ? (
							<span className="tab-badge" />
						) : null}
						{name === "services" && node.systemd?.failed.length ? (
							<span className="tab-badge" />
						) : null}
					</button>
				))}
			</nav>

			<div className="detail-body">
				{!telemetry && node.status === "offline" && (
					<Empty>
						This node hasn't reported since the hub started, so there's nothing
						to show.
					</Empty>
				)}
				{tab === "overview" && <OverviewPanel {...props} />}
				{tab === "projects" && <ProjectsPanel {...props} />}
				{tab === "containers" && <ContainersPanel {...props} />}
				{tab === "services" && <ServicesPanel {...props} />}
				{tab === "processes" && <ProcessesPanel {...props} />}
				{tab === "ports" && <PortsPanel {...props} />}
				{tab === "logs" && <LogsPanel {...props} target={logTarget} />}
				{tab === "terminal" && (
					<TerminalPanel node={node} telemetry={telemetry} hub={hub} />
				)}
			</div>
		</aside>
	);
}

/* ---------- app ---------- */

function App() {
	const [nodes, setNodes] = useState<NodeSummary[]>([]);
	const [telemetry, setTelemetry] = useState<Map<string, Telemetry>>(new Map());
	const [history, setHistory] = useState<Map<string, number[]>>(new Map());
	const [alerts, setAlerts] = useState<Alert[]>([]);
	const [connected, setConnected] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [hubInfo, setHubInfo] = useState<{
		version: string;
		protocol: number;
	} | null>(null);
	const [needsToken, setNeedsToken] = useState(false);
	const hub = useRef<HubConnection | null>(null);
	const alertId = useRef(0);

	const onPush = useCallback((push: Push) => {
		switch (push.event) {
			case "nodes":
				setNodes(push.nodes);
				break;
			case "node":
				setNodes((prev) => {
					const index = prev.findIndex((n) => n.id === push.node.id);
					if (index === -1) return [...prev, push.node];
					const next = [...prev];
					next[index] = push.node;
					return next;
				});
				break;
			case "telemetry": {
				const frame = push as { nodeId: string; telemetry: Telemetry };
				setTelemetry((prev) =>
					new Map(prev).set(frame.nodeId, frame.telemetry),
				);
				// Keep a short in-memory series for the card sparklines; the hub's
				// SQLite history is for anything longer.
				setHistory((prev) => {
					const next = new Map(prev);
					const points = [
						...(next.get(frame.nodeId) ?? []),
						frame.telemetry.stats.cpu.usage,
					];
					next.set(frame.nodeId, points.slice(-60));
					return next;
				});
				break;
			}
			case "status":
			case "alert": {
				const message = "message" in push ? push.message : "";
				const kind = "kind" in push ? push.kind : push.status;
				setAlerts((prev) =>
					[
						{
							id: ++alertId.current,
							nodeId: push.nodeId,
							kind,
							message,
							ts: push.ts,
						},
						...prev,
					].slice(0, 50),
				);
				break;
			}
		}
	}, []);

	useEffect(() => {
		const connection = connectHub({ onPush, onStatus: setConnected });
		hub.current = connection;
		return () => connection.close();
	}, [onPush]);

	// Health is unauthenticated, so it also tells us whether a token is needed.
	useEffect(() => {
		fetch("/api/health")
			.then((res) => res.json())
			.then((body: { version: string; protocol: number }) => setHubInfo(body))
			.catch(() => setHubInfo(null));
		fetch("/api/nodes", {
			headers: token() ? { authorization: `Bearer ${token()}` } : {},
		})
			.then((res) => setNeedsToken(res.status === 401))
			.catch(() => {});
	}, []);

	// Seed each card's sparkline from stored history, so a fresh page load isn't flat.
	useEffect(() => {
		const connection = hub.current;
		if (!connection || !connected) return;
		for (const node of nodes) {
			if (history.has(node.id)) continue;
			connection
				.request<{ cpu: number }[]>(HubAction.History, {
					nodeId: node.id,
					minutes: 30,
				})
				.then((rows) =>
					setHistory((prev) =>
						prev.has(node.id)
							? prev
							: new Map(prev).set(node.id, rows.map((r) => r.cpu).slice(-60)),
					),
				)
				.catch(() => {});
		}
	}, [connected, nodes.length]);

	const selected = useMemo(
		() => nodes.find((n) => n.id === selectedId) ?? null,
		[nodes, selectedId],
	);
	const offline = nodes.filter((n) => n.status === "offline").length;
	const totalCpu = nodes.filter((n) => n.status === "online" && n.cpu != null);
	const fleetCpu = totalCpu.length
		? totalCpu.reduce((sum, n) => sum + (n.cpu ?? 0), 0) / totalCpu.length
		: null;

	return (
		<div className={`app ${selected ? "with-detail" : ""}`}>
			<header className="topbar">
				<h1>stats</h1>
				{hubInfo && <span className="version">v{hubInfo.version}</span>}
				<span className={`conn ${connected ? "on" : "off"}`}>
					{connected ? "live" : "reconnecting…"}
				</span>
				<span className="dim">
					{nodes.length} node{nodes.length === 1 ? "" : "s"}
					{offline ? ` · ${offline} offline` : ""}
					{fleetCpu != null ? ` · ${pct(fleetCpu)} avg CPU` : ""}
				</span>
				<div className="spacer" />
				{alerts.length > 0 && (
					<details className="alerts">
						<summary>
							{alerts.length} recent event{alerts.length === 1 ? "" : "s"}
						</summary>
						<ul>
							{alerts.map((alert) => (
								<li key={alert.id}>
									<span className="dim">
										{new Date(alert.ts).toLocaleTimeString()}
									</span>
									<Pill
										tone={/online|recovered/.test(alert.kind) ? "ok" : "crit"}
									>
										{alert.kind}
									</Pill>
									{alert.message}
								</li>
							))}
						</ul>
					</details>
				)}
				<ActionButton
					onAction={async () => {
						const value = window.prompt(
							"Hub token (leave empty to clear)",
							token() ?? "",
						);
						if (value === null) return;
						setToken(value.trim() || null);
						location.reload();
					}}
				>
					Token
				</ActionButton>
			</header>

			{needsToken && (
				<p className="banner">
					This hub requires a token. Click <strong>Token</strong> and paste the
					one from its config.
				</p>
			)}

			<main className="grid">
				{nodes.map((node) => (
					<NodeCard
						key={node.id}
						node={node}
						history={history.get(node.id) ?? []}
						selected={node.id === selectedId}
						onSelect={() =>
							setSelectedId(node.id === selectedId ? null : node.id)
						}
					/>
				))}
				{!nodes.length && (
					<div className="onboarding">
						<h2>No nodes yet</h2>
						<p>
							Nodes connect to this hub — nothing here polls them. On a machine
							you want to watch, run:
						</p>
						<pre>
							<code>{`stats node --hub ws://${location.host} --token <nodeToken>`}</code>
						</pre>
						<p className="dim">
							It appears here within a few seconds. To have that node run and
							monitor your services too, drop a <code>projects.json</code> at{" "}
							<code>/etc/stats/</code> — the schema lives at{" "}
							<a href="/schema/projects.schema.json">
								/schema/projects.schema.json
							</a>
							.
						</p>
					</div>
				)}
			</main>

			{selected && hub.current && (
				<NodeDetail
					node={selected}
					telemetry={telemetry.get(selected.id) ?? null}
					hub={hub.current}
					onClose={() => setSelectedId(null)}
				/>
			)}
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
