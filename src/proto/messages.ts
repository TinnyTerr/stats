/**
 * Payload shapes for every frame type, and the control actions both links
 * understand.
 *
 * Two links speak this protocol:
 *   node ⇄ hub      — the node dials out, says Hello, then streams Telemetry
 *   browser ⇄ hub   — the same framing; the hub answers what it can locally and
 *                     relays the rest, verbatim, to the node named by `nodeId`
 */

import type {
	Container,
	HostFacts,
	ListeningPort,
	LogLine,
	LogQuery,
	NodeCapabilities,
	NodeIdentity,
	NodeSummary,
	ProcessInfo,
	ProjectSpec,
	ProjectStatus,
	SystemdSummary,
	SystemdUnit,
	SystemdUnitDetail,
	SystemStats,
	Telemetry,
} from "../types.ts";

/* ---------- handshake ---------- */

export interface HelloPayload {
	node: NodeIdentity;
	/** shared secret, checked against the hub's nodeToken */
	token: string | null;
	capabilities: NodeCapabilities;
	facts: HostFacts;
	/** epoch ms the node process started */
	startedAt: number;
}

export interface WelcomePayload {
	hub: { version: string; protocol: number };
	/** the name the hub decided on — its override wins over the node's own */
	name: string;
	/** how often to send Telemetry from here on */
	telemetryIntervalMs: number;
	/** the hub's own switch; a node still refuses if its capability is off */
	terminal: boolean;
	/** epoch ms on the hub, so a node can flag a badly skewed clock */
	time: number;
}

export interface ErrorPayload {
	/** stable, machine-readable: unauthorized, unknown_node, bad_request, … */
	code: string;
	message: string;
}

/* ---------- control ---------- */

export interface ControlRequest<P = unknown> {
	action: string;
	params?: P;
}

export interface ControlResponse<R = unknown> {
	result: R;
}

/** Actions a hub sends to a node. */
export const NodeAction = {
	Snapshot: "snapshot",
	FactsRefresh: "facts.refresh",
	LogsTail: "logs.tail",
	TerminalOpen: "terminal.open",
	TerminalResize: "terminal.resize",
	TerminalClose: "terminal.close",
	UnitShow: "unit.show",
	UnitAction: "unit.action",
	ContainerAction: "container.action",
	ProjectsList: "projects.list",
	ProjectsReload: "projects.reload",
	ProjectAction: "project.action",
} as const;

/** Actions the browser sends to the hub. Anything else is relayed to a node. */
export const HubAction = {
	Nodes: "nodes",
	Node: "node",
	History: "history",
	Events: "events",
	Info: "info",
	Forget: "node.forget",
} as const;

export interface NodeScoped {
	/** which node the hub should relay this to */
	nodeId: string;
}

export interface LogsTailParams extends Partial<NodeScoped>, LogQuery {}

export interface TerminalOpenParams extends Partial<NodeScoped> {
	cols: number;
	rows: number;
	/** login shell by default */
	shell?: string;
	cwd?: string;
	/** run inside a project's working directory and environment */
	projectId?: string;
	/** exec into a container instead of the host */
	container?: string;
}

export interface TerminalOpenResult {
	sessionId: string;
	pid: number;
	shell: string;
}

export interface TerminalResizeParams extends Partial<NodeScoped> {
	sessionId: string;
	cols: number;
	rows: number;
}

export interface TerminalCloseParams extends Partial<NodeScoped> {
	sessionId: string;
}

export interface UnitShowParams extends Partial<NodeScoped> {
	unit: string;
}

export type UnitVerb = "start" | "stop" | "restart" | "reload";

export interface UnitActionParams extends Partial<NodeScoped> {
	unit: string;
	verb: UnitVerb;
}

export type ContainerVerb = "start" | "stop" | "restart";

export interface ContainerActionParams extends Partial<NodeScoped> {
	container: string;
	verb: ContainerVerb;
}

export type ProjectVerb = "start" | "stop" | "restart";

export interface ProjectActionParams extends Partial<NodeScoped> {
	projectId: string;
	/** omit to act on every process in the project */
	processId?: string;
	verb: ProjectVerb;
}

export interface CommandResult {
	ok: boolean;
	/** combined output, trimmed — enough to explain a failure in the UI */
	output: string;
}

export interface SnapshotResult {
	stats: SystemStats;
	facts: HostFacts;
	systemd: SystemdSummary;
	units: SystemdUnit[];
	containers: Container[];
	processes: ProcessInfo[];
	ports: ListeningPort[];
	projects: ProjectStatus[];
	errors: Record<string, string>;
}

export interface ProjectsListResult {
	/** where the node loaded them from, for the "edit this file" hint */
	sources: string[];
	projects: ProjectSpec[];
	/** validation problems that kept a project out of the list */
	errors: string[];
}

export interface HistoryParams {
	nodeId: string;
	minutes?: number;
}

export interface EventsParams {
	minutes?: number;
	nodeId?: string;
}

export interface HubInfoResult {
	version: string;
	protocol: number;
	/** the hub's own switch for terminals */
	terminal: boolean;
	nodes: number;
	time: number;
}

/* ---------- what the hub pushes to browsers ---------- */

export const HubEvent = {
	/** full list, sent on connect */
	Nodes: "nodes",
	/** one node's summary changed */
	Node: "node",
	/** a node connected or dropped */
	Status: "status",
	/** something happened worth a toast: project crashed, unit failed */
	Alert: "alert",
} as const;

export interface NodesEvent {
	event: typeof HubEvent.Nodes;
	nodes: NodeSummary[];
}

export interface NodeEvent {
	event: typeof HubEvent.Node;
	node: NodeSummary;
}

export interface StatusEvent {
	event: typeof HubEvent.Status;
	nodeId: string;
	status: "online" | "offline";
	message: string;
	ts: number;
}

export interface AlertEvent {
	event: typeof HubEvent.Alert;
	nodeId: string;
	kind: string;
	message: string;
	ts: number;
}

export type HubPush = NodesEvent | NodeEvent | StatusEvent | AlertEvent;

/** Telemetry as it reaches the browser: the node's frame plus who sent it. */
export interface TelemetryPush {
	event: "telemetry";
	telemetry: Telemetry;
}

export type { LogLine, SystemdUnitDetail, Telemetry };
