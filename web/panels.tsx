import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { moduleOn } from "../src/modules/manifest.ts";
import {
	HubAction,
	NodeAction,
	type ProxmoxVerb,
	type UpdateApplyResult,
	type UpdateCheckResult,
} from "../src/proto/messages.ts";
import type {
	Container,
	LogLine,
	NodeSummary,
	PiholeEntry,
	ProjectStatus,
	ProxmoxGuest,
	SystemdUnit,
	SystemdUnitDetail,
	Telemetry,
} from "../src/types.ts";
import {
	ago,
	bytes,
	clock,
	count,
	cpuTime,
	dateTime,
	distro,
	duration,
	healthTone,
	pct,
	processTone,
	rate,
	systemdTime,
	systemStateTone,
	type Tone,
	unitTone,
	usageTone,
	virtualization,
} from "./format.ts";
import { DEFAULT_RANGE, HISTORY_RANGES, type MetricPoint } from "./history.ts";
import { type HubConnection, streamJson } from "./link.ts";
import {
	ActionButton,
	Chart,
	DataTable,
	Dot,
	Empty,
	ErrorNote,
	Meter,
	Pill,
	Stat,
} from "./ui.tsx";

/**
 * The detail panels. Each one renders from the node's latest telemetry frame —
 * which arrives every few seconds anyway — and only calls the hub for things
 * telemetry doesn't carry: unit details, log tails, project definitions.
 */

export interface PanelProps {
	node: NodeSummary;
	telemetry: Telemetry | null;
	hub: HubConnection;
	/** switch tabs, e.g. "show me this project's logs" */
	go: (tab: string, context?: LogTarget) => void;
}

export interface LogTarget {
	kind: "docker" | "journal" | "file" | "project";
	target: string;
}

/* ---------- updates ---------- */

/**
 * What version a node is on, and — if it opted in — a button to move it.
 *
 * The check is on demand rather than on every telemetry tick: it costs the node
 * an HTTPS request to its forge, and a fleet of fifty asking every three
 * seconds would be a small denial of service against whoever hosts the
 * releases.
 */
function UpdatePanel({ node, hub }: { node: NodeSummary; hub: HubConnection }) {
	const [status, setStatus] = useState<UpdateCheckResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [applied, setApplied] = useState<UpdateApplyResult | null>(null);

	// A node that dropped out mid-update is the expected case, not a failure:
	// the restart takes the socket with it.
	const offline = node.status === "offline";

	return (
		<section className="panel">
			<header className="panel-head">
				<h4>Version</h4>
				<Pill tone={status?.behind ? "warn" : "idle"}>
					{node.version ? `stats ${node.version}` : "unknown"}
				</Pill>
			</header>

			<div className="toolbar">
				<ActionButton
					disabled={offline}
					onAction={async () => {
						setError(null);
						setApplied(null);
						try {
							setStatus(
								(await hub.request(NodeAction.UpdateCheck, {
									nodeId: node.id,
								})) as UpdateCheckResult,
							);
						} catch (err) {
							setError(err instanceof Error ? err.message : String(err));
							throw err;
						}
					}}
				>
					check for updates
				</ActionButton>

				{status?.behind && status.allowed && (
					<ActionButton
						danger
						disabled={offline}
						title={`download ${status.latest}, verify it, and restart the service`}
						onAction={async () => {
							setError(null);
							try {
								setApplied(
									(await hub.request(NodeAction.UpdateApply, {
										nodeId: node.id,
									})) as UpdateApplyResult,
								);
							} catch (err) {
								setError(err instanceof Error ? err.message : String(err));
								throw err;
							}
						}}
					>
						update to {status.latest}
					</ActionButton>
				)}
			</div>

			{status && !applied && (
				<dl className="facts">
					<div>
						<dt>Running</dt>
						<dd>{status.current}</dd>
					</div>
					<div>
						<dt>Latest</dt>
						<dd>{status.latest}</dd>
					</div>
					<div>
						<dt>Build</dt>
						<dd className="mono">{status.asset}</dd>
					</div>
					<div>
						<dt>Remote update</dt>
						<dd>{status.allowed ? "allowed" : "refused"}</dd>
					</div>
				</dl>
			)}

			{status && !status.behind && !applied && (
				<p className="dim">Up to date.</p>
			)}

			{status?.behind && !status.allowed && !applied && (
				<p className="dim">
					This node refuses remote updates. Run <code>stats update</code> on the
					host, or start it with <code>--allow-remote-update</code> — a node
					running as root takes them by default.
				</p>
			)}

			{applied && (
				<p className="dim">
					{applied.from} → {applied.to}.{" "}
					{applied.restarting
						? `Restarting ${applied.unit} — it will reconnect in a few seconds.`
						: "Restart the service to pick it up."}
				</p>
			)}

			{error && <ErrorNote>{error}</ErrorNote>}
		</section>
	);
}

/* ---------- overview ---------- */

/**
 * The counted things this node has, and the way into the tab that lists them.
 *
 * Every entry is gated on the module that produces it, so a host without docker
 * has no container count rather than a zero — the same rule the tabs follow.
 */
function Counts({ node, telemetry, go }: PanelProps) {
	const modules = node.capabilities?.modules;
	const systemd = telemetry?.systemd ?? node.systemd;

	const entries: {
		id: string;
		tab: string;
		label: string;
		value: string;
		bad?: boolean;
	}[] = [];

	if (moduleOn(modules, "docker") && node.containers)
		entries.push({
			id: "containers",
			tab: "containers",
			label: "containers up",
			value: `${node.containers.running}/${node.containers.total}`,
			bad: node.containers.unhealthy > 0,
		});

	if (moduleOn(modules, "systemd") && systemd?.available)
		entries.push({
			id: "units",
			tab: "services",
			label: systemd.failed.length ? "units failed" : "units active",
			value: systemd.failed.length
				? String(systemd.failed.length)
				: `${systemd.active}/${systemd.total}`,
			bad: systemd.failed.length > 0,
		});

	if (moduleOn(modules, "projects") && node.projects?.total)
		entries.push({
			id: "projects",
			tab: "projects",
			label: "projects running",
			value: `${node.projects.running}/${node.projects.total}`,
			bad: node.projects.degraded > 0,
		});

	if (moduleOn(modules, "proxmox") && node.proxmox?.available)
		entries.push({
			id: "guests",
			tab: "guests",
			label: "guests running",
			value: `${node.proxmox.running}/${node.proxmox.total}`,
		});

	if (moduleOn(modules, "processes") && telemetry?.processes.length)
		entries.push({
			id: "processes",
			tab: "processes",
			label: "processes",
			value: String(telemetry.processes.length),
		});

	if (moduleOn(modules, "ports") && telemetry?.ports.length)
		entries.push({
			id: "ports",
			tab: "ports",
			label: "listening ports",
			value: String(telemetry.ports.length),
		});

	if (!entries.length) return null;

	return (
		<div className="counts">
			{entries.map((entry) => (
				<button
					key={entry.id}
					type="button"
					className={`count ${entry.bad ? "bad" : ""}`}
					onClick={() => go(entry.tab)}
					title={`open the ${entry.tab} tab`}
				>
					<strong>{entry.value}</strong>
					<span>{entry.label}</span>
				</button>
			))}
		</div>
	);
}

/**
 * What the machine is doing at this instant, from the frame that just landed.
 *
 * The per-core strip is the part worth having: the probe has always reported
 * `cpu.perCore` and nothing drew it, and it is the only thing on the page that
 * separates "busy" from "one thread pinned and eleven cores idle" — which the
 * aggregate number cannot say and the history chart cannot either.
 */
function LivePanel({ telemetry }: PanelProps) {
	const stats = telemetry?.stats;
	if (!stats) return null;

	const memUsage = stats.mem.total ? stats.mem.used / stats.mem.total : null;
	const swapUsage = stats.mem.swapTotal
		? stats.mem.swapUsed / stats.mem.swapTotal
		: null;
	const disks = [...stats.disks].sort((a, b) => b.usage - a.usage);
	const worst = disks[0] ?? null;
	const cores = stats.cpu.perCore;
	// Load is per-core pressure once you divide it: 4.0 is a busy quad-core and
	// an idle 32-core, and the ratio is the only version that reads the same on
	// both machines.
	const perCore = stats.cpu.cores ? stats.loadavg[0] / stats.cpu.cores : null;

	return (
		<section className="panel">
			<header className="panel-head">
				<h4>Right now</h4>
				<span className="dim">{clock(stats.timestamp)}</span>
			</header>

			<div className="meters">
				<Meter
					value={stats.cpu.usage}
					label="CPU"
					detail={`${stats.cpu.cores} core${stats.cpu.cores === 1 ? "" : "s"}${
						perCore != null
							? ` · load ${(perCore * 100).toFixed(0)}% of them`
							: ""
					}`}
				/>
				<Meter
					value={memUsage}
					label="Memory"
					detail={`${bytes(stats.mem.used)} of ${bytes(stats.mem.total)} · ${bytes(stats.mem.available)} available`}
				/>
				{stats.mem.swapTotal > 0 && (
					<Meter
						value={swapUsage}
						label="Swap"
						detail={`${bytes(stats.mem.swapUsed)} of ${bytes(stats.mem.swapTotal)}`}
					/>
				)}
				{worst && (
					<Meter
						value={worst.usage}
						label={worst.mount}
						detail={`${bytes(worst.available)} free${disks.length > 1 ? ` · busiest of ${disks.length} mounts` : ""}`}
					/>
				)}
			</div>

			{cores.length > 1 && (
				<>
					<p className="meter-detail" style={{ marginTop: 12 }}>
						Per-core CPU — {cores.length} logical cores, busiest{" "}
						{pct(Math.max(...cores))}
					</p>
					<div className="cores">
						{cores.map((usage, index) => (
							<div
								// A core's position in /proc/stat is the only name it has, and
								// it is stable for the life of the machine.
								// biome-ignore lint/suspicious/noArrayIndexKey: explained above
								key={index}
								className={`core ${usageTone(usage)}`}
								title={`core ${index}: ${pct(usage)}`}
							>
								<i style={{ height: `${Math.max(2, usage * 100)}%` }} />
							</div>
						))}
					</div>
				</>
			)}

			<dl className="facts-grid" style={{ marginTop: 14 }}>
				<Stat
					label="Load average"
					value={stats.loadavg.map((n) => n.toFixed(2)).join("  ")}
					title="1, 5 and 15 minute averages"
				/>
				<Stat
					label="Network"
					value={`↓${rate(stats.net.reduce((sum, n) => sum + (n.rxRate ?? 0), 0))} ↑${rate(
						stats.net.reduce((sum, n) => sum + (n.txRate ?? 0), 0),
					)}`}
				/>
				<Stat label="Cached" value={bytes(stats.mem.cached)} />
				<Stat label="Buffers" value={bytes(stats.mem.buffers)} />
				<Stat label="Free" value={bytes(stats.mem.free)} />
				<Stat label="Uptime" value={duration(stats.uptimeSec)} />
			</dl>

			{stats.temps.length > 0 && (
				<div className="chips">
					{stats.temps.map((temp) => (
						<Pill
							key={temp.name}
							tone={
								temp.celsius > 80 ? "crit" : temp.celsius > 65 ? "warn" : "idle"
							}
						>
							{temp.name} {Math.round(temp.celsius)}°C
						</Pill>
					))}
				</div>
			)}
		</section>
	);
}

/**
 * The hub's rolling series, drawn.
 *
 * Five measures, five charts: CPU and memory and storage are fractions, load is
 * a queue length and network is bytes a second, and putting two of those on one
 * plot means picking an alignment between two scales that the data never had.
 * One range control sits above all of them so every chart describes the same
 * slice — and every chart has a table twin, because a value a reader can only
 * reach by hovering is a value some readers cannot reach at all.
 */
function HistoryPanel({ node, hub }: PanelProps) {
	const [rangeId, setRangeId] = useState(DEFAULT_RANGE.id);
	const [rows, setRows] = useState<MetricPoint[]>([]);
	const [loading, setLoading] = useState(true);
	const [table, setTable] = useState(false);
	const [tick, setTick] = useState(0);

	const range =
		HISTORY_RANGES.find((candidate) => candidate.id === rangeId) ??
		DEFAULT_RANGE;

	// Slower than the telemetry tick on purpose: a day of history re-read every
	// three seconds is a query per node per tick for a picture that moves by one
	// pixel. The live panel above is what updates at frame rate.
	useEffect(() => {
		const timer = setInterval(() => setTick((n) => n + 1), 30_000);
		return () => clearInterval(timer);
	}, []);

	// `tick` is the refetch trigger: it is in the dependency list precisely
	// because nothing in the body reads it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: explained above
	useEffect(() => {
		let live = true;
		setLoading(true);
		hub
			.request<MetricPoint[]>(HubAction.History, {
				nodeId: node.id,
				minutes: range.minutes,
				buckets: range.buckets,
			})
			.then((result) => {
				if (live) setRows(result);
			})
			.catch(() => {
				if (live) setRows([]);
			})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, [hub, node.id, range.minutes, range.buckets, tick]);

	const x = useMemo(() => rows.map((row) => row.ts), [rows]);
	const fraction = (used: number, total: number) =>
		total ? used / total : null;

	return (
		<section className="panel">
			<header className="panel-head">
				<h4>History</h4>
				<span className="dim">
					{rows.length} sample{rows.length === 1 ? "" : "s"}
				</span>
			</header>

			<div className="range">
				<div className="seg">
					{HISTORY_RANGES.map((candidate) => (
						<button
							key={candidate.id}
							type="button"
							className={candidate.id === range.id ? "active" : ""}
							aria-pressed={candidate.id === range.id}
							onClick={() => setRangeId(candidate.id)}
						>
							{candidate.label}
						</button>
					))}
				</div>
				<button
					type="button"
					className="action"
					aria-pressed={table}
					onClick={() => setTable((on) => !on)}
				>
					{table ? "charts" : "table"}
				</button>
			</div>

			{!rows.length && !loading ? (
				<Empty>
					The hub has no samples for this node yet. History starts the first
					time a node reports, and is kept for as long as the hub's retention
					window.
				</Empty>
			) : table ? (
				<DataTable
					columns={[
						"Time",
						{ label: "CPU", align: "right" },
						{ label: "Memory", align: "right" },
						{ label: "Load", align: "right" },
						{ label: "Down", align: "right" },
						{ label: "Up", align: "right" },
						{ label: "Storage", align: "right" },
					]}
				>
					{[...rows].reverse().map((row) => (
						<tr key={row.ts}>
							<td className="dim">{dateTime(row.ts)}</td>
							<td className="right">{pct(row.cpu)}</td>
							<td className="right">
								{pct(fraction(row.memUsed, row.memTotal))}
							</td>
							<td className="right">{row.load1.toFixed(2)}</td>
							<td className="right">{rate(row.rxRate)}</td>
							<td className="right">{rate(row.txRate)}</td>
							<td className="right">
								{pct(fraction(row.diskUsed, row.diskTotal))}
							</td>
						</tr>
					))}
				</DataTable>
			) : (
				<div className={`charts ${loading ? "loading" : ""}`}>
					<Chart
						label="CPU"
						x={x}
						max={1}
						format={pct}
						series={[
							{
								id: "cpu",
								label: "CPU",
								values: rows.map((row) => row.cpu),
								color: "var(--series-1)",
							},
						]}
					/>
					<Chart
						label="Memory used"
						x={x}
						max={1}
						format={pct}
						series={[
							{
								id: "mem",
								label: "Memory",
								values: rows.map((row) => fraction(row.memUsed, row.memTotal)),
								color: "var(--series-1)",
							},
						]}
					/>
					<Chart
						label="Load average (1 min)"
						x={x}
						format={(value) => value.toFixed(2)}
						series={[
							{
								id: "load",
								label: "Load",
								values: rows.map((row) => row.load1),
								color: "var(--series-1)",
							},
						]}
					/>
					<Chart
						label="Network"
						x={x}
						format={rate}
						series={[
							{
								id: "rx",
								label: "down",
								values: rows.map((row) => row.rxRate),
								color: "var(--series-1)",
							},
							{
								id: "tx",
								label: "up",
								values: rows.map((row) => row.txRate),
								color: "var(--series-2)",
							},
						]}
					/>
					<Chart
						label="Storage used (all mounts)"
						x={x}
						max={1}
						format={pct}
						series={[
							{
								id: "disk",
								label: "Storage",
								values: rows.map((row) =>
									fraction(row.diskUsed, row.diskTotal),
								),
								color: "var(--series-1)",
							},
						]}
					/>
				</div>
			)}
		</section>
	);
}

export function OverviewPanel(props: PanelProps) {
	const { node, telemetry, hub, go } = props;
	const facts = telemetry?.facts ?? node.facts;
	const style = distro(facts);
	const systemd = telemetry?.systemd ?? node.systemd;
	const stats = telemetry?.stats;
	const modules = Object.entries(node.capabilities?.modules ?? {})
		.filter(([, on]) => on)
		.map(([id]) => id);

	const [events, setEvents] = useState<
		{ ts: number; kind: string; message: string }[]
	>([]);
	useEffect(() => {
		hub
			.request<{ ts: number; kind: string; message: string }[]>(
				HubAction.Events,
				{
					nodeId: node.id,
					minutes: 1440,
				},
			)
			.then(setEvents)
			.catch(() => setEvents([]));
	}, [hub, node.id, node.lastSeen]);

	return (
		<div className="stack">
			<Counts {...props} />

			<LivePanel {...props} />

			<HistoryPanel {...props} />

			<section className="panel">
				<header className="panel-head">
					<h4>Host</h4>
					{style && (
						<span
							className="distro"
							style={{ "--distro-accent": style.accent } as React.CSSProperties}
						>
							{style.full}
						</span>
					)}
				</header>

				<dl className="facts-grid">
					<Stat
						label="Hostname"
						value={facts?.hostname ?? node.hostname ?? "—"}
					/>
					<Stat label="Kernel" value={facts?.kernel ?? "—"} />
					<Stat
						label="Architecture"
						value={facts?.arch ?? node.platform ?? "—"}
					/>
					<Stat label="Platform" value={virtualization(facts)} />
					<Stat
						label="Init"
						value={
							facts?.init === "systemd" && facts.systemdVersion
								? `systemd ${facts.systemdVersion}`
								: (facts?.init ?? "—")
						}
					/>
					<Stat
						label="Uptime"
						value={duration(stats?.uptimeSec ?? node.uptimeSec)}
					/>
					<Stat
						label="Booted"
						value={facts?.bootedAt ? dateTime(facts.bootedAt) : "—"}
						title="From /proc/uptime at the time facts were collected"
					/>
					<Stat label="Timezone" value={facts?.timezone ?? "—"} />
					<Stat
						label="CPU"
						value={facts?.cpuModel ?? stats?.cpu.model ?? "—"}
					/>
					<Stat label="Cores" value={facts?.cpuCores ?? node.cores ?? "—"} />
					<Stat
						label="Memory"
						value={bytes(facts?.memTotal ?? node.mem?.total)}
					/>
					<Stat
						label="Docker"
						value={facts?.dockerVersion ?? "not installed"}
					/>
					{/* Only shown when lsb-release disagrees with os-release, which is the
              only time it tells you anything new. */}
					{facts?.lsbRelease && (
						<Stat
							label="lsb_release"
							value={facts.lsbRelease}
							title="lsb_release reports a different version from os-release"
						/>
					)}
					<Stat
						label="Machine ID"
						value={<code className="mono">{facts?.machineId ?? "—"}</code>}
					/>
					<Stat
						label="Node ID"
						value={<code className="mono">{node.id}</code>}
					/>
					<Stat
						label="Agent"
						value={node.version ? `stats ${node.version}` : "—"}
					/>
					<Stat label="Address" value={node.remoteAddress ?? "—"} />
					<Stat
						label="Latency"
						value={node.latencyMs != null ? `${node.latencyMs} ms` : "—"}
						title="round trip of the hub's last ping"
					/>
					<Stat
						label="Connected"
						value={node.connectedAt ? dateTime(node.connectedAt) : "—"}
					/>
				</dl>

				{/* The node's own addresses — the core identity every node reports,
				    module or no module, and the thing you actually need to reach it. */}
				{node.addresses.length > 0 && (
					<div
						className="chips"
						title="every non-loopback address this node has"
					>
						{node.addresses.map((address) => (
							<span key={address} className="chip static mono">
								{address}
							</span>
						))}
					</div>
				)}

				{modules.length > 0 && (
					<div className="chips" title="the modules this node loaded">
						{modules.map((id) => (
							<span key={id} className="chip static">
								{id}
							</span>
						))}
					</div>
				)}
			</section>

			<UpdatePanel node={node} hub={hub} />

			{systemd?.available && (
				<section className="panel">
					<header className="panel-head">
						<h4>systemd</h4>
						<Pill tone={systemStateTone(systemd.state)}>
							{systemd.state ?? "unknown"}
						</Pill>
					</header>
					<div className="counters">
						<div>
							<strong>{systemd.active}</strong>
							<span>active</span>
						</div>
						<div>
							<strong>{systemd.total}</strong>
							<span>loaded</span>
						</div>
						<div className={systemd.failed.length ? "bad" : ""}>
							<strong>{systemd.failed.length}</strong>
							<span>failed</span>
						</div>
					</div>
					{systemd.failed.length > 0 && (
						<ul className="failed-units">
							{systemd.failed.map((unit) => (
								<li key={unit}>
									<Dot tone="crit" />
									<button
										type="button"
										className="linkish"
										onClick={() => go("services")}
									>
										{unit}
									</button>
									<button
										type="button"
										className="linkish dim"
										onClick={() =>
											go("logs", { kind: "journal", target: unit })
										}
									>
										logs
									</button>
								</li>
							))}
						</ul>
					)}
				</section>
			)}

			{stats && (
				<section className="panel">
					<header className="panel-head">
						<h4>Storage &amp; network</h4>
					</header>
					<DataTable columns={["Mount", "Filesystem", "Used", "Size", ""]}>
						{stats.disks.map((disk) => (
							<tr key={disk.mount}>
								<td className="mono">{disk.mount}</td>
								<td className="dim mono">{disk.filesystem}</td>
								<td>{bytes(disk.used)}</td>
								<td>{bytes(disk.total)}</td>
								<td className="cell-meter">
									<div className="meter-track slim">
										<div
											className={`meter-fill ${disk.usage > 0.9 ? "crit" : disk.usage > 0.75 ? "warn" : "ok"}`}
											style={{ width: `${disk.usage * 100}%` }}
										/>
									</div>
									<span className="dim">{pct(disk.usage)}</span>
								</td>
							</tr>
						))}
					</DataTable>

					<DataTable columns={["Interface", "Down", "Up", "Received", "Sent"]}>
						{stats.net.map((iface) => (
							<tr key={iface.name}>
								<td className="mono">{iface.name}</td>
								<td>{rate(iface.rxRate)}</td>
								<td>{rate(iface.txRate)}</td>
								<td className="dim">{bytes(iface.rxBytes)}</td>
								<td className="dim">{bytes(iface.txBytes)}</td>
							</tr>
						))}
					</DataTable>
				</section>
			)}

			{Object.keys(telemetry?.errors ?? {}).length > 0 && (
				<section className="panel">
					<header className="panel-head">
						<h4>Collector problems</h4>
					</header>
					<ul className="issues">
						{Object.entries(telemetry!.errors).map(([name, message]) => (
							<li key={name}>
								<strong>{name}</strong> {message}
							</li>
						))}
					</ul>
				</section>
			)}

			<section className="panel">
				<header className="panel-head">
					<h4>Recent events</h4>
				</header>
				{events.length ? (
					<ul className="events">
						{events.slice(0, 25).map((event, i) => (
							<li key={`${event.ts}-${i}`}>
								<span className="dim">{dateTime(event.ts)}</span>
								<Pill
									tone={
										event.kind === "online" ||
										event.kind === "process-recovered"
											? "ok"
											: "crit"
									}
								>
									{event.kind}
								</Pill>
								{event.message}
							</li>
						))}
					</ul>
				) : (
					<Empty>Nothing recorded in the last day.</Empty>
				)}
			</section>
		</div>
	);
}

/* ---------- projects ---------- */

export function ProjectsPanel({ node, telemetry, hub, go }: PanelProps) {
	const projects = telemetry?.projects ?? [];
	const canControl = node.capabilities?.control ?? false;
	const [sources, setSources] = useState<string[]>([]);
	const [problems, setProblems] = useState<string[]>([]);

	const loadDefinitions = useCallback(() => {
		hub
			.request<{ sources: string[]; errors: string[] }>(
				NodeAction.ProjectsList,
				{ nodeId: node.id },
			)
			.then((result) => {
				setSources(result.sources);
				setProblems(result.errors);
			})
			.catch(() => {});
	}, [hub, node.id]);

	useEffect(loadDefinitions, [loadDefinitions]);

	const act = (
		projectId: string,
		verb: "start" | "stop" | "restart",
		processId?: string,
	) =>
		hub.request(NodeAction.ProjectAction, {
			nodeId: node.id,
			projectId,
			processId,
			verb,
		});

	return (
		<div className="stack">
			<div className="toolbar">
				<span className="dim">
					{sources.length
						? `defined in ${sources.join(", ")}`
						: "no projects file on this node"}
				</span>
				<ActionButton
					disabled={!canControl}
					title={
						canControl
							? "Re-read the projects file"
							: "control is disabled on this node"
					}
					onAction={async () => {
						await hub.request(NodeAction.ProjectsReload, { nodeId: node.id });
						loadDefinitions();
					}}
				>
					Reload file
				</ActionButton>
			</div>

			{problems.length > 0 && (
				<section className="panel">
					<header className="panel-head">
						<h4>Problems in the projects file</h4>
					</header>
					<ul className="issues">
						{problems.map((problem) => (
							<li key={problem}>{problem}</li>
						))}
					</ul>
				</section>
			)}

			{!projects.length && (
				<Empty>
					Nothing declared. Add <code>/etc/stats/projects.json</code> on this
					host to have the node run and watch your services.
				</Empty>
			)}

			{projects.map((project) => (
				<ProjectCard
					key={project.id}
					project={project}
					canControl={canControl}
					act={act}
					go={go}
				/>
			))}
		</div>
	);
}

function ProjectCard({
	project,
	canControl,
	act,
	go,
}: {
	project: ProjectStatus;
	canControl: boolean;
	act: (
		projectId: string,
		verb: "start" | "stop" | "restart",
		processId?: string,
	) => Promise<unknown>;
	go: (tab: string, context?: LogTarget) => void;
}) {
	const tone =
		project.summary === "running"
			? "ok"
			: project.summary === "degraded"
				? "crit"
				: project.summary === "stopped"
					? "idle"
					: "info";

	return (
		<section className="panel project">
			<header className="panel-head">
				<Dot tone={tone} />
				<h4>{project.name}</h4>
				<Pill tone={tone}>{project.summary}</Pill>
				{project.tags.map((tag) => (
					<span key={tag} className="tag">
						{tag}
					</span>
				))}
				{project.url && (
					<a
						className="linkish"
						href={project.url}
						target="_blank"
						rel="noreferrer"
					>
						open ↗
					</a>
				)}
				<div className="spacer" />
				<ActionButton
					disabled={!canControl}
					onAction={() => act(project.id, "start")}
				>
					Start all
				</ActionButton>
				<ActionButton
					disabled={!canControl}
					onAction={() => act(project.id, "restart")}
				>
					Restart all
				</ActionButton>
				<ActionButton
					danger
					disabled={!canControl}
					onAction={() => act(project.id, "stop")}
				>
					Stop all
				</ActionButton>
			</header>

			{project.description && <p className="dim">{project.description}</p>}

			{project.processes.length ? (
				<DataTable
					columns={[
						"Process",
						"State",
						"Health",
						"PID",
						"Uptime",
						"CPU",
						"Memory",
						"Restarts",
						"",
					]}
				>
					{project.processes.map((proc) => (
						<tr key={proc.id}>
							<td>
								<div className="stacked">
									<span>{proc.name}</span>
									<code className="mono dim truncate" title={proc.command}>
										{proc.command}
									</code>
								</div>
							</td>
							<td>
								<Pill
									tone={processTone(proc.state)}
									title={proc.error ?? undefined}
								>
									{proc.state}
								</Pill>
								{proc.lastExitCode !== null && proc.state !== "running" && (
									<span className="dim"> exit {proc.lastExitCode}</span>
								)}
							</td>
							<td>
								{proc.health === "unknown" ? (
									<span className="dim">—</span>
								) : (
									<Pill
										tone={healthTone(proc.health)}
										title={proc.healthDetail ?? undefined}
									>
										{proc.health}
									</Pill>
								)}
							</td>
							<td className="dim mono">{proc.pid ?? "—"}</td>
							<td>{duration(proc.uptimeSec)}</td>
							<td>{pct(proc.cpu)}</td>
							<td>{bytes(proc.rssBytes)}</td>
							<td className={proc.restarts ? "warn-text" : "dim"}>
								{proc.restarts}
							</td>
							<td className="row-actions">
								<ActionButton
									disabled={!canControl}
									onAction={() => act(project.id, "restart", proc.id)}
								>
									↻
								</ActionButton>
								<ActionButton
									danger
									disabled={!canControl || proc.state === "stopped"}
									onAction={() => act(project.id, "stop", proc.id)}
								>
									■
								</ActionButton>
								<ActionButton
									disabled={!canControl || proc.state === "running"}
									onAction={() => act(project.id, "start", proc.id)}
								>
									▶
								</ActionButton>
								<button
									type="button"
									className="action"
									onClick={() =>
										go("logs", {
											kind: "project",
											target: `${project.id}/${proc.id}`,
										})
									}
								>
									logs
								</button>
							</td>
						</tr>
					))}
				</DataTable>
			) : (
				<p className="dim">
					No processes — this project only watches the things below.
				</p>
			)}

			{(project.watch.systemd.length > 0 ||
				project.watch.containers.length > 0 ||
				project.watch.ports.length > 0) && (
				<div className="chips watch">
					{project.watch.systemd.map((unit) => (
						<button
							key={unit}
							type="button"
							className="chip"
							onClick={() => go("logs", { kind: "journal", target: unit })}
						>
							unit {unit}
						</button>
					))}
					{project.watch.containers.map((container) => (
						<button
							key={container}
							type="button"
							className="chip"
							onClick={() => go("logs", { kind: "docker", target: container })}
						>
							container {container}
						</button>
					))}
					{project.watch.ports.map((port) => (
						<span key={port} className="chip static">
							port {port}
						</span>
					))}
				</div>
			)}
		</section>
	);
}

/* ---------- containers ---------- */

export function ContainersPanel({ node, telemetry, hub, go }: PanelProps) {
	const containers = telemetry?.containers ?? [];
	const canControl = node.capabilities?.control ?? false;

	if (!containers.length) {
		return (
			<Empty>
				{moduleOn(node.capabilities?.modules, "docker")
					? "No containers reported."
					: "The docker module isn't loaded on this node."}
			</Empty>
		);
	}

	const groups = new Map<string, Container[]>();
	for (const container of containers) {
		const key = container.project ?? "standalone";
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(container);
	}

	const act = (name: string, verb: "start" | "stop" | "restart") =>
		hub.request(NodeAction.ContainerAction, {
			nodeId: node.id,
			container: name,
			verb,
		});

	return (
		<div className="stack">
			{[...groups].map(([project, group]) => (
				<section key={project} className="panel">
					<header className="panel-head">
						<h4>{project}</h4>
						<span className="dim">
							{group.filter((c) => c.state === "running").length}/{group.length}{" "}
							running
						</span>
					</header>
					<DataTable
						columns={["Name", "Image", "Status", "CPU", "Memory", "Ports", ""]}
					>
						{group.map((container) => (
							<tr key={container.id}>
								<td>
									<Dot tone={container.state === "running" ? "ok" : "idle"} />
									{container.name}
								</td>
								<td className="dim truncate" title={container.image}>
									{container.image}
								</td>
								<td>
									{container.status}
									{container.health && container.health !== "healthy" && (
										<Pill tone="crit">{container.health}</Pill>
									)}
									{container.restartCount ? (
										<span className="dim">
											{" "}
											· {container.restartCount} restarts
										</span>
									) : null}
								</td>
								<td>{pct(container.cpu)}</td>
								<td>{bytes(container.memUsage)}</td>
								<td className="dim mono">
									{container.ports
										.filter((p) => p.publicPort)
										.map((p) => `${p.publicPort}→${p.privatePort}`)
										.join(", ") || "—"}
								</td>
								<td className="row-actions">
									<ActionButton
										disabled={!canControl}
										onAction={() => act(container.name, "restart")}
									>
										↻
									</ActionButton>
									<ActionButton
										danger
										disabled={!canControl || container.state !== "running"}
										onAction={() => act(container.name, "stop")}
									>
										■
									</ActionButton>
									<ActionButton
										disabled={!canControl || container.state === "running"}
										onAction={() => act(container.name, "start")}
									>
										▶
									</ActionButton>
									<button
										type="button"
										className="action"
										onClick={() =>
											go("logs", { kind: "docker", target: container.name })
										}
									>
										logs
									</button>
								</td>
							</tr>
						))}
					</DataTable>
				</section>
			))}
		</div>
	);
}

/* ---------- proxmox guests ---------- */

/** Running is the only green state; a lock means "ask again in a minute". */
function guestTone(guest: ProxmoxGuest): Tone {
	if (guest.template) return "idle";
	if (guest.lock) return "warn";
	switch (guest.status) {
		case "running":
			return "ok";
		case "paused":
			return "warn";
		case "unknown":
			return "crit";
		default:
			return "idle";
	}
}

export function GuestsPanel({ node, telemetry, hub, go }: PanelProps) {
	const guests = telemetry?.guests ?? [];
	const proxmox = telemetry?.proxmox ?? node.proxmox;
	const canControl = node.capabilities?.control ?? false;
	const [filter, setFilter] = useState("");

	if (!guests.length) {
		return (
			<Empty>
				{moduleOn(node.capabilities?.modules, "proxmox")
					? "No guests reported by this Proxmox host."
					: "The proxmox module isn't loaded on this node."}
			</Empty>
		);
	}

	const needle = filter.trim().toLowerCase();
	const shown = needle
		? guests.filter(
				(guest) =>
					guest.name.toLowerCase().includes(needle) ||
					String(guest.vmid).includes(needle) ||
					guest.tags.some((tag) => tag.toLowerCase().includes(needle)),
			)
		: guests;

	const act = (guest: ProxmoxGuest, verb: ProxmoxVerb) =>
		hub.request(NodeAction.GuestAction, {
			nodeId: node.id,
			node: guest.node,
			vmid: guest.vmid,
			type: guest.type,
			verb,
		});

	// One table per PVE host: on a cluster that grouping is the first thing you
	// want, and on a standalone install it costs one header.
	const byHost = new Map<string, ProxmoxGuest[]>();
	for (const guest of shown) {
		const key = guest.node || "unknown";
		if (!byHost.has(key)) byHost.set(key, []);
		byHost.get(key)!.push(guest);
	}

	return (
		<div className="stack">
			<div className="toolbar">
				<input
					placeholder="filter by name, vmid or tag…"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
				<span className="dim">
					{proxmox?.running ?? 0}/{proxmox?.total ?? 0} running
					{proxmox?.cluster ? ` · cluster ${proxmox.cluster}` : ""}
					{proxmox?.version ? ` · pve ${proxmox.version}` : ""}
				</span>
			</div>

			{[...byHost].map(([host, group]) => {
				const stats = proxmox?.hosts.find((entry) => entry.node === host);
				return (
					<section key={host} className="panel">
						<header className="panel-head">
							<h4>
								<Dot tone={stats?.status === "online" ? "ok" : "idle"} />
								{host}
							</h4>
							<span className="dim">
								{stats
									? `${pct(stats.cpu)} cpu · ${bytes(stats.memUsed)} of ${bytes(
											stats.memMax,
										)} · up ${duration(stats.uptimeSec)}`
									: `${group.length} guest(s)`}
							</span>
						</header>
						<DataTable
							columns={["Guest", "Type", "Status", "CPU", "Memory", "Disk", ""]}
						>
							{group.map((guest) => (
								<tr key={`${guest.node}/${guest.type}/${guest.vmid}`}>
									<td>
										<Dot tone={guestTone(guest)} />
										<span className="mono dim">{guest.vmid}</span> {guest.name}
										{guest.tags.map((tag) => (
											<Pill key={tag}>{tag}</Pill>
										))}
									</td>
									<td className="dim">{guest.type === "lxc" ? "LXC" : "VM"}</td>
									<td>
										{guest.template ? "template" : guest.status}
										{guest.lock && <Pill tone="warn">{guest.lock}</Pill>}
										{guest.haState && guest.haState !== "started" && (
											<Pill tone="info">ha {guest.haState}</Pill>
										)}
										{guest.uptimeSec ? (
											<span className="dim">
												{" "}
												· up {duration(guest.uptimeSec)}
											</span>
										) : null}
									</td>
									<td>{pct(guest.cpu)}</td>
									<td>
										{guest.memMax
											? `${bytes(guest.memUsed)} / ${bytes(guest.memMax)}`
											: "—"}
									</td>
									<td>
										{guest.diskMax
											? `${bytes(guest.diskUsed)} / ${bytes(guest.diskMax)}`
											: "—"}
									</td>
									<td className="row-actions">
										{guest.template ? (
											<span className="dim">—</span>
										) : (
											<>
												<ActionButton
													disabled={!canControl || guest.status !== "running"}
													title="reboot"
													onAction={() => act(guest, "reboot")}
												>
													↻
												</ActionButton>
												<ActionButton
													disabled={!canControl || guest.status !== "running"}
													title="shut down from inside the guest"
													onAction={() => act(guest, "shutdown")}
												>
													⏻
												</ActionButton>
												<ActionButton
													danger
													disabled={!canControl || guest.status !== "running"}
													title="stop — pulls the power"
													onAction={() => act(guest, "stop")}
												>
													■
												</ActionButton>
												<ActionButton
													disabled={!canControl || guest.status === "running"}
													title="start"
													onAction={() => act(guest, "start")}
												>
													▶
												</ActionButton>
											</>
										)}
										{guest.type === "lxc" && (
											<button
												type="button"
												className="action"
												onClick={() =>
													go("logs", {
														kind: "journal",
														target: `pve-container@${guest.vmid}.service`,
													})
												}
											>
												logs
											</button>
										)}
									</td>
								</tr>
							))}
						</DataTable>
					</section>
				);
			})}

			{proxmox?.storage.length ? (
				<section className="panel">
					<header className="panel-head">
						<h4>Storage</h4>
					</header>
					<DataTable columns={["Storage", "Node", "Type", "Used", "Status"]}>
						{proxmox.storage.map((store) => (
							<tr key={store.id}>
								<td>{store.storage}</td>
								<td className="dim">{store.node}</td>
								<td className="dim">{store.type}</td>
								<td>
									{store.total
										? `${bytes(store.used)} / ${bytes(store.total)} (${pct(
												(store.used ?? 0) / store.total,
											)})`
										: "—"}
								</td>
								<td>
									<Pill tone={store.status === "available" ? "ok" : "idle"}>
										{store.status}
									</Pill>
								</td>
							</tr>
						))}
					</DataTable>
				</section>
			) : null}
		</div>
	);
}

/* ---------- pi-hole ---------- */

/** How long the dashboard offers to hold blocking off for. */
const PAUSES: { label: string; seconds: number | null }[] = [
	{ label: "30s", seconds: 30 },
	{ label: "5m", seconds: 300 },
	{ label: "indefinitely", seconds: null },
];

/** One leaderboard. They all have the same shape, so they share one renderer. */
function PiholeTop({
	title,
	unit,
	entries,
}: {
	title: string;
	unit: string;
	entries: PiholeEntry[];
}) {
	const most = entries.reduce((max, entry) => Math.max(max, entry.count), 0);
	return (
		<section className="panel">
			<header className="panel-head">
				<h4>{title}</h4>
				<span className="dim">{unit}</span>
			</header>
			{entries.length ? (
				<DataTable columns={[title, "", unit]}>
					{entries.map((entry) => (
						<tr key={`${entry.label ?? ""}${entry.name}`}>
							<td className="truncate" title={entry.name}>
								{entry.label ?? entry.name}
							</td>
							<td>
								{/* The bar is the row's share of the busiest row, which is
								    the comparison anyone reading a top-ten actually makes. */}
								<Meter
									value={most ? entry.count / most : null}
									label={entry.label ? entry.name : ""}
									format={() => ""}
									tone="info"
								/>
							</td>
							<td className="mono">{count(entry.count)}</td>
						</tr>
					))}
				</DataTable>
			) : (
				<Empty>Nothing yet.</Empty>
			)}
		</section>
	);
}

export function PiholePanel({ node, telemetry, hub }: PanelProps) {
	const pihole = telemetry?.pihole ?? node.pihole;
	const detail = telemetry?.piholeDetail;
	const canControl = node.capabilities?.control ?? false;
	const error = telemetry?.errors?.pihole ?? node.collectorErrors?.pihole;

	if (!pihole?.available) {
		return (
			<>
				{error && <ErrorNote>{error}</ErrorNote>}
				<Empty>
					{moduleOn(node.capabilities?.modules, "pihole")
						? "This node hasn't reached its Pi-hole yet."
						: "The pihole module isn't loaded on this node."}
				</Empty>
			</>
		);
	}

	const blocking = pihole.blocking === "enabled";
	const set = (enabled: boolean, seconds: number | null) =>
		hub.request(NodeAction.PiholeBlocking, {
			nodeId: node.id,
			blocking: enabled,
			seconds,
		});

	const types = Object.entries(detail?.queryTypes ?? {})
		.filter(([, share]) => share > 0)
		.sort((a, b) => b[1] - a[1]);

	return (
		<div className="stack">
			{error && <ErrorNote>{error}</ErrorNote>}

			<section className="panel">
				<header className="panel-head">
					<h4>
						<Dot tone={blocking ? "ok" : "warn"} />
						{pihole.blocking === "unknown"
							? "Blocking state unknown"
							: blocking
								? "Blocking"
								: "Not blocking"}
						{pihole.blockingTimerSec ? (
							<Pill tone="warn">
								back on in {duration(pihole.blockingTimerSec)}
							</Pill>
						) : null}
					</h4>
					<span className="row-actions">
						{blocking ? (
							PAUSES.map((pause) => (
								<ActionButton
									key={pause.label}
									danger
									disabled={!canControl}
									title={`stop blocking ${pause.label}`}
									onAction={() => set(false, pause.seconds)}
								>
									pause {pause.label}
								</ActionButton>
							))
						) : (
							<ActionButton
								disabled={!canControl}
								title="resume blocking"
								onAction={() => set(true, null)}
							>
								resume blocking
							</ActionButton>
						)}
					</span>
				</header>

				{/* Stat is a dt/dd pair, so it wants a list around it — the same
				    grid the overview's facts use. */}
				<dl className="facts-grid">
					<Stat label="Queries today" value={count(pihole.queries)} />
					<Stat label="Blocked" value={count(pihole.blocked)} />
					<Stat label="Cached" value={count(pihole.cached)} />
					<Stat label="Forwarded" value={count(pihole.forwarded)} />
					<Stat label="Clients" value={count(pihole.activeClients)} />
					<Stat label="Domains asked for" value={count(pihole.uniqueDomains)} />
					<Stat label="On the blocklist" value={count(pihole.gravityDomains)} />
					<Stat
						label="Gravity updated"
						value={pihole.gravityUpdated ? ago(pihole.gravityUpdated) : "—"}
						title={dateTime(pihole.gravityUpdated)}
					/>
				</dl>

				<Meter
					value={pihole.blockedRatio}
					label="Blocked"
					tone={blocking ? "info" : "warn"}
					detail={`${count(pihole.blocked)} of ${count(pihole.queries)} queries · ${
						pihole.url ?? ""
					}${pihole.version ? ` · ${pihole.version}` : ""} · api ${pihole.via}`}
				/>
			</section>

			{types.length ? (
				<section className="panel">
					<header className="panel-head">
						<h4>Query types</h4>
						<span className="dim">share of today's queries</span>
					</header>
					<dl className="facts-grid">
						{types.slice(0, 6).map(([name, share]) => (
							<Stat key={name} label={name} value={pct(share)} />
						))}
					</dl>
				</section>
			) : null}

			<PiholeTop
				title="Top domains"
				unit="queries"
				entries={detail?.topQueries ?? []}
			/>
			<PiholeTop
				title="Top blocked"
				unit="blocked"
				entries={detail?.topBlocked ?? []}
			/>
			<PiholeTop
				title="Top clients"
				unit="queries"
				entries={detail?.topClients ?? []}
			/>
			<PiholeTop
				title="Upstreams"
				unit="queries"
				entries={detail?.upstreams ?? []}
			/>
		</div>
	);
}

/* ---------- systemd services ---------- */

export function ServicesPanel({ node, telemetry, hub, go }: PanelProps) {
	const units = telemetry?.units ?? [];
	const [filter, setFilter] = useState("");
	const [type, setType] = useState("service");
	const [selected, setSelected] = useState<string | null>(null);

	const types = useMemo(
		() => [...new Set(units.map((u) => u.type))].sort(),
		[units],
	);
	const visible = units.filter(
		(unit) =>
			(type === "all" || unit.type === type) &&
			(!filter ||
				unit.unit.includes(filter) ||
				unit.description.toLowerCase().includes(filter.toLowerCase())),
	);

	if (!telemetry?.systemd.available) {
		return (
			<Empty>
				This host doesn't run systemd ({telemetry?.facts?.init ?? "unknown"}{" "}
				instead).
			</Empty>
		);
	}

	return (
		<div className="stack">
			<div className="toolbar">
				<select value={type} onChange={(e) => setType(e.target.value)}>
					<option value="all">all types</option>
					{types.map((t) => (
						<option key={t} value={t}>
							{t}
						</option>
					))}
				</select>
				<input
					value={filter}
					placeholder="filter units…"
					onChange={(e) => setFilter(e.target.value)}
				/>
				<span className="dim">{visible.length} shown</span>
			</div>

			<DataTable
				columns={["Unit", "Load", "Active", "Sub", "Description", ""]}
				className="units"
			>
				{visible.map((unit) => (
					<UnitRow
						key={unit.unit}
						unit={unit}
						node={node}
						hub={hub}
						expanded={selected === unit.unit}
						onToggle={() =>
							setSelected(selected === unit.unit ? null : unit.unit)
						}
						go={go}
					/>
				))}
			</DataTable>
		</div>
	);
}

function UnitRow({
	unit,
	node,
	hub,
	expanded,
	onToggle,
	go,
}: {
	unit: SystemdUnit;
	node: NodeSummary;
	hub: HubConnection;
	expanded: boolean;
	onToggle: () => void;
	go: (tab: string, context?: LogTarget) => void;
}) {
	const [detail, setDetail] = useState<SystemdUnitDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const canControl = node.capabilities?.control ?? false;
	const tone = unitTone(unit);

	useEffect(() => {
		if (!expanded) return;
		setError(null);
		hub
			.request<SystemdUnitDetail>(NodeAction.UnitShow, {
				nodeId: node.id,
				unit: unit.unit,
			})
			.then(setDetail)
			.catch((err: Error) => setError(err.message));
	}, [expanded, hub, node.id, unit.unit]);

	return (
		<>
			<tr
				className={`unit-row ${expanded ? "expanded" : ""}`}
				onClick={onToggle}
			>
				<td className="mono">
					<Dot tone={tone} />
					{unit.unit}
				</td>
				<td className={unit.load === "loaded" ? "dim" : "warn-text"}>
					{unit.load}
				</td>
				<td>
					<Pill tone={tone}>{unit.active}</Pill>
				</td>
				<td className="dim">{unit.sub}</td>
				<td className="truncate" title={unit.description}>
					{unit.description}
				</td>
				<td className="row-actions">
					<button
						type="button"
						className="action"
						onClick={(e) => {
							e.stopPropagation();
							go("logs", { kind: "journal", target: unit.unit });
						}}
					>
						logs
					</button>
				</td>
			</tr>

			{expanded && (
				<tr className="detail-row">
					<td colSpan={6}>
						{error && <ErrorNote>{error}</ErrorNote>}
						{detail && (
							<div className="unit-detail">
								<dl className="facts-grid">
									<Stat label="Unit file" value={detail.unitFileState ?? "—"} />
									<Stat
										label="Path"
										value={
											<code className="mono">{detail.fragmentPath ?? "—"}</code>
										}
									/>
									<Stat label="Main PID" value={detail.mainPid || "—"} />
									<Stat
										label="Started"
										value={systemdTime(detail.execMainStartTimestamp)}
									/>
									<Stat
										label="Active since"
										value={systemdTime(detail.activeEnterTimestamp)}
									/>
									<Stat label="Memory" value={bytes(detail.memoryCurrent)} />
									<Stat label="CPU time" value={cpuTime(detail.cpuUsageNSec)} />
									<Stat label="Tasks" value={detail.tasksCurrent ?? "—"} />
									<Stat label="Restarts" value={detail.nRestarts ?? 0} />
									<Stat label="Result" value={detail.result ?? "—"} />
								</dl>
								<div className="row-actions">
									{(["start", "stop", "restart", "reload"] as const).map(
										(verb) => (
											<ActionButton
												key={verb}
												danger={verb === "stop"}
												disabled={!canControl}
												title={
													canControl
														? undefined
														: "control is disabled on this node"
												}
												onAction={() =>
													hub.request(NodeAction.UnitAction, {
														nodeId: node.id,
														unit: unit.unit,
														verb,
													})
												}
											>
												{verb}
											</ActionButton>
										),
									)}
								</div>
							</div>
						)}
					</td>
				</tr>
			)}
		</>
	);
}

/* ---------- processes and ports ---------- */

export function ProcessesPanel({ telemetry }: PanelProps) {
	const processes = telemetry?.processes ?? [];
	const [filter, setFilter] = useState("");
	const visible = processes.filter(
		(p) =>
			!filter ||
			`${p.command} ${p.args} ${p.user}`
				.toLowerCase()
				.includes(filter.toLowerCase()),
	);

	return (
		<div className="stack">
			<div className="toolbar">
				<input
					value={filter}
					placeholder="filter processes…"
					onChange={(e) => setFilter(e.target.value)}
				/>
				<span className="dim">top {processes.length} by CPU</span>
			</div>
			<DataTable
				columns={["PID", "User", "CPU", "Memory", "Uptime", "Command"]}
			>
				{visible.map((proc) => (
					<tr key={proc.pid}>
						<td className="dim mono">{proc.pid}</td>
						<td>{proc.user}</td>
						<td>{pct(proc.cpu)}</td>
						<td>{bytes(proc.rssBytes)}</td>
						<td>{duration(proc.elapsedSec)}</td>
						<td className="mono truncate" title={proc.args}>
							{proc.args || proc.command}
						</td>
					</tr>
				))}
			</DataTable>
		</div>
	);
}

export function PortsPanel({ telemetry }: PanelProps) {
	const ports = telemetry?.ports ?? [];
	if (!ports.length) return <Empty>No listening ports reported.</Empty>;

	return (
		<DataTable columns={["Port", "Proto", "Address", "Process"]}>
			{ports.map((port) => (
				<tr key={`${port.proto}-${port.address}-${port.port}`}>
					<td>
						<strong>{port.port}</strong>
					</td>
					<td className="dim">{port.proto}</td>
					<td className="mono">{port.address}</td>
					<td>
						{port.process ?? "—"}
						{port.pid ? <span className="dim"> ({port.pid})</span> : null}
					</td>
				</tr>
			))}
		</DataTable>
	);
}

/* ---------- logs ---------- */

const MAX_LOG_LINES = 5000;

export function LogsPanel({
	node,
	telemetry,
	hub,
	target,
}: PanelProps & { target?: LogTarget }) {
	const [kind, setKind] = useState<LogTarget["kind"]>(
		target?.kind ?? "journal",
	);
	const [value, setValue] = useState(target?.target ?? "");
	const [active, setActive] = useState<LogTarget | null>(target ?? null);
	const [lines, setLines] = useState<LogLine[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [follow, setFollow] = useState(true);
	const bottom = useRef<HTMLDivElement>(null);

	// Arriving from another panel ("show me this unit's logs") starts a tail.
	useEffect(() => {
		if (!target) return;
		setKind(target.kind);
		setValue(target.target);
		setActive(target);
	}, [target?.kind, target?.target]);

	useEffect(() => {
		if (!active) return;
		setLines([]);
		setError(null);

		let stream: ReturnType<HubConnection["stream"]> | null = null;
		try {
			stream = hub.stream(
				NodeAction.LogsTail,
				{
					nodeId: node.id,
					kind: active.kind,
					target: active.target,
					tail: 400,
					follow: true,
				},
				{
					onData: (payload, binary) => {
						if (binary) return;
						const batch = streamJson<LogLine[]>(payload);
						setLines((prev) => [...prev, ...batch].slice(-MAX_LOG_LINES));
					},
					onEnd: (err) => {
						if (err) setError(err.message);
					},
				},
			);
			stream.ready.catch((err: Error) => setError(err.message));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}

		return () => stream?.end();
	}, [hub, node.id, active?.kind, active?.target]);

	useEffect(() => {
		if (follow) bottom.current?.scrollIntoView({ block: "end" });
	}, [lines, follow]);

	const suggestions = useMemo(() => {
		if (kind === "docker")
			return telemetry?.containers.map((c) => c.name) ?? [];
		if (kind === "journal")
			return (
				telemetry?.units
					.filter((u) => u.type === "service")
					.map((u) => u.unit) ?? []
			);
		if (kind === "project") {
			return (telemetry?.projects ?? []).flatMap((p) =>
				p.processes.map((proc) => `${p.id}/${proc.id}`),
			);
		}
		return (telemetry?.projects ?? []).flatMap((p) => p.watch.paths);
	}, [kind, telemetry]);

	return (
		<div className="logs">
			<form
				className="toolbar"
				onSubmit={(event) => {
					event.preventDefault();
					if (value.trim()) setActive({ kind, target: value.trim() });
				}}
			>
				<select
					value={kind}
					onChange={(event) => {
						setKind(event.target.value as LogTarget["kind"]);
						setValue("");
					}}
				>
					<option value="journal">systemd unit</option>
					<option value="docker">container</option>
					<option value="project">project process</option>
					<option value="file">file</option>
				</select>

				<input
					list="log-suggestions"
					value={value}
					onChange={(event) => setValue(event.target.value)}
					placeholder={
						kind === "file"
							? "/var/log/syslog"
							: kind === "journal"
								? "nginx.service"
								: kind === "project"
									? "project/process"
									: "container name"
					}
				/>
				<datalist id="log-suggestions">
					{suggestions.map((suggestion) => (
						<option key={suggestion} value={suggestion} />
					))}
				</datalist>

				<button type="submit" disabled={!value.trim()}>
					Tail
				</button>
				{active && (
					<button type="button" onClick={() => setActive(null)}>
						Stop
					</button>
				)}
				<label className="check">
					<input
						type="checkbox"
						checked={follow}
						onChange={(e) => setFollow(e.target.checked)}
					/>
					follow
				</label>
				<div className="spacer" />
				<span className="dim">{lines.length} lines</span>
			</form>

			{error && <ErrorNote>{error}</ErrorNote>}

			<div className="log-output" onWheel={() => setFollow(false)}>
				{lines.map((line, i) => (
					<div key={i} className={`log-line ${line.stream}`}>
						<span className="log-ts">{clock(line.ts)}</span>
						<span className="log-message">{line.message}</span>
					</div>
				))}
				{active && !lines.length && !error && (
					<Empty>Waiting for output…</Empty>
				)}
				{!active && <Empty>Pick a source and press Tail.</Empty>}
				<div ref={bottom} />
			</div>
		</div>
	);
}
