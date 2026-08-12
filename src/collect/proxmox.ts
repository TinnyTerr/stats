import { $ } from "bun";
import type { CommandResult, ProxmoxVerb } from "../proto/messages.ts";
import type {
	ProxmoxGuest,
	ProxmoxHost,
	ProxmoxStorage,
	ProxmoxSummary,
} from "../types.ts";

/**
 * Proxmox VE, read the way the host itself reads it.
 *
 * Two transports answer the same API. On a PVE host `pvesh` is already
 * authenticated as root@pam over the local socket, so the common case — the node
 * runs on the hypervisor — needs no credentials at all. Anywhere else, an API
 * token against https://host:8006 gets the same JSON, which is why everything
 * below is written against `/cluster/resources` and `/nodes/...` rather than
 * against either transport.
 */

const API_PATH = "/api2/json";

/** Where the HTTPS transport points, when one is configured. */
export const PROXMOX_URL = process.env.PROXMOX_URL ?? null;
/** `user@realm!tokenid=uuid`, as `pveum user token add` prints it. */
export const PROXMOX_TOKEN = process.env.PROXMOX_TOKEN ?? null;

export class ProxmoxUnavailable extends Error {}

export interface ExecLike {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * The two things this collector reaches for. The module hands in the gated
 * versions from its {@link ModuleHost}; passing null restores the direct ones,
 * which is what the tests use.
 */
export interface ProxmoxTransport {
	exec(argv: string[]): Promise<ExecLike>;
	fetch(url: string, init?: RequestInit): Promise<Response>;
}

const directTransport: ProxmoxTransport = {
	async exec(argv) {
		const out = await $`${argv}`.nothrow().quiet();
		return {
			code: out.exitCode,
			stdout: out.stdout.toString(),
			stderr: out.stderr.toString(),
		};
	},
	fetch: (url, init) => fetch(url, init),
};

let transport = directTransport;

export function useProxmoxTransport(next: ProxmoxTransport | null) {
	transport = next ?? directTransport;
}

/* ---------- reaching the API ---------- */

/**
 * `/etc/pve` is mounted by pmxcfs and only exists on a PVE host, so its presence
 * is the test for "this machine is the hypervisor". It's a fuse mount rather
 * than a regular file, hence the stat.
 */
async function isPveHost(): Promise<boolean> {
	const stat = await Bun.file("/etc/pve")
		.stat()
		.catch(() => null);
	return stat?.isDirectory() ?? false;
}

export type ProxmoxVia = "pvesh" | "api";

/** How this node will talk to Proxmox, or null when it can't. */
export async function proxmoxVia(): Promise<ProxmoxVia | null> {
	if (await isPveHost()) return "pvesh";
	if (PROXMOX_URL && PROXMOX_TOKEN) return "api";
	return null;
}

export async function proxmoxAvailable(): Promise<boolean> {
	return (await proxmoxVia()) !== null;
}

/**
 * Proxmox ships a self-signed certificate by default, so an operator pointing a
 * node at a stock install has to say out loud that they accept it. Refusing
 * quietly would be worse than either: the error lands in telemetry.errors and
 * says exactly which variable to set.
 */
const insecure = /^(1|true|yes|on)$/i.test(process.env.PROXMOX_INSECURE ?? "");

function apiRequest(path: string, init?: RequestInit): Promise<Response> {
	const base = (PROXMOX_URL ?? "").replace(/\/+$/, "");
	return transport.fetch(`${base}${API_PATH}${path}`, {
		...init,
		headers: {
			Authorization: `PVEAPIToken=${PROXMOX_TOKEN}`,
			...(init?.headers ?? {}),
		},
		// Bun's fetch takes TLS options inline; RequestInit doesn't describe them.
		...(insecure ? { tls: { rejectUnauthorized: false } } : {}),
	} as RequestInit);
}

function tlsHint(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (/certificate|self.signed|SSL|TLS/i.test(message) && !insecure) {
		return `${message} — Proxmox's default certificate is self-signed; set PROXMOX_INSECURE=1 to accept it`;
	}
	return message;
}

/**
 * One GET against whichever transport is in play. Both return the same shape:
 * pvesh prints the contents of the API's `data` key, the HTTP API wraps it.
 */
async function get<T>(path: string, via: ProxmoxVia): Promise<T> {
	if (via === "pvesh") {
		const out = await transport.exec([
			"pvesh",
			"get",
			path,
			"--output-format",
			"json",
		]);
		if (out.code !== 0) {
			throw new ProxmoxUnavailable(
				out.stderr.trim() || `pvesh get ${path} exited ${out.code}`,
			);
		}
		try {
			return JSON.parse(out.stdout) as T;
		} catch {
			throw new ProxmoxUnavailable(`pvesh get ${path} did not return JSON`);
		}
	}

	let res: Response;
	try {
		res = await apiRequest(path);
	} catch (err) {
		throw new ProxmoxUnavailable(`${PROXMOX_URL} unreachable: ${tlsHint(err)}`);
	}
	if (!res.ok) {
		throw new ProxmoxUnavailable(
			`GET ${path} returned ${res.status} ${res.statusText}`,
		);
	}
	const body = (await res.json()) as { data: T };
	return body.data;
}

/* ---------- shaping what comes back ---------- */

/** `/cluster/resources` is one flat list of every kind of thing PVE knows about. */
interface RawResource {
	type: string;
	id: string;
	node?: string;
	status?: string;
	name?: string;
	vmid?: number;
	cpu?: number;
	maxcpu?: number;
	mem?: number;
	maxmem?: number;
	disk?: number;
	maxdisk?: number;
	uptime?: number;
	template?: number;
	tags?: string;
	lock?: string;
	storage?: string;
	plugintype?: string;
	hastate?: string;
}

function num(value: number | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function guestFrom(raw: RawResource): ProxmoxGuest {
	return {
		type: raw.type === "lxc" ? "lxc" : "qemu",
		vmid: raw.vmid ?? 0,
		name: raw.name ?? `${raw.type}/${raw.vmid ?? "?"}`,
		node: raw.node ?? "",
		status: raw.status ?? "unknown",
		// PVE reports cpu as a 0..1 fraction of the guest's assigned cores already.
		cpu: num(raw.cpu),
		cores: num(raw.maxcpu),
		memUsed: num(raw.mem),
		memMax: num(raw.maxmem),
		diskUsed: num(raw.disk),
		diskMax: num(raw.maxdisk),
		uptimeSec: num(raw.uptime),
		template: raw.template === 1,
		tags: (raw.tags ?? "")
			.split(/[;,\s]+/)
			.map((tag) => tag.trim())
			.filter(Boolean),
		// A lock is why an action would be refused, and `hastate` is why a guest
		// might move; both are the answer to "why isn't this doing what I asked".
		lock: raw.lock ?? null,
		haState: raw.hastate ?? null,
	};
}

function hostFrom(raw: RawResource): ProxmoxHost {
	return {
		node: raw.node ?? raw.id.replace(/^node\//, ""),
		status: raw.status ?? "unknown",
		cpu: num(raw.cpu),
		cores: num(raw.maxcpu),
		memUsed: num(raw.mem),
		memMax: num(raw.maxmem),
		diskUsed: num(raw.disk),
		diskMax: num(raw.maxdisk),
		uptimeSec: num(raw.uptime),
	};
}

function storageFrom(raw: RawResource): ProxmoxStorage {
	return {
		id: raw.id,
		storage: raw.storage ?? raw.id.split("/").pop() ?? raw.id,
		node: raw.node ?? "",
		type: raw.plugintype ?? "unknown",
		status: raw.status ?? "unknown",
		used: num(raw.disk),
		total: num(raw.maxdisk),
	};
}

/** Guests sort the way you'd triage them: stopped first, then by vmid. */
function guestRank(guest: ProxmoxGuest): number {
	if (guest.template) return 3;
	if (guest.status === "running") return 2;
	if (guest.status === "paused") return 1;
	return 0;
}

export function shapeResources(raw: RawResource[]): {
	guests: ProxmoxGuest[];
	hosts: ProxmoxHost[];
	storage: ProxmoxStorage[];
} {
	const guests: ProxmoxGuest[] = [];
	const hosts: ProxmoxHost[] = [];
	const storage: ProxmoxStorage[] = [];

	for (const item of raw) {
		if (item.type === "qemu" || item.type === "lxc")
			guests.push(guestFrom(item));
		else if (item.type === "node") hosts.push(hostFrom(item));
		else if (item.type === "storage") storage.push(storageFrom(item));
	}

	guests.sort((a, b) => guestRank(a) - guestRank(b) || a.vmid - b.vmid);
	hosts.sort((a, b) => a.node.localeCompare(b.node));
	storage.sort((a, b) => a.id.localeCompare(b.id));
	return { guests, hosts, storage };
}

/**
 * The version endpoint is the cheapest proof the transport works, and it's the
 * only place the pve-manager version is stated. A cluster name only exists when
 * the host is actually in one, so a standalone box reports null rather than
 * inventing a cluster of one.
 */
async function identify(
	via: ProxmoxVia,
): Promise<{ version: string | null; cluster: string | null }> {
	const version = await get<{ version?: string; release?: string }>(
		"/version",
		via,
	).catch(() => null);

	const cluster = await get<{ type: string; name?: string }[]>(
		"/cluster/status",
		via,
	).catch(() => null);

	return {
		version: version?.version ?? version?.release ?? null,
		cluster: cluster?.find((entry) => entry.type === "cluster")?.name ?? null,
	};
}

const EMPTY: ProxmoxSummary = {
	available: false,
	via: null,
	version: null,
	cluster: null,
	hosts: [],
	storage: [],
	total: 0,
	running: 0,
	stopped: 0,
	templates: 0,
};

export function emptyProxmoxSummary(): ProxmoxSummary {
	return { ...EMPTY, hosts: [], storage: [] };
}

export async function collectProxmox(): Promise<{
	proxmox: ProxmoxSummary;
	guests: ProxmoxGuest[];
}> {
	const via = await proxmoxVia();
	if (!via) return { proxmox: emptyProxmoxSummary(), guests: [] };
	return await collectProxmoxVia(via);
}

/** The collection itself, with the transport choice already made. */
export async function collectProxmoxVia(via: ProxmoxVia): Promise<{
	proxmox: ProxmoxSummary;
	guests: ProxmoxGuest[];
}> {
	const resources = await get<RawResource[]>("/cluster/resources", via);
	const { guests, hosts, storage } = shapeResources(resources ?? []);
	const { version, cluster } = await identify(via);

	const real = guests.filter((guest) => !guest.template);
	return {
		proxmox: {
			available: true,
			via,
			version,
			cluster,
			hosts,
			storage,
			total: real.length,
			running: real.filter((guest) => guest.status === "running").length,
			stopped: real.filter((guest) => guest.status !== "running").length,
			templates: guests.length - real.length,
		},
		guests,
	};
}

/* ---------- control ---------- */

const VERBS: ProxmoxVerb[] = [
	"start",
	"stop",
	"shutdown",
	"reboot",
	"suspend",
	"resume",
];

/** Keeps a node or storage name from turning into extra path segments. */
export function isValidPveName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name);
}

/**
 * start/stop and friends are POSTs to the guest's status endpoint. `stop` pulls
 * the plug and `shutdown` asks the guest politely — the dashboard offers both
 * and says which is which, because on a VM the difference is a filesystem.
 */
export async function guestAction(
	params: {
		node: string;
		vmid: number;
		type: "qemu" | "lxc";
		verb: ProxmoxVerb;
	},
	/** the transport to use; resolved from the host when the caller doesn't say */
	forced?: ProxmoxVia,
): Promise<CommandResult> {
	const { node, vmid, type, verb } = params;
	if (!VERBS.includes(verb)) throw new Error(`unknown verb '${verb}'`);
	if (!isValidPveName(node)) throw new Error(`invalid node name '${node}'`);
	if (!Number.isInteger(vmid) || vmid <= 0)
		throw new Error(`invalid vmid '${vmid}'`);
	if (type !== "qemu" && type !== "lxc")
		throw new Error(`unknown guest type '${type}'`);

	const via = forced ?? (await proxmoxVia());
	if (!via) throw new ProxmoxUnavailable("this node cannot reach Proxmox");

	const path = `/nodes/${node}/${type}/${vmid}/status/${verb}`;

	if (via === "pvesh") {
		const out = await transport.exec(["pvesh", "create", path]);
		const output = `${out.stdout}${out.stderr}`.trim();
		return {
			ok: out.code === 0,
			output:
				output ||
				(out.code === 0 ? `${verb} ${type}/${vmid}: ok` : `exit ${out.code}`),
		};
	}

	let res: Response;
	try {
		res = await apiRequest(path, { method: "POST" });
	} catch (err) {
		throw new ProxmoxUnavailable(`${PROXMOX_URL} unreachable: ${tlsHint(err)}`);
	}
	const body = (await res.text()).trim();
	return {
		ok: res.ok,
		// A task id is what a successful POST returns, and it's what you'd paste
		// into `pvesh get /nodes/x/tasks/<id>/status` to find out what happened.
		output: body || `${res.status} ${res.statusText}`,
	};
}
