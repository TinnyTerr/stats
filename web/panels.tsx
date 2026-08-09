import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HubAction, NodeAction } from "../src/proto/messages.ts";
import type {
	Container,
	LogLine,
	NodeSummary,
	ProjectStatus,
	SystemdUnit,
	SystemdUnitDetail,
	Telemetry,
} from "../src/types.ts";
import {
	bytes,
	clock,
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
	unitTone,
	virtualization,
} from "./format.ts";
import { type HubConnection, streamJson } from "./link.ts";
import {
	ActionButton,
	DataTable,
	Dot,
	Empty,
	ErrorNote,
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

/* ---------- overview ---------- */

export function OverviewPanel({ node, telemetry, hub, go }: PanelProps) {
	const facts = telemetry?.facts ?? node.facts;
	const style = distro(facts);
	const systemd = telemetry?.systemd ?? node.systemd;
	const stats = telemetry?.stats;

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
					<Stat label="Architecture" value={facts?.arch ?? "—"} />
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
				</dl>
			</section>

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

					{stats.temps.length > 0 && (
						<div className="chips">
							{stats.temps.map((temp) => (
								<Pill
									key={temp.name}
									tone={
										temp.celsius > 80
											? "crit"
											: temp.celsius > 65
												? "warn"
												: "idle"
									}
								>
									{temp.name} {Math.round(temp.celsius)}°C
								</Pill>
							))}
						</div>
					)}
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
				{node.capabilities?.docker === false
					? "Docker isn't reachable from this node."
					: "No containers reported."}
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
				This host doesn't run systemd ({telemetry?.facts.init ?? "unknown"}{" "}
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
