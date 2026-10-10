import os from "node:os";
import { $ } from "bun";
import type {
	CpuStats,
	DiskMount,
	HostFacts,
	MemStats,
	NetInterface,
	SystemStats,
} from "../../types.ts";
import { DOCKER_SOCKET } from "../docker.ts";
import type { SystemProbe } from "../probe.ts";

/**
 * The macOS probe: `sysctl`, `vm_stat`, `df`, `netstat`, `sw_vers`, `ioreg`.
 *
 * Everything here is a tool that ships in the base system, so there is nothing
 * to install and nothing that needs root. The parsers are exported and take
 * strings, which is what lets the arithmetic be tested on a Linux CI box that
 * has never seen a Mac.
 *
 * What comes from where:
 *   cpu     `os.cpus()` — Bun reads host_processor_info for it, so per-core
 *           user/nice/sys/idle ticks arrive without a spawn. Deltas are kept the
 *           way the Linux probe keeps /proc/stat. If a runtime ever returns all
 *           zeroes the probe falls back to `ps -A -o %cpu`, which is a total
 *           with no per-core split.
 *   memory  `vm_stat` pages × the page size, against `hw.memsize`. "Available"
 *           is free + inactive + speculative + purgeable, which is what
 *           Activity Monitor calls reclaimable; `vm.swapusage` for swap.
 *   disks   `df -Pk` (BSD df has no -T). The firmlinked APFS plumbing under
 *           /System/Volumes is skipped, as are Time Machine snapshots.
 *   net     `netstat -ibn`, the `<Link#n>` row of each interface, which is the
 *           one that carries the byte counters.
 *   temps   none. SMC needs a private framework or `powermetrics` as root, and
 *           an empty list is the honest answer rather than a helper binary.
 *   facts   `sw_vers`, `machdep.cpu.brand_string`, `hw.model`, `kern.boottime`,
 *           `kern.hv_vmm_present`, and IOPlatformUUID from `ioreg` — which is
 *           what /etc/machine-id is for.
 */

/* ---------- parsers ---------- */

export interface VmStat {
	pageSize: number;
	free: number;
	active: number;
	inactive: number;
	speculative: number;
	wired: number;
	purgeable: number;
	fileBacked: number;
	compressed: number;
}

/**
 * `vm_stat` prints "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
 * and then "Pages free:     12345." lines. The page size is 16K on Apple
 * Silicon and 4K on Intel, which is why it is read from the header rather than
 * assumed.
 */
export function parseVmStat(text: string): VmStat {
	const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
	const pages = (label: string) =>
		Number(text.match(new RegExp(`^${label}:\\s+(\\d+)`, "m"))?.[1] ?? 0) || 0;
	return {
		pageSize,
		free: pages("Pages free"),
		active: pages("Pages active"),
		inactive: pages("Pages inactive"),
		speculative: pages("Pages speculative"),
		wired: pages("Pages wired down"),
		purgeable: pages("Pages purgeable"),
		fileBacked: pages("File-backed pages"),
		compressed: pages("Pages occupied by compressor"),
	};
}

/** "total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)" → bytes. */
export function parseSwapUsage(text: string): { total: number; used: number } {
	const unit: Record<string, number> = {
		K: 1024,
		M: 1024 ** 2,
		G: 1024 ** 3,
		T: 1024 ** 4,
	};
	const read = (key: string) => {
		const m = text.match(new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMGT])?`));
		if (!m) return 0;
		return Number(m[1]) * (unit[m[2] ?? ""] ?? 1);
	};
	return { total: read("total"), used: read("used") };
}

export function memFromVmStat(
	vm: VmStat,
	memsize: number,
	swap: { total: number; used: number },
): MemStats {
	const bytes = (pages: number) => pages * vm.pageSize;
	const free = bytes(vm.free);
	const available = Math.min(
		memsize,
		bytes(vm.free + vm.inactive + vm.speculative + vm.purgeable),
	);
	return {
		total: memsize,
		used: Math.max(0, memsize - available),
		free,
		available,
		// macOS has no buffer cache distinct from the unified one.
		buffers: 0,
		cached: bytes(vm.fileBacked),
		swapTotal: swap.total,
		swapUsed: swap.used,
	};
}

/** Volumes that are APFS plumbing, not somewhere anyone keeps files. */
const SKIP_MOUNT =
	/^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware)(\/|$)|^\/private\/var\/vm(\/|$)|^\/Library\/Developer\/CoreSimulator\/Volumes\//;

/**
 * `df -Pk`. Columns are fixed from the right, so a mount point with spaces in it
 * ("/Volumes/Macintosh HD 2") survives, which splitting on whitespace wouldn't.
 */
export function parseDf(text: string): DiskMount[] {
	const disks: DiskMount[] = [];
	for (const line of text.split("\n").slice(1)) {
		const m = line.match(
			/^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:\d+%|-)\s+(\/.*)$/,
		);
		if (!m) continue;
		const [, filesystem, blocks, usedRaw, availRaw, mount] = m;
		if (!filesystem || !mount) continue;
		// devfs, map auto_home, and the like — only real devices and network mounts.
		const real =
			filesystem.startsWith("/dev/") ||
			filesystem.startsWith("//") ||
			/^[^/\s]+:\//.test(filesystem);
		if (!real) continue;
		if (SKIP_MOUNT.test(mount)) continue;
		if (/\.timemachine|com\.apple\.TimeMachine/i.test(mount)) continue;
		const total = Number(blocks) * 1024;
		if (!Number.isFinite(total) || total <= 0) continue;
		const used = Number(usedRaw) * 1024;
		disks.push({
			filesystem,
			mount,
			total,
			used,
			available: Number(availRaw) * 1024,
			usage: Math.min(1, used / total),
		});
	}
	return disks;
}

/** Interfaces that are plumbing: loopback, tunnels to nowhere, AirDrop radios. */
const NET_SKIP = /^(lo|gif|stf|awdl|llw|ap|anpi|XHC|pktap|vmenet)\d*$/;

export interface NetRow {
	name: string;
	rx: number;
	tx: number;
}

/**
 * `netstat -ibn` prints one row per address, and only the `<Link#n>` row has
 * the byte counters. The Address column is missing on tunnels, so columns are
 * taken from the right: Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll.
 */
export function parseNetstat(text: string): NetRow[] {
	const rows = new Map<string, NetRow>();
	for (const line of text.split("\n").slice(1)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 10 || !parts[2]?.startsWith("<Link#")) continue;
		const name = parts[0]!.replace(/\*$/, "");
		if (NET_SKIP.test(name)) continue;
		const tail = parts.slice(-7);
		const rx = Number(tail[2]);
		const tx = Number(tail[5]);
		if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
		// A down or unused interface has counters and nothing else worth a row.
		if (rx === 0 && tx === 0) continue;
		rows.set(name, { name, rx, tx });
	}
	return [...rows.values()];
}

/** `sw_vers` is "Key:\tValue" lines. */
export function parseSwVers(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split("\n")) {
		const i = line.indexOf(":");
		if (i === -1) continue;
		out.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
	}
	return out;
}

/** The marketing name for a macOS major version, or null for one we don't know. */
export function macosName(version: string | null | undefined): string | null {
	const major = Number(version?.split(".")[0]);
	const names: Record<number, string> = {
		10: "Mac OS X",
		11: "Big Sur",
		12: "Monterey",
		13: "Ventura",
		14: "Sonoma",
		15: "Sequoia",
		26: "Tahoe",
	};
	return names[major] ?? null;
}

/** `kern.boottime` is "{ sec = 1700000000, usec = 0 } Tue Nov 14 …". */
export function parseBootTime(text: string): number | null {
	const sec = Number(text.match(/sec\s*=\s*(\d+)/)?.[1]);
	return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

/** IOPlatformUUID out of `ioreg -rd1 -c IOPlatformExpertDevice`. */
export function parsePlatformUuid(text: string): string | null {
	return text.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/)?.[1] ?? null;
}

/* ---------- cpu ---------- */

type CpuTimes = { idle: number; total: number };

function cpuTimes(): CpuTimes[] {
	return os.cpus().map(({ times }) => ({
		idle: times.idle,
		total: times.user + times.nice + times.sys + times.idle + times.irq,
	}));
}

function busy(now: CpuTimes, prev: CpuTimes | undefined): number {
	if (!prev) return 0;
	const span = now.total - prev.total;
	if (span <= 0) return 0;
	return Math.min(1, Math.max(0, 1 - (now.idle - prev.idle) / span));
}

/** Per-core busy fractions from two samples; null when the runtime gave no ticks. */
export function cpuUsage(
	now: CpuTimes[],
	prev: CpuTimes[] | null,
): number[] | null {
	if (!now.length || now.every((c) => c.total === 0)) return null;
	return now.map((c, i) => busy(c, prev?.[i]));
}

let prevCpu: CpuTimes[] | null = null;
let cpuModel: string | null | undefined;

async function collectCpu(): Promise<CpuStats> {
	if (cpuModel === undefined)
		cpuModel = await sysctl("machdep.cpu.brand_string");
	let sample = cpuTimes();
	if (!prevCpu) {
		// Prime the delta so the first frame isn't a meaningless zero.
		prevCpu = sample;
		await Bun.sleep(200);
		sample = cpuTimes();
	}
	let perCore = cpuUsage(sample, prevCpu);
	prevCpu = sample;
	const cores = sample.length || os.cpus().length;

	if (!perCore) {
		const out = await $`ps -A -o %cpu=`.nothrow().quiet();
		const total = out.stdout
			.toString()
			.split("\n")
			.reduce((sum, l) => sum + (Number(l.trim()) || 0), 0);
		const usage = Math.min(1, total / 100 / Math.max(1, cores));
		perCore = Array.from({ length: cores }, () => usage);
	}
	return {
		usage: perCore.length
			? perCore.reduce((sum, n) => sum + n, 0) / perCore.length
			: 0,
		cores,
		perCore,
		model: cpuModel ?? null,
	};
}

/* ---------- running things ---------- */

async function run(cmd: string[]): Promise<string | null> {
	const out = await $`${cmd}`.nothrow().quiet();
	if (out.exitCode !== 0) return null;
	return out.stdout.toString().trim() || null;
}

async function sysctl(key: string): Promise<string | null> {
	return await run(["sysctl", "-n", key]);
}

/* ---------- the rest of a tick ---------- */

let prevNet: {
	at: number;
	ifaces: Map<string, { rx: number; tx: number }>;
} | null = null;

/** Turns counters into rates against the previous tick, which it replaces. */
export function netInterfaces(rows: NetRow[], now: number): NetInterface[] {
	const elapsed = prevNet ? (now - prevNet.at) / 1000 : 0;
	const current = new Map<string, { rx: number; tx: number }>();
	const out: NetInterface[] = [];
	for (const row of rows) {
		current.set(row.name, { rx: row.rx, tx: row.tx });
		const before = prevNet?.ifaces.get(row.name);
		// Counters reset when an interface bounces; a negative is no data.
		const rate = (cur: number, was: number) =>
			before && elapsed > 0 && cur >= was ? (cur - was) / elapsed : null;
		out.push({
			name: row.name,
			rxBytes: row.rx,
			txBytes: row.tx,
			rxRate: rate(row.rx, before?.rx ?? 0),
			txRate: rate(row.tx, before?.tx ?? 0),
		});
	}
	prevNet = { at: now, ifaces: current };
	return out;
}

let memsize: number | null = null;

async function collectMem(): Promise<MemStats> {
	if (memsize === null)
		memsize = Number(await sysctl("hw.memsize")) || os.totalmem();
	const [vm, swap] = await Promise.all([
		run(["vm_stat"]),
		sysctl("vm.swapusage"),
	]);
	if (!vm) {
		const free = os.freemem();
		return {
			total: memsize,
			used: memsize - free,
			free,
			available: free,
			buffers: 0,
			cached: 0,
			swapTotal: 0,
			swapUsed: 0,
		};
	}
	return memFromVmStat(
		parseVmStat(vm),
		memsize,
		swap ? parseSwapUsage(swap) : { total: 0, used: 0 },
	);
}

async function collectStats(): Promise<SystemStats> {
	const [cpu, mem, df, netstat] = await Promise.all([
		collectCpu(),
		collectMem(),
		run(["df", "-Pk"]),
		run(["netstat", "-ibn"]),
	]);
	const load = os.loadavg();
	const now = Date.now();
	return {
		hostname: os.hostname(),
		platform: `macOS ${os.release()}`,
		kernel: `Darwin ${os.release()}`,
		uptimeSec: Math.round(os.uptime()),
		loadavg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
		cpu,
		mem,
		disks: df ? parseDf(df) : [],
		net: netInterfaces(netstat ? parseNetstat(netstat) : [], now),
		temps: [],
		timestamp: now,
	};
}

/* ---------- facts ---------- */

async function dockerVersion(): Promise<string | null> {
	try {
		const res = await fetch("http://localhost/version", {
			unix: DOCKER_SOCKET,
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { Version?: string };
		return body.Version ?? null;
	} catch {
		return null;
	}
}

let cachedFacts: HostFacts | null = null;
let factsAt = 0;
const FACTS_TTL_MS = 3600_000;

async function collectFacts(force: boolean): Promise<HostFacts> {
	if (!force && cachedFacts && Date.now() - factsAt < FACTS_TTL_MS)
		return cachedFacts;

	const [swVers, brand, model, hv, boot, ioreg, mem, docker] =
		await Promise.all([
			run(["sw_vers"]),
			sysctl("machdep.cpu.brand_string"),
			sysctl("hw.model"),
			sysctl("kern.hv_vmm_present"),
			sysctl("kern.boottime"),
			run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]),
			sysctl("hw.memsize"),
			dockerVersion(),
		]);

	const vers = parseSwVers(swVers ?? "");
	const version = vers.get("ProductVersion") ?? null;
	const build = vers.get("BuildVersion") ?? null;
	const codename = macosName(version);
	const name = vers.get("ProductName") ?? "macOS";
	const now = Date.now();
	const bootedAt = boot ? parseBootTime(boot) : null;

	cachedFacts = {
		hostname: os.hostname(),
		osId: "macos",
		osLike: null,
		osPretty: version
			? `${name} ${version}${codename ? ` ${codename}` : ""}${build ? ` (${build})` : ""}`
			: name,
		osName: name,
		osVersion: version,
		osCodename: codename?.toLowerCase().replace(/\s+/g, "-") ?? null,
		lsbRelease: null,
		kernel: `Darwin ${os.release()}`,
		arch: os.arch(),
		// kern.hv_vmm_present is 1 inside a guest; macOS can't name the hypervisor.
		virtualization: hv === "1" ? "vm" : "none",
		init: "launchd",
		systemdVersion: null,
		machineId: ioreg ? (parsePlatformUuid(ioreg)?.toLowerCase() ?? null) : null,
		cpuModel: brand ?? model,
		cpuCores: os.cpus().length,
		memTotal: Number(mem) || os.totalmem(),
		bootedAt: bootedAt ?? (os.uptime() ? now - os.uptime() * 1000 : null),
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
		dockerVersion: docker,
		collectedAt: now,
	};
	factsAt = now;
	return cachedFacts;
}

/* ---------- the probe ---------- */

export const darwinProbe: SystemProbe = {
	platform: "darwin",

	/** `vm_stat` and `sysctl` are the two every field leans on. */
	async available() {
		return (
			process.platform === "darwin" &&
			Bun.which("sysctl") !== null &&
			Bun.which("vm_stat") !== null
		);
	},

	stats: collectStats,
	facts: (force = false) => collectFacts(force),
};
