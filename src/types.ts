/**
 * Shared wire types between the agent (runs on each server) and the hub
 * (runs on the laptop). Both sides import from here so the HTTP contract
 * stays honest.
 */

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
  /** epoch ms, set by the agent at collection time */
  timestamp: number;
}

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

export interface ServiceInfo {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

export interface ListeningPort {
  proto: string;
  address: string;
  port: number;
  pid: number | null;
  process: string | null;
}

/** Who produced a snapshot. Absent from agents older than 0.1.0. */
export interface AgentIdentity {
  /** the agent's release version, e.g. "0.1.0" */
  version: string;
  /** the wire contract it speaks */
  protocol: number;
}

/** Everything the agent can report in one round trip. */
export interface Snapshot {
  agent?: AgentIdentity;
  stats: SystemStats;
  containers: Container[];
  processes: ProcessInfo[];
  services: ServiceInfo[];
  ports: ListeningPort[];
  /** non-fatal collection errors, keyed by collector name */
  errors: Record<string, string>;
}

export type LogSourceKind = "docker" | "journal" | "file";

export interface LogQuery {
  kind: LogSourceKind;
  /** container id/name, systemd unit, or absolute file path */
  target: string;
  tail: number;
}

export interface LogLine {
  ts: number;
  /** stdout | stderr | unknown */
  stream: string;
  message: string;
}

/* ---------- hub-side types ---------- */

export type ServerDriver = "local" | "agent";

export interface ServerConfig {
  id: string;
  name: string;
  driver: ServerDriver;
  /** agent driver only, e.g. http://10.0.0.5:9101 */
  url?: string;
  /** agent driver only, bearer token shared with that agent */
  token?: string;
  tags?: string[];
  /** free-form notes surfaced in the UI */
  notes?: string;
}

export interface HubConfig {
  port: number;
  host: string;
  pollIntervalMs: number;
  retentionHours: number;
  dbPath: string;
  /** optional bearer token required to talk to the hub itself */
  token: string | null;
  servers: ServerConfig[];
}

export type ServerStatus = "online" | "offline" | "unknown";

export interface ServerState {
  config: Omit<ServerConfig, "token">;
  status: ServerStatus;
  /** epoch ms of the last successful poll */
  lastSeen: number | null;
  /** ms taken by the last poll */
  latencyMs: number | null;
  error: string | null;
  snapshot: Snapshot | null;
}
