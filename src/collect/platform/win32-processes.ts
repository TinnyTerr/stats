import os from "node:os";
import type { ListeningPort, ProcessInfo } from "../../types.ts";
import { asArray, PRELUDE, runScript } from "./win32.ts";

/**
 * Process and socket listings for Windows, from CIM and the NetTCPIP module —
 * one PowerShell spawn each, for the same reason the system probe is one spawn.
 *
 * CPU is a delta of `KernelModeTime + UserModeTime` (100ns units) kept between
 * calls, the way the Linux collector keeps /proc/stat; the first call primes it.
 * Owners are the expensive part (`GetOwner` is a method call per process), so
 * they are looked up only for the pids the previous call ranked highest and
 * cached for as long as the process lives.
 */

const CORES = os.cpus().length || 1;

export interface WinProc {
	pid: number;
	ppid: number;
	name: string;
	cmd: string;
	started: number;
	rss: number;
	cpu100ns: number;
}

interface PsReport {
	procs?: WinProc[];
	owners?: { pid: number; user: string }[];
}

function processScript(ownerPids: number[]): string {
	return `${PRELUDE}
$want = @(${ownerPids.join(",")})
$procs = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {
  $start = 0
  if ($_.CreationDate) { $start = [int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds() }
  @{
    pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name
    cmd = [string]$_.CommandLine; started = $start; rss = [double]$_.WorkingSetSize
    cpu100ns = [double]$_.KernelModeTime + [double]$_.UserModeTime
  }
})
$owners = @()
if ($want.Count -gt 0) {
  $owners = @(Get-CimInstance -ClassName Win32_Process -Filter (($want | ForEach-Object { "ProcessId=$_" }) -join ' OR ') 2>$null | ForEach-Object {
    $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
    @{ pid = [int]$_.ProcessId; user = [string]$o.User }
  })
}
ConvertTo-Json -InputObject @{ procs = $procs; owners = $owners } -Compress -Depth 4
`;
}

/** What a call carries forward: CPU baselines, owner cache, who to ask about next. */
export interface ProcState {
	at: number;
	cpu: Map<number, number>;
	/** keyed by `pid:started` so a recycled pid doesn't inherit the old owner */
	owners: Map<string, string>;
	rank: number[];
}

export function freshProcState(): ProcState {
	return { at: 0, cpu: new Map(), owners: new Map(), rank: [] };
}

/** Pure half: a report and the previous state in, the top `limit` out. */
export function processesFromReport(
	report: PsReport,
	state: ProcState,
	now: number,
	limit: number,
	totalMem = os.totalmem(),
): ProcessInfo[] {
	const seconds = state.at ? (now - state.at) / 1000 : 0;
	for (const o of asArray(report.owners)) {
		const proc = asArray(report.procs).find((p) => p.pid === o.pid);
		if (proc && o.user) state.owners.set(`${o.pid}:${proc.started}`, o.user);
	}
	const nextCpu = new Map<number, number>();
	const out: ProcessInfo[] = [];
	for (const p of asArray(report.procs)) {
		if (p.pid === 0) continue; // System Idle Process: all the idle time, none of the use
		nextCpu.set(p.pid, p.cpu100ns);
		const before = state.cpu.get(p.pid);
		const cpu =
			before !== undefined && seconds > 0 && p.cpu100ns >= before
				? Math.min(1, (p.cpu100ns - before) / 1e7 / seconds / CORES)
				: 0;
		out.push({
			pid: p.pid,
			ppid: p.ppid,
			user: state.owners.get(`${p.pid}:${p.started}`) ?? "",
			cpu,
			mem: totalMem > 0 ? p.rss / totalMem : 0,
			rssBytes: p.rss,
			elapsedSec: p.started
				? Math.max(0, Math.round(now / 1000 - p.started))
				: 0,
			command: p.name.replace(/\.exe$/i, ""),
			args: p.cmd || p.name,
		});
	}
	state.at = now;
	state.cpu = nextCpu;
	out.sort((a, b) => b.cpu - a.cpu || b.rssBytes - a.rssBytes);
	const top = out.slice(0, limit);
	state.rank = top.map((p) => p.pid);
	return top;
}

const procState = freshProcState();

export async function collectProcesses(limit: number): Promise<ProcessInfo[]> {
	const lookup = () =>
		procState.rank.filter(
			(pid) =>
				![...procState.owners.keys()].some((k) => k.startsWith(`${pid}:`)),
		);
	if (!procState.at) {
		// Prime the delta so the first listing isn't all zeroes.
		processesFromReport(
			await runScript<PsReport>(processScript([])),
			procState,
			Date.now(),
			limit,
		);
		await Bun.sleep(250);
	}
	const report = await runScript<PsReport>(processScript(lookup()));
	return processesFromReport(report, procState, Date.now(), limit);
}

/* ---------- ports ---------- */

interface PortsReport {
	tcp?: { addr: string; port: number; pid: number }[];
	udp?: { addr: string; port: number; pid: number }[];
	names?: { pid: number; name: string }[];
}

const PORTS_SCRIPT = `${PRELUDE}
$tcp = @(Get-NetTCPConnection -State Listen | ForEach-Object {
  @{ addr = [string]$_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess }
})
$udp = @(Get-NetUDPEndpoint | ForEach-Object {
  @{ addr = [string]$_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess }
})
$names = @(Get-Process | ForEach-Object { @{ pid = [int]$_.Id; name = [string]$_.ProcessName } })
ConvertTo-Json -InputObject @{ tcp = $tcp; udp = $udp; names = $names } -Compress -Depth 4
`;

export function portsFromReport(report: PortsReport): ListeningPort[] {
	const names = new Map(asArray(report.names).map((n) => [n.pid, n.name]));
	const ports: ListeningPort[] = [];
	const seen = new Set<string>();
	const add = (proto: string, rows: PortsReport["tcp"]) => {
		for (const row of asArray(rows)) {
			if (!Number.isFinite(row.port) || row.port <= 0) continue;
			const key = `${proto}/${row.port}/${row.addr}`;
			if (seen.has(key)) continue;
			seen.add(key);
			// pid 0 is the System Idle Process — what a socket owned by the kernel reports.
			const pid = row.pid > 0 ? row.pid : null;
			ports.push({
				proto,
				address: row.addr,
				port: row.port,
				pid,
				process: pid !== null ? (names.get(pid) ?? null) : null,
			});
		}
	};
	add("tcp", report.tcp);
	add("udp", report.udp);
	return ports.sort((a, b) => a.port - b.port);
}

export async function collectListeningPorts(): Promise<ListeningPort[]> {
	return portsFromReport(await runScript<PortsReport>(PORTS_SCRIPT));
}
