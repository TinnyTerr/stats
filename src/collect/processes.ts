import { $ } from "bun";
import os from "node:os";
import type { ListeningPort, ProcessInfo, ServiceInfo } from "../types.ts";

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
      .match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
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

/** Running systemd services. Returns [] on non-systemd hosts. */
export async function collectServices(): Promise<ServiceInfo[]> {
  const out = await $`systemctl list-units --type=service --state=running --no-pager --plain --no-legend`
    .nothrow()
    .quiet();
  if (out.exitCode !== 0) return [];

  const services: ServiceInfo[] = [];
  for (const line of out.stdout.toString().split("\n")) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    services.push({
      unit: parts[0]!,
      load: parts[1]!,
      active: parts[2]!,
      sub: parts[3]!,
      description: parts.slice(4).join(" "),
    });
  }
  return services;
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
