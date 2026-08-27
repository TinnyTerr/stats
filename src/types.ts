/**
 * Everything that crosses the wire. The node (agent), the hub and the browser
 * all import from here, so the protocol payloads stay honest in three places at
 * once.
 */

import type {
	ExternalManifest,
	ModuleHeadline,
	ModuleReport,
} from "./modules/external.ts";
import type { ModuleSet } from "./modules/manifest.ts";

export type {
	ExternalManifest,
	ModuleHeadline,
	ModuleReport,
} from "./modules/external.ts";
export type { ModuleId, ModuleSet } from "./modules/manifest.ts";

/* ---------- host metrics ---------- */

export interface CpuStats {
	/** 0..1 aggregate usage since the previous sample */
	usage: number;
	cores: number;
	/** 0..1 per logical core, same order as /proc/stat */
	perCore: number[];
	model: string | null;
}

export interface MemStats {
	/** all values in bytes */
	total: number;
	used: number;
	free: number;
	available: number;
	buffers: number;
	cached: number;
	swapTotal: number;
	swapUsed: number;
}

export interface DiskMount {
	filesystem: string;
	mount: string;
	total: number;
	used: number;
	available: number;
	/** 0..1 */
	usage: number;
}

export interface NetInterface {
	name: string;
	rxBytes: number;
	txBytes: number;
	/** bytes/sec since previous sample, null on the first sample */
	rxRate: number | null;
	txRate: number | null;
}

export interface TempSensor {
	name: string;
	celsius: number;
}

export interface SystemStats {
	hostname: string;
	platform: string;
	kernel: string;
	uptimeSec: number;
	loadavg: [number, number, number];
	cpu: CpuStats;
	mem: MemStats;
	disks: DiskMount[];
	net: NetInterface[];
	temps: TempSensor[];
	/** epoch ms, set by the node at collection time */
	timestamp: number;
}

/* ---------- host identity ---------- */

/**
 * The only thing a node reports without a module.
 *
 * Everything else on a card — CPU, memory, disks, containers, units — arrives
 * because some module collected it, and a node that loads no modules at all is
 * still a node: it appears in the fleet, it says what it is and where it is,
 * and it can be asked to load something. Hostname and address are what "where
 * is it" means, so they are core and nothing else is.
 *
 * Keeping this deliberately tiny is what makes the platform work possible. A
 * Windows node has no /proc and no `df`, but it has a name and an address, so
 * it can connect and be managed before a single probe is written for it.
 */
export interface HostIdentity {
	hostname: string;
	/** non-loopback addresses, in the order the OS lists its interfaces */
	addresses: string[];
	/** process.platform, or null on something this build has no name for */
	platform: string | null;
	arch: string;
}

/**
 * The slow-moving description of a machine: distro, kernel, virtualisation,
 * init system. Collected once at startup and refreshed hourly rather than on
 * every telemetry tick, and rendered as its own panel in the dashboard.
 */
export interface HostFacts {
	hostname: string;
	/** os-release ID, e.g. debian, ubuntu, fedora, alpine, arch */
	osId: string | null;
	/** os-release ID_LIKE, first entry — lets the UI style derivatives sanely */
	osLike: string | null;
	/** os-release PRETTY_NAME, e.g. "Ubuntu 24.04.1 LTS" */
	osPretty: string | null;
	osName: string | null;
	osVersion: string | null;
	osCodename: string | null;
	/** lsb_release -r, when it disagrees with os-release (Debian testing, etc.) */
	lsbRelease: string | null;
	kernel: string;
	arch: string;
	/** systemd-detect-virt output: kvm, docker, lxc, none, … */
	virtualization: string | null;
	/** systemd | openrc | sysvinit | unknown */
	init: string;
	systemdVersion: string | null;
	/** /etc/machine-id, the stable identity of this install */
	machineId: string | null;
	cpuModel: string | null;
	cpuCores: number;
	memTotal: number;
	/** seconds since boot at the time facts were collected */
	bootedAt: number | null;
	timezone: string | null;
	dockerVersion: string | null;
	/** epoch ms these facts were gathered */
	collectedAt: number;
}

/* ---------- docker ---------- */

export interface ContainerPort {
	ip: string | null;
	privatePort: number;
	publicPort: number | null;
	type: string;
}

export interface Container {
	id: string;
	name: string;
	image: string;
	/** raw docker state: running, exited, paused, restarting, ... */
	state: string;
	/** human string, e.g. "Up 3 days (healthy)" */
	status: string;
	health: string | null;
	createdAt: number;
	ports: ContainerPort[];
	labels: Record<string, string>;
	/** compose project, lifted out of labels for grouping in the UI */
	project: string | null;
	restartCount: number | null;
	cpu: number | null;
	memUsage: number | null;
	memLimit: number | null;
}

/* ---------- processes, systemd, ports ---------- */

export interface ProcessInfo {
	pid: number;
	ppid: number;
	user: string;
	/** 0..1, normalised across all cores */
	cpu: number;
	/** 0..1 of total memory */
	mem: number;
	rssBytes: number;
	elapsedSec: number;
	command: string;
	args: string;
}

/** One systemd unit as `systemctl list-units` reports it. */
export interface SystemdUnit {
	unit: string;
	/** service | timer | socket | target | mount | … derived from the suffix */
	type: string;
	/** loaded | not-found | masked | error */
	load: string;
	/** active | inactive | failed | activating | deactivating */
	active: string;
	/** running | exited | dead | failed | waiting | listening | … */
	sub: string;
	description: string;
}

/** Enough systemd state for a headline without opening the unit list. */
export interface SystemdSummary {
	available: boolean;
	version: string | null;
	/** running | degraded | starting | maintenance | … from `systemctl is-system-running` */
	state: string | null;
	total: number;
	active: number;
	failed: string[];
}

/** `systemctl show` for one unit, for the detail drawer. */
export interface SystemdUnitDetail {
	unit: string;
	description: string | null;
	loadState: string | null;
	activeState: string | null;
	subState: string | null;
	unitFileState: string | null;
	fragmentPath: string | null;
	mainPid: number | null;
	execMainStartTimestamp: string | null;
	activeEnterTimestamp: string | null;
	memoryCurrent: number | null;
	cpuUsageNSec: number | null;
	tasksCurrent: number | null;
	nRestarts: number | null;
	result: string | null;
}

export interface ListeningPort {
	proto: string;
	address: string;
	port: number;
	pid: number | null;
	process: string | null;
}

/* ---------- proxmox ---------- */

/** A VM or container, as `/cluster/resources` reports it. */
export interface ProxmoxGuest {
	/** qemu is a VM, lxc a container — different enough to show in the table */
	type: "qemu" | "lxc";
	vmid: number;
	name: string;
	/** the PVE host it currently runs on; HA can move it between ticks */
	node: string;
	/** running | stopped | paused | unknown */
	status: string;
	/** 0..1 of the guest's own cores, not the host's */
	cpu: number | null;
	cores: number | null;
	memUsed: number | null;
	memMax: number | null;
	diskUsed: number | null;
	diskMax: number | null;
	uptimeSec: number | null;
	/** templates are clone sources, not things that run */
	template: boolean;
	tags: string[];
	/** backup, migrate, snapshot… — why an action would be refused right now */
	lock: string | null;
	/** HA state when the guest is managed by the cluster's resource manager */
	haState: string | null;
}

/** One host in the cluster — or the only one, on a standalone install. */
export interface ProxmoxHost {
	node: string;
	/** online | offline | unknown */
	status: string;
	cpu: number | null;
	cores: number | null;
	memUsed: number | null;
	memMax: number | null;
	diskUsed: number | null;
	diskMax: number | null;
	uptimeSec: number | null;
}

export interface ProxmoxStorage {
	/** the resource id, e.g. "storage/pve/local-lvm" */
	id: string;
	storage: string;
	node: string;
	/** dir | lvmthin | zfspool | cephfs | … */
	type: string;
	status: string;
	used: number | null;
	total: number | null;
}

/** Enough of a Proxmox install for a headline without opening the guest list. */
export interface ProxmoxSummary {
	available: boolean;
	/** how the node reached it: pvesh on the hypervisor, or the HTTPS API */
	via: "pvesh" | "api" | null;
	/** pve-manager version */
	version: string | null;
	/** cluster name, null on a standalone host */
	cluster: string | null;
	hosts: ProxmoxHost[];
	storage: ProxmoxStorage[];
	/** counts exclude templates, which never run and would skew every ratio */
	total: number;
	running: number;
	stopped: number;
	templates: number;
}

/* ---------- projects ---------- */

export type RestartPolicy = "always" | "on-failure" | "never";

export interface HealthCheck {
	type: "http" | "tcp" | "command";
	/** http: absolute URL. */
	url?: string;
	/** tcp: port on localhost, or host:port. */
	port?: number;
	host?: string;
	/** command: argv, run to completion; exit 0 is healthy. */
	command?: string[];
	intervalSec: number;
	timeoutMs: number;
	/** consecutive failures before the process is marked unhealthy */
	failures: number;
	/** grace period after start before failures count */
	startPeriodSec: number;
	/** http only: status codes counted as healthy (default 200-399) */
	expectStatus?: number[];
}

/** A process the node runs and supervises, declared in the projects file. */
export interface ProcessSpec {
	id: string;
	name: string;
	/** argv. A bare string is split by the loader unless `shell` is set. */
	command: string[];
	/** run `command` through `sh -c` instead of exec'ing it directly */
	shell: boolean;
	cwd: string | null;
	env: Record<string, string>;
	/** files of KEY=value lines, loaded before `env` (which wins) */
	envFiles: string[];
	autostart: boolean;
	restart: RestartPolicy;
	restartDelayMs: number;
	/** give up after this many restarts inside restartWindowSec; 0 = never give up */
	maxRestarts: number;
	restartWindowSec: number;
	/** POSIX user/group to drop to. Requires the node to run as root. */
	user: string | null;
	group: string | null;
	stopSignal: string;
	stopTimeoutSec: number;
	/** lines of output kept in memory for the log tail */
	logLines: number;
	healthcheck: HealthCheck | null;
}

/** External things a project owns but does not run, surfaced alongside it. */
export interface ProjectWatch {
	systemd: string[];
	containers: string[];
	ports: number[];
	paths: string[];
}

export interface ProjectSpec {
	id: string;
	name: string;
	description: string | null;
	cwd: string | null;
	env: Record<string, string>;
	envFiles: string[];
	tags: string[];
	/** URL to open from the dashboard, e.g. the app this project serves */
	url: string | null;
	enabled: boolean;
	processes: ProcessSpec[];
	watch: ProjectWatch;
}

export type ProcessState =
	| "stopped"
	| "starting"
	| "running"
	| "stopping"
	| "restarting"
	| "exited"
	| "crashed"
	| "fatal";

export type HealthState = "unknown" | "starting" | "healthy" | "unhealthy";

export interface ProcessStatus {
	id: string;
	name: string;
	projectId: string;
	state: ProcessState;
	health: HealthState;
	/** why health is what it is, e.g. "connect ECONNREFUSED" */
	healthDetail: string | null;
	pid: number | null;
	/** epoch ms of the current run's start */
	startedAt: number | null;
	uptimeSec: number | null;
	restarts: number;
	/** exit code / signal of the last run that ended */
	lastExitCode: number | null;
	lastExitSignal: string | null;
	lastExitAt: number | null;
	/** why the supervisor gave up, when state is "fatal" */
	error: string | null;
	/** 0..1 across all cores, null until two samples exist */
	cpu: number | null;
	rssBytes: number | null;
	command: string;
	autostart: boolean;
	restartPolicy: RestartPolicy;
}

export interface ProjectStatus {
	id: string;
	name: string;
	description: string | null;
	tags: string[];
	url: string | null;
	enabled: boolean;
	processes: ProcessStatus[];
	watch: ProjectWatch;
	/** worst state across the project's processes, for the card badge */
	summary: "running" | "degraded" | "stopped" | "empty";
}

/* ---------- telemetry ---------- */

/** Who produced a telemetry frame. */
export interface NodeIdentity {
	id: string;
	name: string;
	version: string;
	protocol: number;
}

/**
 * What a node will let the hub do to it: the modules it loaded, plus the one
 * switch that cuts across all of them. Both are decided on the node — the hub
 * can only narrow what a node offers, never widen it.
 */
export interface NodeCapabilities {
	/** module id → loaded here, after the hub narrowed it. See src/modules/. */
	modules: ModuleSet;
	/** start/stop/restart projects, units and containers */
	control: boolean;
	/**
	 * Manifests for the modules this node installed from a git repository. The
	 * dashboard has no code for these — it draws the tab and the card face from
	 * what the manifest declares, which is why the declaration travels with the
	 * capabilities rather than being compiled into the browser bundle.
	 */
	externals?: ExternalManifest[];
	/**
	 * Whether this node will let the hub turn a module *on*. On by default for a
	 * root node and off for any other, exactly like `allowRemoteUpdate`: the hub
	 * can always take a module away, and this is the switch for the other
	 * direction. See src/hub/modules.ts for why the two directions aren't the
	 * same decision.
	 */
	acceptsHubModules?: boolean;
}

/** One tick of everything a node reports. */
export interface Telemetry {
	node: NodeIdentity;
	/** monotonically increasing per connection, so gaps are visible */
	seq: number;
	/** the core's own report — always present, never from a module */
	host: HostIdentity;
	/** from the `system` module; absent when no probe serves this platform */
	stats?: SystemStats;
	/** from the `system` module */
	facts?: HostFacts;
	systemd: SystemdSummary;
	containers: Container[];
	processes: ProcessInfo[];
	units: SystemdUnit[];
	ports: ListeningPort[];
	projects: ProjectStatus[];
	proxmox: ProxmoxSummary;
	guests: ProxmoxGuest[];
	/** what each installed module reported this tick, keyed by module id */
	extras: Record<string, ModuleReport>;
	/** non-fatal collection errors, keyed by collector name */
	errors: Record<string, string>;
}

/* ---------- logs ---------- */

export type LogSourceKind = "docker" | "journal" | "file" | "project";

export interface LogQuery {
	kind: LogSourceKind;
	/** container id/name, systemd unit, absolute file path, or project/process id */
	target: string;
	tail: number;
	follow: boolean;
}

export interface LogLine {
	ts: number;
	/** stdout | stderr | unknown */
	stream: string;
	message: string;
}

/* ---------- hub-side ---------- */

export type NodeStatus = "online" | "offline";

/** Optional per-node overrides the hub applies to whatever a node reports. */
export interface NodeOverride {
	id: string;
	name?: string;
	tags?: string[];
	notes?: string;
	/** a node-specific token; when set, only this token admits this id */
	token?: string;
}

export interface HubConfig {
	port: number;
	host: string;
	/** bearer token the dashboard must present, null for open */
	token: string | null;
	/** token nodes must present in Hello, null for open (development only) */
	nodeToken: string | null;
	/** accept nodes with ids that aren't listed in `nodes` */
	allowUnknownNodes: boolean;
	dbPath: string;
	retentionHours: number;
	/** how often nodes should send telemetry; handed to them in Welcome */
	telemetryIntervalMs: number;
	/** a node is declared offline this long after its last frame */
	nodeTimeoutMs: number;
	/**
	 * Fleet-wide module switches. Only ever subtractive: setting `docker: false`
	 * hides docker everywhere, but setting it true can't give it to a node that
	 * didn't load the module.
	 */
	modules: ModuleSet;
	/** run a node in-process so the hub machine watches itself */
	embeddedNode: boolean;
	nodes: NodeOverride[];
	/** mirror projects into a Notion database, null when not configured */
	notion: NotionConfig | null;
}

/**
 * Outbound mirror of the fleet's projects into a Notion database. Read-only by
 * design: the node's projects file stays the source of truth, so nothing set
 * in Notion can change what a node runs.
 */
export interface NotionConfig {
	enabled: boolean;
	/** Notion internal integration secret */
	token: string | null;
	/** the database id to write rows into */
	database: string | null;
	/** how often to push, floored at 15s to stay well inside Notion's limits */
	intervalMs: number;
	/** archive rows whose project no longer exists anywhere in the fleet */
	archiveStale: boolean;
	/** override the Notion property name used for a column */
	properties?: Partial<Record<string, string>>;
}

/** The list-view shape the dashboard renders, one per known node. */
export interface NodeSummary {
	id: string;
	name: string;
	status: NodeStatus;
	tags: string[];
	notes: string | null;
	/** epoch ms of the last frame from this node */
	lastSeen: number | null;
	connectedAt: number | null;
	/** round-trip of the last Ping, ms */
	latencyMs: number | null;
	remoteAddress: string | null;
	version: string | null;
	protocol: number | null;
	capabilities: NodeCapabilities | null;
	hostname: string | null;
	/** non-loopback addresses, from the node's core identity */
	addresses: string[];
	/** process.platform of the node — what its modules had to support */
	platform: string | null;
	/** from the `system` module; null when this platform has no probe */
	facts: HostFacts | null;
	uptimeSec: number | null;
	cpu: number | null;
	cores: number | null;
	loadavg: [number, number, number] | null;
	mem: { used: number; total: number } | null;
	disks: DiskMount[];
	temps: TempSensor[];
	net: { rxRate: number; txRate: number } | null;
	containers: { total: number; running: number; unhealthy: number } | null;
	systemd: SystemdSummary | null;
	projects: { total: number; running: number; degraded: number } | null;
	proxmox: ProxmoxSummary | null;
	/** installed modules' scalars — the rows stay in telemetry, see ModuleHeadline */
	extras: Record<string, ModuleHeadline>;
	collectorErrors: Record<string, string>;
}
