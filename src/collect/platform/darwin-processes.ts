import os from "node:os";
import { basename } from "node:path";
import { $ } from "bun";
import type { ListeningPort, ProcessInfo } from "../../types.ts";

/**
 * Process and socket listings for macOS.
 *
 * BSD `ps` has no `--sort` and no `etimes`, and there is no `ss`, so this is the
 * same two questions as the Linux collectors asked of the tools macOS does ship:
 * `ps -axo` with the sort done here, and `netstat -anv`, which unlike `lsof`
 * names the owning pid of *every* socket without root.
 */

const CORES = os.cpus().length || 1;

/** `ps` etime: `[[dd-]hh:]mm:ss`, as seconds. */
export function parseEtime(raw: string): number {
	const m = raw.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
	if (!m) return 0;
	const [, d, h, mi, s] = m;
	return (
		Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s)
	);
}

/**
 * Output of `ps -axo pid=,ppid=,user=,pcpu=,pmem=,rss=,etime=,comm=`, joined to
 * the `pid=,args=` listing. Two calls because `comm` is a full path that may
 * hold spaces ("Google Chrome Helper") and so can't share a line with `args`
 * without a boundary to split on.
 */
export function parsePs(
	text: string,
	argsText: string,
	limit: number,
): ProcessInfo[] {
	const argv = new Map<number, string>();
	for (const line of argsText.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(.*)$/);
		if (m) argv.set(Number(m[1]), m[2]!);
	}
	const procs: ProcessInfo[] = [];
	for (const line of text.split("\n")) {
		const m = line
			.trim()
			.match(
				/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.,]+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(.+)$/,
			);
		if (!m) continue;
		const [, pid, ppid, user, pcpu, pmem, rss, etime, comm] = m;
		procs.push({
			pid: Number(pid),
			ppid: Number(ppid),
			user: user!,
			// ps reports percent-of-one-core; normalise so 1.0 means the whole box.
			cpu: Number(pcpu!.replace(",", ".")) / 100 / CORES,
			mem: Number(pmem!.replace(",", ".")) / 100,
			rssBytes: Number(rss) * 1024,
			elapsedSec: parseEtime(etime!),
			command: basename(comm!),
			args: argv.get(Number(pid)) ?? comm!,
		});
	}
	return procs.sort((a, b) => b.cpu - a.cpu).slice(0, limit);
}

export async function collectProcesses(limit: number): Promise<ProcessInfo[]> {
	const [main, args] = await Promise.all([
		$`ps -axo pid=,ppid=,user=,pcpu=,pmem=,rss=,etime=,comm=`.nothrow().quiet(),
		$`ps -axo pid=,args=`.nothrow().quiet(),
	]);
	if (main.exitCode !== 0) return [];
	return parsePs(main.stdout.toString(), args.stdout.toString(), limit);
}

/**
 * One socket row of `netstat -anv`. The address is `host.port` — a dot, not a
 * colon — and the column the pid lives in moves by one because UDP has no state.
 */
export function parseNetstatListeners(
	text: string,
	names: Map<number, string>,
): ListeningPort[] {
	const ports: ListeningPort[] = [];
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		const parts = line.trim().split(/\s+/);
		const proto = parts[0];
		if (!proto || !/^(tcp|udp)/.test(proto)) continue;
		const isTcp = proto.startsWith("tcp");
		if (isTcp && parts[5] !== "LISTEN") continue;
		const local = parts[3];
		if (!local) continue;
		const dot = local.lastIndexOf(".");
		if (dot === -1) continue;
		const port = Number(local.slice(dot + 1));
		if (!Number.isFinite(port) || port <= 0) continue;
		const address = local.slice(0, dot);
		const pidRaw = Number(parts[isTcp ? 8 : 7]);
		const pid = Number.isFinite(pidRaw) && pidRaw > 0 ? pidRaw : null;
		const kind = proto.replace(/[46]$/, "");
		const key = `${kind}/${port}/${address}`;
		if (seen.has(key)) continue;
		seen.add(key);
		ports.push({
			proto: kind,
			address,
			port,
			pid,
			process: pid !== null ? (names.get(pid) ?? null) : null,
		});
	}
	return ports.sort((a, b) => a.port - b.port);
}

export async function collectListeningPorts(): Promise<ListeningPort[]> {
	const [tcp, udp, ps] = await Promise.all([
		$`netstat -anv -p tcp`.nothrow().quiet(),
		$`netstat -anv -p udp`.nothrow().quiet(),
		$`ps -axo pid=,comm=`.nothrow().quiet(),
	]);
	const names = new Map<number, string>();
	for (const line of ps.stdout.toString().split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(.+)$/);
		if (m) names.set(Number(m[1]), basename(m[2]!));
	}
	return parseNetstatListeners(
		`${tcp.stdout.toString()}\n${udp.stdout.toString()}`,
		names,
	);
}
