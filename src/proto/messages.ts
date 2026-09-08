/**
 * Payload shapes for every frame type, and the control actions both links
 * understand.
 *
 * Two links speak this protocol:
 *   node ⇄ hub      — the node dials out, says Hello, then streams Telemetry
 *   browser ⇄ hub   — the same framing; the hub answers what it can locally and
 *                     relays the rest, verbatim, to the node named by `nodeId`
 */

import type { NodeModuleView } from "../hub/modules.ts";
import type { ModuleSet } from "../modules/manifest.ts";
import type {
	CaStatus,
	Container,
	ExternalManifest,
	HostFacts,
	HostIdentity,
	ListeningPort,
	LogLine,
	LogQuery,
	ModuleReport,
	NodeCapabilities,
	NodeIdentity,
	NodeSummary,
	PiholeDetail,
	PiholeSummary,
	ProcessInfo,
	ProjectSpec,
	ProjectStatus,
	ProxmoxGuest,
	ProxmoxSummary,
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
	/**
	 * Name, addresses and platform. Present before any module has run, which is
	 * what lets the hub's module page know what a node *could* load — a Windows
	 * node that loaded nothing is still a node the hub can offer modules to.
	 */
	host: HostIdentity;
	/** from the `system` module; absent when this platform has no probe */
	facts?: HostFacts;
	/** epoch ms the node process started */
	startedAt: number;
}

export interface WelcomePayload {
	hub: { version: string; protocol: number };
	/** the name the hub decided on — its override wins over the node's own */
	name: string;
	/** how often to send Telemetry from here on */
	telemetryIntervalMs: number;
	/**
	 * The modules the hub is willing to see. Only ever subtractive — a node that
	 * didn't load one doesn't get it back by being told it's allowed.
	 */
	modules: ModuleSet;
	/** epoch ms on the hub, so a node can flag a badly skewed clock */
	time: number;
	/**
	 * The fleet's local CA, public half only — absent when the hub has none or
	 * the `ca` module is switched off. Not a request in the way `modules` is:
	 * the `ca` module still decides for itself whether to trust it, same as
	 * every other module decides whether to load at all. See src/hub/ca.ts.
	 */
	ca?: { pem: string; fingerprint: string };
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
	Modules: "modules",
	UpdateCheck: "update.check",
	UpdateApply: "update.apply",
	FactsRefresh: "facts.refresh",
	LogsTail: "logs.tail",
	TerminalOpen: "terminal.open",
	TerminalResize: "terminal.resize",
	TerminalClose: "terminal.close",
	UnitShow: "unit.show",
	UnitAction: "unit.action",
	ContainerAction: "container.action",
	GuestAction: "guest.action",
	PiholeBlocking: "pihole.blocking",
	ProjectsList: "projects.list",
	ProjectsReload: "projects.reload",
	ProjectAction: "project.action",
	/** the hub telling a node which modules it should be running */
	ModulesApply: "modules.apply",
} as const;

/** Actions the browser sends to the hub. Anything else is relayed to a node. */
export const HubAction = {
	Nodes: "nodes",
	Node: "node",
	History: "history",
	Events: "events",
	Info: "info",
	Forget: "node.forget",
	/** the fleet's module state, for the hub's module page */
	Modules: "modules.fleet",
	/** record the hub's intent for one node's modules */
	ModulesSet: "modules.set",
	/** a one-off leaf cert signed by the fleet CA */
	CaIssue: "ca.issue",
} as const;

export interface CaIssueParams {
	commonName: string;
	sans?: string[];
	days?: number;
}

export interface CaIssueResult {
	cert: string;
	key: string;
	caCert: string;
}

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

/**
 * `stop` cuts the power and `shutdown` asks the guest to go quietly — on a VM
 * that difference is a filesystem, so both are offered rather than one being
 * chosen for the operator.
 */
export type ProxmoxVerb =
	| "start"
	| "stop"
	| "shutdown"
	| "reboot"
	| "suspend"
	| "resume";

export interface ProxmoxActionParams extends Partial<NodeScoped> {
	/** the PVE host the guest is on — telemetry says which */
	node: string;
	vmid: number;
	type: "qemu" | "lxc";
	verb: ProxmoxVerb;
}

/**
 * Blocking on, or off for a while. The timer is the point of doing this from a
 * dashboard rather than from the Pi-hole itself: blocking that switches itself
 * back on can't be left off by whoever was debugging at the time.
 */
export interface PiholeBlockingParams extends Partial<NodeScoped> {
	blocking: boolean;
	/** seconds until blocking returns; omitted or 0 means indefinitely */
	seconds?: number | null;
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
	/** the core's report; the only field here that is never a module's */
	host: HostIdentity;
	stats?: SystemStats;
	facts?: HostFacts;
	systemd: SystemdSummary;
	units: SystemdUnit[];
	containers: Container[];
	processes: ProcessInfo[];
	ports: ListeningPort[];
	projects: ProjectStatus[];
	proxmox: ProxmoxSummary;
	guests: ProxmoxGuest[];
	pihole?: PiholeSummary;
	piholeDetail?: PiholeDetail;
	ca?: CaStatus;
	extras: Record<string, ModuleReport>;
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
	/**
	 * Ask for the window averaged into this many even slots instead of raw
	 * samples. A day of three-second ticks is thirty thousand rows and no chart
	 * draws that, so anything asking for a long window asks for buckets; omitting
	 * it keeps the exact samples, most recent first-capped.
	 */
	buckets?: number;
}

export interface EventsParams {
	minutes?: number;
	nodeId?: string;
}

export interface HubInfoResult {
	version: string;
	protocol: number;
	/** the hub's fleet-wide module switches */
	modules: ModuleSet;
	nodes: number;
	time: number;
}

/**
 * Asking a node to update itself.
 *
 * There is deliberately no URL here. The node resolves the release from the
 * forge *it* is configured to trust and checks it against that release's
 * published checksums, so the worst a compromised hub can do is ask for an
 * update the node was already willing to install. A node without
 * `allowRemoteUpdate` — the default for anything not running as root — refuses
 * outright.
 */
export interface UpdateApplyParams extends Partial<NodeScoped> {
	/** a release tag; the node's own idea of "latest" when omitted */
	version?: string;
	/** swap the binary but leave the service running the old one */
	restart?: boolean;
}

export interface UpdateCheckResult {
	current: string;
	latest: string;
	behind: boolean;
	/** the build this host would install */
	asset: string;
	/** whether this node accepts update.apply at all */
	allowed: boolean;
}

export interface UpdateApplyResult {
	from: string;
	to: string;
	/** the unit about to be restarted, null when not running under systemd */
	unit: string | null;
	restarting: boolean;
}

/* ---------- managing modules from the hub ---------- */

export interface ModulesFleetParams {
	/** just this node; the whole fleet when omitted */
	nodeId?: string;
}

export interface ModulesFleetResult {
	nodes: NodeModuleView[];
	/** hub.json's fleet-wide switches, which no node can override */
	fleet: ModuleSet;
}

export interface ModulesSetParams {
	nodeId: string;
	/**
	 * Module id → wanted. Partial: a module not named keeps whatever the hub
	 * already thought, so two operators toggling different rows don't overwrite
	 * each other. Pass null to drop the hub's opinion entirely.
	 */
	modules: Record<string, boolean | null>;
}

export interface ModulesSetResult {
	nodeId: string;
	/** the node's rows after the change, resolved the same way the page reads them */
	modules: NodeModuleView["modules"];
	/**
	 * True when the node was online and took the new set. False means the intent
	 * is recorded and will be applied at its next Hello — which is the normal
	 * path for a node that is offline right now.
	 */
	applied: boolean;
	/** set when the node is online but refuses hub-directed modules */
	refused?: string;
}

/**
 * The hub asking a node to run a particular set.
 *
 * A node without `allowHubModules` — the default for anything not running as
 * root — answers this with its own set unchanged and `accepted: false`, rather
 * than an error: the hub is allowed to ask, and "no" is a complete answer that
 * the module page can render.
 */
export interface ModulesApplyParams extends Partial<NodeScoped> {
	modules: ModuleSet;
}

export interface ModulesApplyResult {
	accepted: boolean;
	/** what the node is running now */
	modules: ModuleSet;
	/** why not, when accepted is false */
	reason?: string;
	/** true when the new set only takes effect after the node reconnects */
	restartRequired: boolean;
}

/** What a node reports about its own module set, on request. */
export interface ModulesResult {
	modules: ModuleSet;
	control: boolean;
	/** why a module isn't loaded: disabled, denied by policy, or unavailable */
	notes: string[];
	/** manifests for the ones it installed rather than shipped with */
	externals?: ExternalManifest[];
	/** whether this node lets the hub decide its module set */
	acceptsHubModules?: boolean;
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
