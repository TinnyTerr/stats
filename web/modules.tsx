import type React from "react";
import {
	MODULE_LIST,
	type ModuleId,
	moduleOn,
} from "../src/modules/manifest.ts";
import type { NodeSummary } from "../src/types.ts";
import { bytes, duration, pct, rate, usageTone } from "./format.ts";
import {
	ContainersPanel,
	LogsPanel,
	type LogTarget,
	OverviewPanel,
	type PanelProps,
	PortsPanel,
	ProcessesPanel,
	ProjectsPanel,
	ServicesPanel,
} from "./panels.tsx";
import { TerminalPanel } from "./terminal.tsx";
import { Meter, Sparkline, Tile } from "./ui.tsx";

/**
 * The browser half of a module: the tab it puts in the detail pane, and the
 * faces it offers the front block of a node card.
 *
 * Nothing here knows the layout — the card gives a face one fixed slot and the
 * detail pane gives a tab one body, and a module fills whichever it registered
 * for. Adding a capability is a row in this file plus its node-side twin; the
 * dashboard shell doesn't change.
 */

/* ---------- history ---------- */

/**
 * The short series a card draws. Deliberately small: these are glanceable
 * shapes, not charts, and a long tail of points makes the recent minute — the
 * only part anyone reads — impossible to see.
 */
export interface NodeHistory {
	cpu: number[];
	mem: number[];
	net: number[];
	temp: number[];
}

/** How many samples a card sparkline keeps. */
export const HISTORY_POINTS = 30;

/** How far back a fresh page load seeds from the hub's SQLite history. */
export const HISTORY_MINUTES = 10;

export const EMPTY_HISTORY: NodeHistory = {
	cpu: [],
	mem: [],
	net: [],
	temp: [],
};

/* ---------- registry types ---------- */

export interface FaceContext {
	node: NodeSummary;
	history: NodeHistory;
}

/** One thing a card's front block can show. */
export interface CardFace {
	id: string;
	label: string;
	module: ModuleId;
	/** whether this node has anything to put here right now */
	available(ctx: FaceContext): boolean;
	render(ctx: FaceContext): React.ReactNode;
}

export interface ModuleTab {
	id: string;
	label: string;
	render(props: PanelProps): React.ReactNode;
	/** a dot on the tab: something in here wants attention */
	badge?(node: NodeSummary): boolean;
}

export interface UiModule {
	id: ModuleId;
	tab?: ModuleTab;
	faces?: CardFace[];
}

/* ---------- system ---------- */

function worstDisk(node: NodeSummary) {
	return node.disks.length
		? node.disks.reduce(
				(worst, disk) => (disk.usage > worst.usage ? disk : worst),
				node.disks[0]!,
			)
		: null;
}

function hottest(node: NodeSummary) {
	return node.temps.length
		? node.temps.reduce((max, t) => (t.celsius > max.celsius ? t : max))
		: null;
}

const loadFace: CardFace = {
	id: "load",
	label: "Load",
	module: "system",
	available: ({ node }) => node.cpu != null || node.mem != null,
	render: ({ node, history }) => {
		const disk = worstDisk(node);
		const memUsage = node.mem ? node.mem.used / node.mem.total : null;
		const modules = node.capabilities?.modules;

		return (
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
						detail={disk ? `${bytes(disk.available)} free` : undefined}
					/>
				</div>

				<Sparkline points={history.cpu} tone={usageTone(node.cpu)} />

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
					{/* The last two slots follow the node: with docker and projects on
					    their own faces, a node without them shows its own numbers here
					    rather than two dashes. */}
					{moduleOn(modules, "projects") ? (
						<div>
							<dt>Projects</dt>
							<dd>
								{node.projects
									? `${node.projects.running}/${node.projects.total}`
									: "—"}
							</dd>
						</div>
					) : (
						<div>
							<dt>Load</dt>
							<dd>{node.loadavg?.map((n) => n.toFixed(2)).join(" ") ?? "—"}</dd>
						</div>
					)}
					{moduleOn(modules, "docker") ? (
						<div>
							<dt>Containers</dt>
							<dd>
								{node.containers
									? `${node.containers.running}/${node.containers.total}`
									: "—"}
							</dd>
						</div>
					) : (
						<div>
							<dt>Cores</dt>
							<dd>{node.cores ?? "—"}</dd>
						</div>
					)}
				</dl>
			</>
		);
	},
};

const tempsFace: CardFace = {
	id: "temps",
	label: "Temps",
	module: "system",
	available: ({ node }) => node.temps.length > 0,
	render: ({ node, history }) => {
		const sensors = [...node.temps]
			.sort((a, b) => b.celsius - a.celsius)
			.slice(0, 3);
		const top = hottest(node);

		return (
			<>
				<div className="metrics">
					{sensors.map((sensor) => (
						<Meter
							key={sensor.name}
							// 100°C is the scale everything thermal is read against, so the
							// same warn/crit tones as a usage bar land in the right places.
							value={sensor.celsius / 100}
							label={sensor.name}
							detail={`${Math.round(sensor.celsius)}°C`}
							format={(value) => `${Math.round((value ?? 0) * 100)}°`}
						/>
					))}
				</div>

				<Sparkline
					points={history.temp}
					tone={usageTone(top ? top.celsius / 100 : null)}
				/>

				<dl className="facts">
					<div>
						<dt>Hottest</dt>
						<dd>{top ? `${Math.round(top.celsius)}°C ${top.name}` : "—"}</dd>
					</div>
					<div>
						<dt>Sensors</dt>
						<dd>{node.temps.length}</dd>
					</div>
					<div>
						<dt>CPU</dt>
						<dd>{pct(node.cpu)}</dd>
					</div>
					<div>
						<dt>Uptime</dt>
						<dd>{duration(node.uptimeSec)}</dd>
					</div>
				</dl>
			</>
		);
	},
};

const networkFace: CardFace = {
	id: "network",
	label: "Network",
	module: "system",
	available: ({ node }) => node.net != null,
	render: ({ node, history }) => {
		const peak = history.net.length ? Math.max(...history.net) : 0;
		const disk = worstDisk(node);

		return (
			<>
				<div className="metrics">
					<Tile label="Down" value={rate(node.net?.rxRate)} />
					<Tile label="Up" value={rate(node.net?.txRate)} />
					<Tile label="Peak" value={rate(peak || null)} detail="last 10 min" />
				</div>

				<Sparkline points={history.net} tone="info" />

				<dl className="facts">
					<div>
						<dt>CPU</dt>
						<dd>{pct(node.cpu)}</dd>
					</div>
					<div>
						<dt>Memory</dt>
						<dd>{node.mem ? pct(node.mem.used / node.mem.total) : "—"}</dd>
					</div>
					<div>
						<dt>{disk?.mount ?? "Disk"}</dt>
						<dd>{pct(disk?.usage ?? null)}</dd>
					</div>
					<div>
						<dt>Uptime</dt>
						<dd>{duration(node.uptimeSec)}</dd>
					</div>
				</dl>
			</>
		);
	},
};

const storageFace: CardFace = {
	id: "storage",
	label: "Storage",
	module: "system",
	available: ({ node }) => node.disks.length > 0,
	render: ({ node }) => {
		const mounts = [...node.disks]
			.sort((a, b) => b.usage - a.usage)
			.slice(0, 3);
		const total = node.disks.reduce((sum, disk) => sum + disk.total, 0);
		const used = node.disks.reduce((sum, disk) => sum + disk.used, 0);

		return (
			<>
				<div className="metrics">
					{mounts.map((disk) => (
						<Meter
							key={disk.mount}
							value={disk.usage}
							label={disk.mount}
							detail={`${bytes(disk.available)} free`}
						/>
					))}
				</div>

				{/* Disk usage has no series behind it — the hub stores one number per
				    tick and it barely moves — so this band is the fleet-eye version of
				    the same thing rather than a flat line pretending to be a chart. */}
				<Meter
					value={used / (total || 1)}
					label="All mounts"
					detail={`${bytes(total - used)} free of ${bytes(total)}`}
				/>

				<dl className="facts">
					<div>
						<dt>Used</dt>
						<dd>{bytes(used)}</dd>
					</div>
					<div>
						<dt>Capacity</dt>
						<dd>{bytes(total)}</dd>
					</div>
					<div>
						<dt>Mounts</dt>
						<dd>{node.disks.length}</dd>
					</div>
					<div>
						<dt>Memory</dt>
						<dd>{node.mem ? pct(node.mem.used / node.mem.total) : "—"}</dd>
					</div>
				</dl>
			</>
		);
	},
};

/* ---------- the registry ---------- */

export const UI_MODULES: UiModule[] = [
	{
		id: "system",
		tab: {
			id: "overview",
			label: "overview",
			render: (props) => <OverviewPanel {...props} />,
		},
		faces: [loadFace, tempsFace, networkFace, storageFace],
	},

	{
		id: "projects",
		tab: {
			id: "projects",
			label: "projects",
			render: (props) => <ProjectsPanel {...props} />,
			badge: (node) => Boolean(node.projects?.degraded),
		},
		faces: [
			{
				id: "projects",
				label: "Projects",
				module: "projects",
				available: ({ node }) => Boolean(node.projects?.total),
				render: ({ node }) => {
					const projects = node.projects;
					const running = projects?.running ?? 0;
					const total = projects?.total ?? 0;
					return (
						<>
							<div className="metrics">
								<Tile label="Running" value={running} />
								<Tile label="Declared" value={total} />
								<Tile
									label="Degraded"
									value={projects?.degraded ?? 0}
									tone={projects?.degraded ? "crit" : undefined}
								/>
							</div>
							<Meter
								value={total ? running / total : null}
								label="Healthy"
								detail={`${running} of ${total} projects running`}
							/>
							<dl className="facts">
								<div>
									<dt>CPU</dt>
									<dd>{pct(node.cpu)}</dd>
								</div>
								<div>
									<dt>Memory</dt>
									<dd>
										{node.mem ? pct(node.mem.used / node.mem.total) : "—"}
									</dd>
								</div>
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
							</dl>
						</>
					);
				},
			},
		],
	},

	{
		id: "docker",
		tab: {
			id: "containers",
			label: "containers",
			render: (props) => <ContainersPanel {...props} />,
			badge: (node) => Boolean(node.containers?.unhealthy),
		},
		faces: [
			{
				id: "containers",
				label: "Containers",
				module: "docker",
				available: ({ node }) => Boolean(node.containers?.total),
				render: ({ node }) => {
					const containers = node.containers;
					const running = containers?.running ?? 0;
					const total = containers?.total ?? 0;
					return (
						<>
							<div className="metrics">
								<Tile label="Running" value={running} />
								<Tile label="Stopped" value={Math.max(0, total - running)} />
								<Tile
									label="Unhealthy"
									value={containers?.unhealthy ?? 0}
									tone={containers?.unhealthy ? "crit" : undefined}
								/>
							</div>
							<Meter
								value={total ? running / total : null}
								label="Up"
								detail={`${running} of ${total} containers`}
							/>
							<dl className="facts">
								<div>
									<dt>CPU</dt>
									<dd>{pct(node.cpu)}</dd>
								</div>
								<div>
									<dt>Memory</dt>
									<dd>
										{node.mem ? pct(node.mem.used / node.mem.total) : "—"}
									</dd>
								</div>
								<div>
									<dt>Network</dt>
									<dd>
										↓{rate(node.net?.rxRate)} ↑{rate(node.net?.txRate)}
									</dd>
								</div>
								<div>
									<dt>Uptime</dt>
									<dd>{duration(node.uptimeSec)}</dd>
								</div>
							</dl>
						</>
					);
				},
			},
		],
	},

	{
		id: "systemd",
		tab: {
			id: "services",
			label: "services",
			render: (props) => <ServicesPanel {...props} />,
			badge: (node) => Boolean(node.systemd?.failed.length),
		},
		faces: [
			{
				id: "units",
				label: "Units",
				module: "systemd",
				available: ({ node }) => Boolean(node.systemd?.available),
				render: ({ node }) => {
					const systemd = node.systemd;
					const failed = systemd?.failed ?? [];
					return (
						<>
							<div className="metrics">
								<Tile label="Active" value={systemd?.active ?? 0} />
								<Tile label="Loaded" value={systemd?.total ?? 0} />
								<Tile
									label="Failed"
									value={failed.length}
									tone={failed.length ? "crit" : undefined}
								/>
							</div>
							<Meter
								value={systemd?.total ? systemd.active / systemd.total : null}
								label={`systemd ${systemd?.state ?? "unknown"}`}
								detail={
									failed.length
										? failed.slice(0, 2).join(", ")
										: "no failed units"
								}
							/>
							<dl className="facts">
								<div>
									<dt>State</dt>
									<dd>{systemd?.state ?? "—"}</dd>
								</div>
								<div>
									<dt>Version</dt>
									<dd>{systemd?.version ?? "—"}</dd>
								</div>
								<div>
									<dt>CPU</dt>
									<dd>{pct(node.cpu)}</dd>
								</div>
								<div>
									<dt>Uptime</dt>
									<dd>{duration(node.uptimeSec)}</dd>
								</div>
							</dl>
						</>
					);
				},
			},
		],
	},

	{
		id: "processes",
		tab: {
			id: "processes",
			label: "processes",
			render: (props) => <ProcessesPanel {...props} />,
		},
	},

	{
		id: "ports",
		tab: {
			id: "ports",
			label: "ports",
			render: (props) => <PortsPanel {...props} />,
		},
	},

	{
		id: "logs",
		tab: {
			id: "logs",
			label: "logs",
			render: (props) => <LogsPanel {...props} />,
		},
	},

	{
		id: "terminal",
		tab: {
			id: "terminal",
			label: "terminal",
			render: ({ node, telemetry, hub }) => (
				<TerminalPanel node={node} telemetry={telemetry} hub={hub} />
			),
		},
	},
];

/** Manifest order, so tabs and faces appear in the same order everywhere. */
const ORDER = new Map(MODULE_LIST.map((module, i) => [module.id, i]));
const REGISTRY = [...UI_MODULES].sort(
	(a, b) => (ORDER.get(a.id) ?? 99) - (ORDER.get(b.id) ?? 99),
);

/** The tabs this node's modules put in the detail pane. */
export function tabsFor(node: NodeSummary): ModuleTab[] {
	return REGISTRY.filter(
		(module) => module.tab && moduleOn(node.capabilities?.modules, module.id),
	).map((module) => module.tab!);
}

/**
 * The faces this node can show, in module order. A node whose modules are all
 * off still has the load face: the system module can't be turned off, which is
 * what keeps a card from ever being blank.
 */
export function facesFor(ctx: FaceContext): CardFace[] {
	return REGISTRY.filter((module) =>
		moduleOn(ctx.node.capabilities?.modules, module.id),
	)
		.flatMap((module) => module.faces ?? [])
		.filter((face) => face.available(ctx));
}

export type { LogTarget, PanelProps };
