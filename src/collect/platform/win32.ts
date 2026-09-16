import os from "node:os";
import type {
	CpuStats,
	DiskMount,
	HostFacts,
	MemStats,
	NetInterface,
	SystemStats,
	TempSensor,
} from "../../types.ts";
import type { SystemProbe } from "../probe.ts";

/**
 * The Windows probe: CIM through PowerShell.
 *
 * There is no /proc and no `df` here, so every field is its own lookup, and
 * process start-up is the expensive part on Windows — a `powershell.exe` is
 * 300ms or more before it runs a line. So a tick is *one* spawn that runs one
 * script and prints one JSON document, rather than one spawn per collector;
 * the script is written for both PowerShell 7 and the Windows PowerShell 5.1
 * every box ships with, and each query inside it is allowed to fail on its own
 * so a host without a thermal zone still reports its disks.
 *
 * What comes from where:
 *   cpu     `Win32_PerfRawData_PerfOS_Processor` — raw idle ticks per core and
 *           the timestamp they were read at, deltas kept the way the Linux
 *           probe keeps /proc/stat. Raw rather than the formatted class because
 *           a formatted counter is 0 the first time a process reads it, and
 *           every tick is a new process.
 *   memory  `Win32_OperatingSystem`, `Win32_PageFileUsage` for swap
 *   disks   `Win32_LogicalDisk` with DriveType=3 — fixed drives, by letter
 *   net     `Get-NetAdapterStatistics`, falling back to the Tcpip perf class
 *   temps   `MSAcpi_ThermalZoneTemperature`, which most desktop firmware
 *           doesn't fill in and non-admin users can't read; empty is normal
 *   facts   `Win32_OperatingSystem`, `Win32_ComputerSystem`, `Win32_Processor`
 *           and CurrentVersion in the registry; machineId is MachineGuid, which
 *           is what /etc/machine-id is for
 *
 * Windows has no load average. The number reported is the kernel's own formula
 * applied to what Windows does expose: busy cores plus the processor queue
 * length, damped over 1, 5 and 15 minutes — see {@link LoadAverage}.
 */

/* ---------- the scripts ---------- */

const PRELUDE = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
`;

const TICK_SCRIPT = `${PRELUDE}
$cpu = @(Get-CimInstance -ClassName Win32_PerfRawData_PerfOS_Processor | ForEach-Object {
  @{ name = [string]$_.Name; idle = [double]$_.PercentIdleTime; ts = [double]$_.Timestamp_Sys100NS }
})
$sys = Get-CimInstance -ClassName Win32_PerfRawData_PerfOS_System
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$page = @(Get-CimInstance -ClassName Win32_PageFileUsage | ForEach-Object {
  @{ total = [double]$_.AllocatedBaseSize; used = [double]$_.CurrentUsage }
})
$disks = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  @{ id = [string]$_.DeviceID; size = [double]$_.Size; free = [double]$_.FreeSpace; fs = [string]$_.FileSystem; label = [string]$_.VolumeName }
})
$net = @(Get-NetAdapterStatistics | ForEach-Object {
  @{ name = [string]$_.Name; rx = [double]$_.ReceivedBytes; tx = [double]$_.SentBytes }
})
if ($net.Count -eq 0) {
  $net = @(Get-CimInstance -ClassName Win32_PerfRawData_Tcpip_NetworkInterface | ForEach-Object {
    @{ name = [string]$_.Name; rx = [double]$_.BytesReceivedPersec; tx = [double]$_.BytesSentPersec }
  })
}
$temps = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | ForEach-Object {
  @{ name = [string]$_.InstanceName; k10 = [double]$_.CurrentTemperature }
})
$out = @{
  cpu = $cpu
  queue = [double]$sys.ProcessorQueueLength
  mem = @{ totalKb = [double]$os.TotalVisibleMemorySize; freeKb = [double]$os.FreePhysicalMemory }
  page = $page
  disks = $disks
  net = $net
  temps = $temps
}
ConvertTo-Json -InputObject $out -Compress -Depth 5
`;

const FACTS_SCRIPT = `${PRELUDE}
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$cs = Get-CimInstance -ClassName Win32_ComputerSystem
$cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
$cv = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
$crypt = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography'
$release = $cv.DisplayVersion
if (-not $release) { $release = $cv.ReleaseId }
$uptime = 0
if ($os.LastBootUpTime) { $uptime = [double]((Get-Date) - $os.LastBootUpTime).TotalSeconds }
$out = @{
  caption = [string]$os.Caption
  version = [string]$os.Version
  ubr = [string]$cv.UBR
  release = [string]$release
  manufacturer = [string]$cs.Manufacturer
  model = [string]$cs.Model
  cpu = [string]$cpu.Name
  cores = [int]$cs.NumberOfLogicalProcessors
  memKb = [double]$os.TotalVisibleMemorySize
  machineId = [string]$crypt.MachineGuid
  uptime = $uptime
}
ConvertTo-Json -InputObject $out -Compress -Depth 3
`;

/* ---------- what the scripts print ---------- */

/** One tick's raw answer, exactly as TICK_SCRIPT prints it. */
export interface TickReport {
	cpu?: { name: string; idle: number; ts: number }[];
	queue?: number;
	mem?: { totalKb: number; freeKb: number };
	page?: { total: number; used: number }[];
	disks?: {
		id: string;
		size: number;
		free: number;
		fs: string;
		label: string;
	}[];
	net?: { name: string; rx: number; tx: number }[];
	temps?: { name: string; k10: number }[];
}

/** FACTS_SCRIPT's answer. */
export interface FactsReport {
	caption?: string;
	version?: string;
	ubr?: string;
	release?: string;
	manufacturer?: string;
	model?: string;
	cpu?: string;
	cores?: number;
	memKb?: number;
	machineId?: string;
	uptime?: number;
}

/**
 * ConvertTo-Json in Windows PowerShell unwraps a one-element array when it
 * arrives by pipeline; `-InputObject` keeps it, but a wrong shape here would
 * mean a wrong card, so the reader tolerates both.
 */
function asArray<T>(value: T | T[] | null | undefined): T[] {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

/* ---------- running PowerShell ---------- */

let shell: string | null | undefined;

/**
 * PowerShell 7 if it's on PATH, else the Windows PowerShell every box has.
 * `Bun.which()` is the whole lookup: a Store-installed pwsh is an app
 * execution alias that `stat()` refuses, so a second check would reject it.
 */
function findShell(): string | null {
	if (shell === undefined)
		shell = Bun.which("pwsh") ?? Bun.which("powershell") ?? null;
	return shell;
}

/** Test seam: pretend a shell is (or isn't) there. */
export function setWin32Shell(next: string | null | undefined) {
	shell = next;
}

const SCRIPT_TIMEOUT_MS = 20_000;

/**
 * Runs a script and parses the one JSON document it prints. `-EncodedCommand`
 * rather than `-Command`: the script has quotes and newlines, and base64 is
 * the one form both PowerShells take without a parser in between.
 */
async function runScript<T>(script: string): Promise<T> {
	const exe = findShell();
	if (!exe) throw new Error("no PowerShell on PATH");
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const proc = Bun.spawn(
		[
			exe,
			"-NoProfile",
			"-NonInteractive",
			"-NoLogo",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			encoded,
		],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	const timer = setTimeout(() => proc.kill(), SCRIPT_TIMEOUT_MS);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const text = stdout.trim();
		if (!text) {
			const why = stderr.trim().split("\n")[0] ?? "";
			throw new Error(
				code === 0
					? "PowerShell printed nothing"
					: `PowerShell exited ${code}${why ? `: ${why}` : ""}`,
			);
		}
		return JSON.parse(text) as T;
	} finally {
		clearTimeout(timer);
	}
}

/* ---------- cpu ---------- */

type CpuTicks = { idle: number; ts: number };
/** Per-core idle ticks and the clock they were read against. */
type CpuSample = CpuTicks[];

function cpuSample(report: TickReport): CpuSample | null {
	// The `_Total` instance is an average across cores, not a sum; the mean of
	// the per-core deltas says the same thing and doesn't depend on knowing that.
	const cores = asArray(report.cpu)
		.filter((r) => /^\d+$/.test(r.name))
		.sort((a, b) => Number(a.name) - Number(b.name))
		.map((r) => ({ idle: Number(r.idle) || 0, ts: Number(r.ts) || 0 }));
	return cores.length ? cores : null;
}

function busy(now: CpuTicks, prev: CpuTicks | undefined): number {
	if (!prev) return 0;
	const span = now.ts - prev.ts;
	if (span <= 0) return 0;
	return Math.min(1, Math.max(0, 1 - (now.idle - prev.idle) / span));
}

/**
 * Where the perf counter class is missing — corrupt counters are a known
 * Windows condition — `os.cpus()` still answers, in the same idle/total shape
 * the Linux probe reads from /proc/stat.
 */
function osCpuSample(): CpuSample | null {
	const cpus = os.cpus();
	if (!cpus.length) return null;
	return cpus.map(({ times }) => ({
		idle: times.idle,
		ts: times.user + times.nice + times.sys + times.idle + times.irq,
	}));
}

/* ---------- load average ---------- */

/** Seconds, the kernel's three windows. */
const LOAD_WINDOWS = [60, 300, 900] as const;

/**
 * Windows keeps no load average, but it does expose the two things one is made
 * of: how many cores are busy right now (usage × cores) and how many threads
 * are waiting for one (`ProcessorQueueLength`). Their sum is the instantaneous
 * run queue the Linux kernel would sample, and the kernel's exponentially
 * damped average over 1, 5 and 15 minutes turns it into the number every
 * other card shows. It is an honest derivation, not a native counter — an
 * idle 8-core box reads 0.0x and a saturated one reads 8-and-change, which is
 * what the operator's eye is calibrated to.
 */
export class LoadAverage {
	private values: [number, number, number] | null = null;
	private at = 0;

	sample(runQueue: number, now: number): [number, number, number] {
		if (!this.values) {
			this.values = [runQueue, runQueue, runQueue];
		} else {
			const dt = Math.max(0, (now - this.at) / 1000);
			this.values = LOAD_WINDOWS.map((window, i) => {
				const keep = Math.exp(-dt / window);
				return this.values![i]! * keep + runQueue * (1 - keep);
			}) as [number, number, number];
		}
		this.at = now;
		return [...this.values] as [number, number, number];
	}
}

/* ---------- the rest of a tick ---------- */

function memStats(report: TickReport): MemStats {
	const total = (report.mem?.totalKb ?? 0) * 1024 || os.totalmem();
	const available = report.mem ? report.mem.freeKb * 1024 : os.freemem();
	let swapTotal = 0;
	let swapUsed = 0;
	for (const file of asArray(report.page)) {
		swapTotal += (file.total ?? 0) * 1024 * 1024;
		swapUsed += (file.used ?? 0) * 1024 * 1024;
	}
	return {
		total,
		used: total - available,
		// Windows doesn't split "free" from "available" the way /proc/meminfo
		// does; FreePhysicalMemory is what's reclaimable now, which is the second.
		free: available,
		available,
		buffers: 0,
		cached: 0,
		swapTotal,
		swapUsed,
	};
}

function diskMounts(report: TickReport): DiskMount[] {
	const disks: DiskMount[] = [];
	for (const d of asArray(report.disks)) {
		const total = Number(d.size);
		if (!Number.isFinite(total) || total <= 0) continue;
		const available = Math.max(0, Number(d.free) || 0);
		const used = total - available;
		const fs = d.fs || "?";
		disks.push({
			filesystem: d.label ? `${d.label} (${fs})` : fs,
			mount: `${d.id.replace(/\\$/, "")}\\`,
			total,
			used,
			available,
			usage: used / total,
		});
	}
	return disks;
}

/** Adapters that are plumbing rather than a link anyone watches. */
const NET_SKIP = /loopback|isatap|teredo|pseudo-interface|6to4/i;

type NetState = { at: number; ifaces: Map<string, { rx: number; tx: number }> };

function netInterfaces(
	report: TickReport,
	prev: NetState | null,
	now: number,
): { net: NetInterface[]; state: NetState } {
	const current = new Map<string, { rx: number; tx: number }>();
	const net: NetInterface[] = [];
	const elapsed = prev ? (now - prev.at) / 1000 : 0;
	for (const row of asArray(report.net)) {
		const name = row.name?.trim();
		if (!name || NET_SKIP.test(name)) continue;
		const rx = Number(row.rx) || 0;
		const tx = Number(row.tx) || 0;
		// A Bluetooth PAN or an unplugged adapter has counters and nothing else.
		if (rx === 0 && tx === 0) continue;
		current.set(name, { rx, tx });
		const before = prev?.ifaces.get(name);
		const rate = (cur: number, was: number) =>
			before && elapsed > 0 && cur >= was ? (cur - was) / elapsed : null;
		net.push({
			name,
			rxBytes: rx,
			txBytes: tx,
			rxRate: rate(rx, before?.rx ?? 0),
			txRate: rate(tx, before?.tx ?? 0),
		});
	}
	return { net, state: { at: now, ifaces: current } };
}

function tempSensors(report: TickReport): TempSensor[] {
	const temps: TempSensor[] = [];
	for (const t of asArray(report.temps)) {
		// Tenths of a kelvin; 0 and 273.2K (a flat 0°C) are what firmware reports
		// when there is no sensor behind the zone.
		const celsius = (Number(t.k10) || 0) / 10 - 273.15;
		if (!(celsius > 1 && celsius < 150)) continue;
		const name =
			t.name?.split(/[\\/]/).pop()?.replace(/_\d+$/, "") || "thermal";
		temps.push({ name, celsius });
	}
	return temps;
}

/* ---------- facts ---------- */

/**
 * Manufacturer and model are the honest signal here — `HypervisorPresent` is
 * also true on a *host* with Hyper-V enabled, which is every box running WSL2
 * or Docker Desktop, so it can't tell a guest from a workstation.
 */
export function detectVirtualization(report: FactsReport): string {
	const model =
		`${report.manufacturer ?? ""} ${report.model ?? ""}`.toLowerCase();
	if (/vmware/.test(model)) return "vmware";
	if (/virtualbox/.test(model)) return "oracle";
	if (/virtual machine|hyper-v/.test(model)) return "microsoft";
	if (/qemu|kvm/.test(model)) return "kvm";
	if (/xen/.test(model)) return "xen";
	if (/parallels/.test(model)) return "parallels";
	return "none";
}

/** "Microsoft Windows 11 Pro" → "11"; "… Server 2022 Datacenter" → "Server 2022". */
export function windowsVersion(caption: string | undefined): string | null {
	const m = caption?.match(
		/Windows\s+(Server\s+\d{4}(?:\s+R2)?|\d+(?:\.\d+)?)/i,
	);
	return m?.[1]?.replace(/\s+/g, " ") ?? null;
}

export function factsFromReport(report: FactsReport, now: number): HostFacts {
	const caption = report.caption?.trim() || null;
	const build = report.version?.trim() || os.release();
	const kernel = report.ubr ? `${build}.${report.ubr}` : build;
	const release = report.release?.trim() || null;
	const uptime = Number(report.uptime) || os.uptime();
	const pretty = caption
		? `${caption}${release ? ` ${release}` : ""} (build ${kernel.replace(/^10\.0\./, "")})`
		: null;
	return {
		hostname: os.hostname(),
		osId: "windows",
		osLike: null,
		osPretty: pretty,
		osName: "Windows",
		osVersion: windowsVersion(caption ?? undefined),
		osCodename: release,
		lsbRelease: null,
		kernel,
		arch: os.arch(),
		virtualization: detectVirtualization(report),
		// The Service Control Manager is what PID 1 is on this platform.
		init: "scm",
		systemdVersion: null,
		machineId: report.machineId?.trim().toLowerCase() || null,
		cpuModel: report.cpu?.replace(/\s+/g, " ").trim() || null,
		cpuCores: report.cores || os.cpus().length,
		memTotal: (report.memKb ?? 0) * 1024 || os.totalmem(),
		bootedAt: uptime ? now - uptime * 1000 : null,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
		dockerVersion: null,
		collectedAt: now,
	};
}

/* ---------- the probe ---------- */

/** Everything a tick carries forward to the next one. */
export interface TickState {
	cpu: CpuSample | null;
	net: NetState | null;
	load: LoadAverage;
}

export function freshState(): TickState {
	return { cpu: null, net: null, load: new LoadAverage() };
}

/**
 * One report plus the previous tick's state → one frame. Pure, so the
 * arithmetic is testable on a host that has never seen PowerShell.
 */
export function statsFromReport(
	report: TickReport,
	state: TickState,
	now: number,
	cpuModel: string | null,
	prime = false,
): SystemStats {
	const sample = cpuSample(report) ?? osCpuSample();
	const perCore = sample ? sample.map((c, i) => busy(c, state.cpu?.[i])) : [];
	const cpu: CpuStats = {
		usage: perCore.length
			? perCore.reduce((sum, n) => sum + n, 0) / perCore.length
			: 0,
		cores: sample?.length ?? os.cpus().length,
		perCore,
		model: cpuModel,
	};
	state.cpu = sample;

	const { net, state: netState } = netInterfaces(report, state.net, now);
	state.net = netState;

	// The priming read has no previous sample, so its usage is a zero that
	// would sit in the 15-minute average for a quarter of an hour.
	const runQueue = cpu.usage * cpu.cores + (Number(report.queue) || 0);
	const loadavg: [number, number, number] = prime
		? [0, 0, 0]
		: state.load.sample(runQueue, now);

	return {
		hostname: os.hostname(),
		platform: `Windows ${os.release()}`,
		kernel: os.release(),
		uptimeSec: Math.round(os.uptime()),
		loadavg,
		cpu,
		mem: memStats(report),
		disks: diskMounts(report),
		net,
		temps: tempSensors(report),
		timestamp: now,
	};
}

const state = freshState();
let cachedFacts: HostFacts | null = null;
let factsAt = 0;
const FACTS_TTL_MS = 3600_000;

export const win32Probe: SystemProbe = {
	platform: "win32",

	/** A shell is the only thing the probe can't do without. */
	async available() {
		return process.platform === "win32" && findShell() !== null;
	},

	async stats() {
		if (!state.cpu) {
			// Prime the delta so the first frame a card draws isn't a zero. One
			// extra spawn, once per process.
			statsFromReport(
				await runScript<TickReport>(TICK_SCRIPT),
				state,
				Date.now(),
				null,
				true,
			);
			await Bun.sleep(250);
		}
		const report = await runScript<TickReport>(TICK_SCRIPT);
		return statsFromReport(
			report,
			state,
			Date.now(),
			cachedFacts?.cpuModel ?? null,
		);
	},

	async facts(force = false) {
		if (!force && cachedFacts && Date.now() - factsAt < FACTS_TTL_MS)
			return cachedFacts;
		const report = await runScript<FactsReport>(FACTS_SCRIPT);
		cachedFacts = factsFromReport(report, Date.now());
		factsAt = Date.now();
		return cachedFacts;
	},
};
