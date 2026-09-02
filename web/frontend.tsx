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
	pct,
	systemStateTone,
	versionState,
	versionTone,
} from "./format.ts";
import type { MetricPoint } from "./history.ts";
import {
	connectHub,
	type HubConnection,
	type Push,
	setToken,
	token,
} from "./link.ts";
import {
	type CardFace,
	EMPTY_HISTORY,
	facesFor,
	HISTORY_MINUTES,
	HISTORY_POINTS,
	type LogTarget,
	type NodeHistory,
	tabsFor,
} from "./modules.tsx";
import { ModulesPage } from "./modulespage.tsx";
import { ActionButton, DistroChip, Dot, Empty, Pill } from "./ui.tsx";
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

/**
 * The front block. Every card keeps the same shape — header, host line, one
 * face, footer — and the face is whichever module's turn it is. Cards rotate
 * off one shared tick so the whole grid turns over together, and clicking a
 * face's dot pins that card to it until you click the dot again.
 */
function NodeCard({
	node,
	history,
	faceIndex,
	pinned,
	onPin,
	selected,
	onSelect,
	hubVersion,
}: {
	node: NodeSummary;
	history: NodeHistory;
	/** the shared rotation counter; the card maps it onto its own faces */
	faceIndex: number;
	pinned: string | null;
	onPin: (faceId: string | null) => void;
	selected: boolean;
	onSelect: () => void;
	/** what the hub is running, so a card can say it's behind */
	hubVersion: string | null;
}) {
	const offline = node.status === "offline";
	const failed = node.systemd?.failed.length ?? 0;
	const version = versionState(node.version, hubVersion);

	const faces = useMemo(() => facesFor({ node, history }), [node, history]);
	const face: CardFace | null =
		faces.find((candidate) => candidate.id === pinned) ??
		faces[faceIndex % Math.max(1, faces.length)] ??
		null;

	return (
		// A div rather than a button: the face dots are buttons of their own, and
		// a button inside a button is invalid HTML that browsers handle however
		// they feel like. The role and key handler put the keyboard back.
		<div
			// biome-ignore lint/a11y/useSemanticElements: a <button> here would
			// contain the face-dot buttons, which is exactly what we're avoiding
			role="button"
			tabIndex={0}
			aria-pressed={selected}
			className={`card ${selected ? "selected" : ""} ${node.status}`}
			onClick={onSelect}
			onKeyDown={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				onSelect();
			}}
		>
			<header>
				<Dot tone={offline ? "crit" : "ok"} title={node.status} />
				<h2>{node.name}</h2>
				<DistroChip facts={node.facts} />
				{version !== "current" && version !== "unknown" && (
					<Pill
						tone={versionTone(version)}
						title={
							version === "behind"
								? `running stats ${node.version}, the hub is on ${hubVersion} — update this node`
								: `running stats ${node.version}, ahead of the hub's ${hubVersion} — update the hub first`
						}
					>
						{node.version}
					</Pill>
				)}
			</header>

			<p className="card-host">
				<span className="mono">{node.hostname ?? node.id}</span>
				{node.remoteAddress && (
					<span className="dim"> · {node.remoteAddress}</span>
				)}
			</p>

			{offline ? (
				<div className="card-face card-offline">
					<p className="error">offline</p>
					<p className="dim">last seen {ago(node.lastSeen)}</p>
				</div>
			) : (
				<>
					<div className="card-face">
						{face ? face.render({ node, history }) : <p className="dim">…</p>}
					</div>

					{faces.length > 1 && (
						<div className="face-switch">
							{faces.map((candidate) => (
								<button
									key={candidate.id}
									type="button"
									className={`face-dot ${candidate.id === face?.id ? "on" : ""} ${
										candidate.id === pinned ? "pinned" : ""
									}`}
									title={
										candidate.id === pinned
											? `${candidate.label} — click to resume rotating`
											: `hold on ${candidate.label}`
									}
									aria-label={candidate.label}
									onClick={(event) => {
										event.stopPropagation();
										onPin(pinned === candidate.id ? null : candidate.id);
									}}
								/>
							))}
							<span className="face-label dim">{face?.label}</span>
						</div>
					)}
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
		</div>
	);
}

/* ---------- detail ---------- */

/**
 * The detail pane. Which tabs exist is the node's business: every tab comes
 * from a module the node actually loaded, so a host without docker has no
 * containers tab rather than an empty one.
 */
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
	const tabs = useMemo(() => tabsFor(node), [node]);
	const [tabId, setTabId] = useState<string>(tabs[0]?.id ?? "overview");
	const [logTarget, setLogTarget] = useState<LogTarget | undefined>();

	// A module can go away under you — the node reconnects without docker, or
	// the hub narrows it — and the pane shouldn't be left on a tab that no
	// longer exists.
	const active = tabs.find((tab) => tab.id === tabId) ?? tabs[0] ?? null;

	const go = useCallback((next: string, context?: LogTarget) => {
		setTabId(next);
		if (context) setLogTarget(context);
	}, []);

	const props = { node, telemetry, hub, go, target: logTarget };

	// The drawer pops over the fleet, so it has to take focus with it —
	// otherwise the tab key walks the cards behind the blur.
	const pane = useRef<HTMLElement>(null);
	useEffect(() => {
		pane.current?.focus();
	}, []);

	return (
		<aside
			className="detail"
			ref={pane}
			role="dialog"
			aria-modal="true"
			aria-label={`${node.name} detail`}
			tabIndex={-1}
			onKeyDown={(event) => {
				if (event.key !== "Escape") return;
				event.stopPropagation();
				onClose();
			}}
		>
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
				{tabs.map((tab) => (
					<button
						key={tab.id}
						type="button"
						className={active?.id === tab.id ? "active" : ""}
						onClick={() => setTabId(tab.id)}
					>
						{tab.label}
						{tab.badge?.(node) ? <span className="tab-badge" /> : null}
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
				{active ? (
					active.render(props)
				) : (
					<Empty>This node hasn't told the hub what it can do yet.</Empty>
				)}
			</div>
		</aside>
	);
}

/* ---------- app ---------- */

/** How often the grid turns over. "Hold" leaves every card where it is. */
const ROTATE_CHOICES = [
	{ ms: 0, label: "hold" },
	{ ms: 8000, label: "rotate 8s" },
	{ ms: 15000, label: "rotate 15s" },
	{ ms: 30000, label: "rotate 30s" },
];

const ROTATE_KEY = "stats.rotateMs";

function readRotate(): number {
	const stored = Number(localStorage.getItem(ROTATE_KEY));
	return ROTATE_CHOICES.some((choice) => choice.ms === stored) ? stored : 8000;
}

function writeRotate(ms: number) {
	localStorage.setItem(ROTATE_KEY, String(ms));
}

/**
 * The two things this dashboard is: the fleet as it is, and the fleet as the
 * operator wants it. Modules are the second, which is why they get a page
 * rather than a corner of the node drawer — the question "which nodes are
 * running docker" is a fleet question, not a per-node one.
 */
type View = "fleet" | "modules";

function App() {
	const [view, setView] = useState<View>("fleet");
	const [nodes, setNodes] = useState<NodeSummary[]>([]);
	const [telemetry, setTelemetry] = useState<Map<string, Telemetry>>(new Map());
	const [history, setHistory] = useState<Map<string, NodeHistory>>(new Map());
	const [alerts, setAlerts] = useState<Alert[]>([]);
	const [connected, setConnected] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [hubInfo, setHubInfo] = useState<{
		version: string;
		protocol: number;
	} | null>(null);
	const [needsToken, setNeedsToken] = useState(false);
	const [rotateMs, setRotateMs] = useState(readRotate);
	const [faceIndex, setFaceIndex] = useState(0);
	const [pinned, setPinned] = useState<Map<string, string>>(new Map());
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
				// A short in-memory series per face; the hub's SQLite history is for
				// anything longer, and the cards deliberately don't ask for it.
				setHistory((prev) => {
					// The series is the system module's; a node without it keeps whatever
					// it had rather than growing a run of zeroes that reads as an idle
					// machine instead of an absent collector.
					const stats = frame.telemetry.stats;
					if (!stats) return prev;
					const previous = prev.get(frame.nodeId) ?? EMPTY_HISTORY;
					const hottest = stats.temps.length
						? Math.max(...stats.temps.map((t) => t.celsius))
						: 0;
					const push = (series: number[], value: number) =>
						[...series, value].slice(-HISTORY_POINTS);

					return new Map(prev).set(frame.nodeId, {
						cpu: push(previous.cpu, stats.cpu.usage),
						mem: push(previous.mem, stats.mem.used / (stats.mem.total || 1)),
						net: push(
							previous.net,
							stats.net.reduce(
								(sum, iface) => sum + (iface.rxRate ?? 0) + (iface.txRate ?? 0),
								0,
							),
						),
						temp: push(previous.temp, hottest / 100),
					});
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
		// Doubles as the token check and as a first paint: the socket sends the
		// same list when it opens, but this way the grid doesn't depend on that
		// frame landing.
		fetch("/api/nodes", {
			headers: token() ? { authorization: `Bearer ${token()}` } : {},
		})
			.then(async (res) => {
				setNeedsToken(res.status === 401);
				if (!res.ok) return;
				const list = (await res.json()) as NodeSummary[];
				// Anything the socket has already pushed is newer than this.
				setNodes((prev) => (prev.length ? prev : list));
			})
			.catch(() => {});
	}, []);

	// Seed each card's sparklines from stored history, so a fresh page load isn't
	// flat. Only the last few minutes: these are shapes, not charts.
	useEffect(() => {
		const connection = hub.current;
		if (!connection || !connected) return;
		for (const node of nodes) {
			if (history.has(node.id)) continue;
			connection
				.request<MetricPoint[]>(HubAction.History, {
					nodeId: node.id,
					minutes: HISTORY_MINUTES,
				})
				.then((rows) => {
					const recent = rows.slice(-HISTORY_POINTS);
					setHistory((prev) =>
						prev.has(node.id)
							? prev
							: new Map(prev).set(node.id, {
									cpu: recent.map((row) => row.cpu),
									mem: recent.map((row) => row.memUsed / (row.memTotal || 1)),
									net: recent.map((row) => row.rxRate + row.txRate),
									// Temperatures aren't in the hub's history table, so this
									// one starts flat and fills in as frames arrive.
									temp: [],
								}),
					);
				})
				.catch(() => {});
		}
	}, [connected, nodes.length]);

	// One timer for the whole grid: every card turns its face at the same moment,
	// which reads as a dashboard changing rather than as tiles flickering.
	useEffect(() => {
		if (!rotateMs) return;
		const timer = setInterval(
			() => setFaceIndex((index) => index + 1),
			rotateMs,
		);
		return () => clearInterval(timer);
	}, [rotateMs]);

	const selected = useMemo(
		() => nodes.find((n) => n.id === selectedId) ?? null,
		[nodes, selectedId],
	);
	// The drawer only belongs to the fleet view; switching to modules puts it
	// away rather than leaving a node's panel floating over a different page.
	const drawer = view === "fleet" ? selected : null;
	const offline = nodes.filter((n) => n.status === "offline").length;
	// Only online nodes count: an offline one's version is whatever it last
	// reported, and "3 behind" that you can't act on is noise during a rollout.
	const online = nodes.filter((n) => n.status === "online");
	const behind = online.filter(
		(n) => versionState(n.version, hubInfo?.version ?? null) === "behind",
	).length;
	const totalCpu = nodes.filter((n) => n.status === "online" && n.cpu != null);
	const fleetCpu = totalCpu.length
		? totalCpu.reduce((sum, n) => sum + (n.cpu ?? 0), 0) / totalCpu.length
		: null;

	return (
		<div className="app">
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
				{behind > 0 && (
					<span
						className="pill warn"
						title={`${behind} online node${behind === 1 ? "" : "s"} are not on ${hubInfo?.version} — run 'stats update' there, or update from the node's panel`}
					>
						{online.length - behind}/{online.length} up to date
					</span>
				)}
				<nav className="views">
					{(["fleet", "modules"] as View[]).map((id) => (
						<button
							key={id}
							type="button"
							className={view === id ? "active" : ""}
							onClick={() => setView(id)}
						>
							{id}
						</button>
					))}
				</nav>
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
				<label className="rotate">
					<span className="dim">faces</span>
					<select
						value={String(rotateMs)}
						onChange={(event) => {
							const value = Number(event.target.value);
							setRotateMs(value);
							writeRotate(value);
						}}
					>
						{ROTATE_CHOICES.map((choice) => (
							<option key={choice.ms} value={choice.ms}>
								{choice.label}
							</option>
						))}
					</select>
				</label>
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

			{view === "modules" && hub.current && (
				<main className="page">
					<ModulesPage hub={hub.current} />
				</main>
			)}

			<main className="grid" hidden={view !== "fleet"} inert={Boolean(drawer)}>
				{nodes.map((node) => (
					<NodeCard
						key={node.id}
						node={node}
						history={history.get(node.id) ?? EMPTY_HISTORY}
						faceIndex={faceIndex}
						pinned={pinned.get(node.id) ?? null}
						onPin={(faceId) =>
							setPinned((prev) => {
								const next = new Map(prev);
								if (faceId) next.set(node.id, faceId);
								else next.delete(node.id);
								return next;
							})
						}
						selected={node.id === selectedId}
						onSelect={() =>
							setSelectedId(node.id === selectedId ? null : node.id)
						}
						hubVersion={hubInfo?.version ?? null}
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

			{drawer && hub.current && (
				<>
					{/* The blur is the point: the fleet stays visible behind the drawer
					    as context, and stops competing with it for attention. Clicking
					    it is the other way out, so it is a real button. */}
					<button
						type="button"
						className="scrim"
						aria-label="Close detail"
						onClick={() => setSelectedId(null)}
					/>
					<NodeDetail
						key={drawer.id}
						node={drawer}
						telemetry={telemetry.get(drawer.id) ?? null}
						hub={hub.current}
						onClose={() => setSelectedId(null)}
					/>
				</>
			)}
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
