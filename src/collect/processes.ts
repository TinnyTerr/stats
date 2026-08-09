import { readFile } from "node:fs/promises";
import os from "node:os";
import { $ } from "bun";
import type { ListeningPort, ProcessInfo } from "../types.ts";

const CORES = os.cpus().length || 1;

/**
 * Top processes by CPU. Uses `ps` rather than walking /proc because ps already
 * does the jiffies-to-percent arithmetic and handles the ppid/user lookups.
 */
export async function collectProcesses(limit = 20): Promise<ProcessInfo[]> {
	const out =
		await $`ps -eo pid=,ppid=,user:32=,pcpu=,pmem=,rss=,etimes=,comm=,args= --sort=-pcpu`
			.nothrow()
			.quiet();
	if (out.exitCode !== 0) return [];

	const procs: ProcessInfo[] = [];
	for (const line of out.stdout.toString().split("\n")) {
		if (!line.trim()) continue;
		// Fixed columns up to `comm`, then args is the unbounded remainder.
		const m = line
			.trim()
			.match(
				/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/,
			);
		if (!m) continue;
		const [, pid, ppid, user, pcpu, pmem, rss, etimes, comm, args] = m;
		procs.push({
			pid: Number(pid),
			ppid: Number(ppid),
			user: user!,
			// ps reports percent-of-one-core; normalise so 1.0 means the whole box.
			cpu: Number(pcpu) / 100 / CORES,
			mem: Number(pmem) / 100,
			rssBytes: Number(rss) * 1024,
			elapsedSec: Number(etimes),
			command: comm!,
			args: args ?? "",
		});
		if (procs.length >= limit) break;
	}
	return procs;
}

/* ---------- per-process sampling, for supervised project processes ---------- */

const CLOCK_TICKS = 100; // _SC_CLK_TCK; 100 on every Linux this runs on
const PAGE_SIZE = 4096;

interface CpuSample {
	at: number;
	ticks: number;
}

const prevProcCpu = new Map<number, CpuSample>();

export interface ProcSample {
	cpu: number | null;
	rssBytes: number;
	threads: number;
}

/**
 * CPU and memory for one pid, read straight from /proc so a supervised process
 * can be charted without shelling out to `ps` per tick. CPU is a delta, so the
 * first call for a pid returns null and the second returns a real fraction.
 *
 * Counts the process and everything it spawned that has been reaped
 * (`cutime`/`cstime`), which is what you want for a `bun run start` wrapper.
 */
export async function sampleProcess(pid: number): Promise<ProcSample | null> {
	const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
	if (stat === null) {
		prevProcCpu.delete(pid);
		return null;
	}

	// comm can contain spaces and parens, so fields are counted from the last ')'.
	const close = stat.lastIndexOf(")");
	const fields = stat.slice(close + 2).split(" ");
	// After comm and state, field indices are shifted by 3 from the proc(5) table.
	const utime = Number(fields[11] ?? 0);
	const stime = Number(fields[12] ?? 0);
	const cutime = Number(fields[13] ?? 0);
	const cstime = Number(fields[14] ?? 0);
	const threads = Number(fields[17] ?? 1);
	const rssPages = Number(fields[21] ?? 0);

	const ticks = utime + stime + cutime + cstime;
	const now = Date.now();
	const prev = prevProcCpu.get(pid);
	prevProcCpu.set(pid, { at: now, ticks });

	let cpu: number | null = null;
	if (prev && now > prev.at) {
		const seconds = (now - prev.at) / 1000;
		cpu = Math.min(
			1,
			Math.max(0, (ticks - prev.ticks) / CLOCK_TICKS / seconds / CORES),
		);
	}

	return { cpu, rssBytes: rssPages * PAGE_SIZE, threads };
}

/** Forgets a pid's CPU baseline, so a restarted process doesn't inherit it. */
export function forgetProcess(pid: number) {
	prevProcCpu.delete(pid);
}

/**
 * TCP/UDP listeners, so the dashboard can answer "what is actually serving
 * on this box". `ss` is part of iproute2 and present on effectively every
 * modern Linux install.
 */
export async function collectListeningPorts(): Promise<ListeningPort[]> {
	const out = await $`ss -tulnpH`.nothrow().quiet();
	if (out.exitCode !== 0) return [];

	const ports: ListeningPort[] = [];
	const seen = new Set<string>();
	for (const line of out.stdout.toString().split("\n")) {
		if (!line.trim()) continue;
		const parts = line.trim().split(/\s+/);
		const proto = parts[0];
		const local = parts[4];
		if (!proto || !local) continue;

		// local looks like 0.0.0.0:22, [::]:80, or *:5432
		const idx = local.lastIndexOf(":");
		if (idx === -1) continue;
		const address = local.slice(0, idx);
		const port = Number(local.slice(idx + 1));
		if (!Number.isFinite(port)) continue;

		// users:(("nginx",pid=123,fd=6)) — take the first entry
		const procMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);

		const key = `${proto}/${port}/${address}`;
		if (seen.has(key)) continue;
		seen.add(key);

		ports.push({
			proto,
			address,
			port,
			pid: procMatch ? Number(procMatch[2]) : null,
			process: procMatch ? procMatch[1]! : null,
		});
	}
	return ports.sort((a, b) => a.port - b.port);
}
