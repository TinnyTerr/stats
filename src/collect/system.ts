import { $ } from "bun";
import { readFile } from "node:fs/promises";
import os from "node:os";
import type {
  CpuStats,
  DiskMount,
  MemStats,
  NetInterface,
  SystemStats,
  TempSensor,
} from "../types.ts";

/**
 * Linux /proc + /sys collectors. Rates (cpu usage, network throughput) are
 * deltas, so this module keeps the previous raw sample in memory. The first
 * call after start takes an extra ~200ms to prime that state.
 */

type CpuTimes = { idle: number; total: number };

let prevCpu: { all: CpuTimes; cores: CpuTimes[] } | null = null;
let prevNet: { at: number; ifaces: Map<string, { rx: number; tx: number }> } | null = null;

async function readProc(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

function parseCpuLine(line: string): CpuTimes {
  // cpu  user nice system idle iowait irq softirq steal guest guest_nice
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
  const total = parts.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
  return { idle, total };
}

function delta(now: CpuTimes, prev: CpuTimes | undefined): number {
  if (!prev) return 0;
  const totalDiff = now.total - prev.total;
  const idleDiff = now.idle - prev.idle;
  if (totalDiff <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - idleDiff / totalDiff));
}

async function sampleCpuRaw() {
  const text = await readProc("/proc/stat");
  const lines = text.split("\n").filter((l) => l.startsWith("cpu"));
  const allLine = lines.find((l) => /^cpu\s/.test(l));
  const coreLines = lines.filter((l) => /^cpu\d+\s/.test(l));
  return {
    all: allLine ? parseCpuLine(allLine) : { idle: 0, total: 0 },
    cores: coreLines.map(parseCpuLine),
  };
}

let cpuModel: string | null | undefined;

async function getCpuModel(): Promise<string | null> {
  if (cpuModel !== undefined) return cpuModel;
  try {
    const text = await readProc("/proc/cpuinfo");
    const line = text.split("\n").find((l) => l.startsWith("model name"));
    cpuModel = line ? (line.split(":")[1]?.trim() ?? null) : null;
  } catch {
    cpuModel = null;
  }
  return cpuModel;
}

export async function collectCpu(): Promise<CpuStats> {
  let sample = await sampleCpuRaw();
  if (!prevCpu) {
    // Prime the delta so the very first reading isn't a meaningless zero.
    prevCpu = sample;
    await Bun.sleep(200);
    sample = await sampleCpuRaw();
  }
  const prev = prevCpu;
  prevCpu = sample;
  return {
    usage: delta(sample.all, prev.all),
    cores: sample.cores.length || os.cpus().length,
    perCore: sample.cores.map((c, i) => delta(c, prev.cores[i])),
    model: await getCpuModel(),
  };
}

export async function collectMem(): Promise<MemStats> {
  const text = await readProc("/proc/meminfo");
  const kv = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [key, rest] = line.split(":");
    if (!key || !rest) continue;
    // values are in kB
    kv.set(key, Number(rest.trim().split(/\s+/)[0]) * 1024);
  }
  const total = kv.get("MemTotal") ?? 0;
  const free = kv.get("MemFree") ?? 0;
  const available = kv.get("MemAvailable") ?? free;
  const swapTotal = kv.get("SwapTotal") ?? 0;
  return {
    total,
    used: total - available,
    free,
    available,
    buffers: kv.get("Buffers") ?? 0,
    cached: kv.get("Cached") ?? 0,
    swapTotal,
    swapUsed: swapTotal - (kv.get("SwapFree") ?? 0),
  };
}

/** Pseudo filesystems that would just be noise on a dashboard. */
const SKIP_FS = new Set([
  "tmpfs",
  "devtmpfs",
  "squashfs",
  "overlay",
  "efivarfs",
  "ramfs",
  "none",
]);

export async function collectDisks(): Promise<DiskMount[]> {
  // -P forces one line per mount, -B1 gives raw bytes.
  const out = await $`df -PB1 -T`.nothrow().quiet();
  if (out.exitCode !== 0) return [];
  const disks: DiskMount[] = [];
  for (const line of out.stdout.toString().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7) continue;
    const [filesystem, type, totalRaw, usedRaw, availRaw] = parts;
    const mount = parts.slice(6).join(" ");
    if (!filesystem || !type || !mount) continue;
    if (SKIP_FS.has(type)) continue;
    if (mount.startsWith("/snap/") || mount.startsWith("/var/lib/docker/")) continue;
    const total = Number(totalRaw);
    const used = Number(usedRaw);
    if (!Number.isFinite(total) || total === 0) continue;
    disks.push({
      filesystem,
      mount,
      total,
      used,
      available: Number(availRaw) || 0,
      usage: used / total,
    });
  }
  return disks;
}

export async function collectNet(): Promise<NetInterface[]> {
  const text = await readProc("/proc/net/dev");
  const now = Date.now();
  const current = new Map<string, { rx: number; tx: number }>();
  const result: NetInterface[] = [];

  for (const line of text.split("\n").slice(2)) {
    const [namePart, rest] = line.split(":");
    if (!namePart || !rest) continue;
    const name = namePart.trim();
    if (name === "lo" || name.startsWith("veth") || name.startsWith("br-")) continue;
    const cols = rest.trim().split(/\s+/).map(Number);
    const rx = cols[0] ?? 0;
    const tx = cols[8] ?? 0;
    current.set(name, { rx, tx });

    const prev = prevNet?.ifaces.get(name);
    const elapsed = prevNet ? (now - prevNet.at) / 1000 : 0;
    // Counters wrap or reset on interface restart; treat negatives as no data.
    const rate = (cur: number, before: number) =>
      prev && elapsed > 0 && cur >= before ? (cur - before) / elapsed : null;

    result.push({
      name,
      rxBytes: rx,
      txBytes: tx,
      rxRate: rate(rx, prev?.rx ?? 0),
      txRate: rate(tx, prev?.tx ?? 0),
    });
  }

  prevNet = { at: now, ifaces: current };
  return result;
}

export async function collectTemps(): Promise<TempSensor[]> {
  const temps: TempSensor[] = [];
  const glob = new Bun.Glob("thermal_zone*/temp");
  try {
    for await (const rel of glob.scan({ cwd: "/sys/class/thermal", onlyFiles: true })) {
      const zone = rel.split("/")[0]!;
      const raw = await Bun.file(`/sys/class/thermal/${rel}`).text().catch(() => null);
      if (raw === null) continue;
      const milli = Number(raw.trim());
      if (!Number.isFinite(milli)) continue;
      const type = await Bun.file(`/sys/class/thermal/${zone}/type`)
        .text()
        .then((t) => t.trim())
        .catch(() => zone);
      temps.push({ name: type, celsius: milli / 1000 });
    }
  } catch {
    // no thermal zones (containers, VMs) — not an error
  }
  return temps;
}

let kernel: string | null = null;

export async function collectSystem(): Promise<SystemStats> {
  if (kernel === null) {
    kernel = (await readProc("/proc/version").catch(() => "")).split(" ").slice(0, 3).join(" ");
  }
  const uptimeText = await readProc("/proc/uptime").catch(() => "0");
  const loadText = await readProc("/proc/loadavg").catch(() => "0 0 0");
  const load = loadText.trim().split(/\s+/).map(Number);

  const [cpu, mem, disks, net, temps] = await Promise.all([
    collectCpu(),
    collectMem(),
    collectDisks(),
    collectNet(),
    collectTemps(),
  ]);

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    kernel,
    uptimeSec: Number(uptimeText.trim().split(/\s+/)[0]) || 0,
    loadavg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    cpu,
    mem,
    disks,
    net,
    temps,
    timestamp: Date.now(),
  };
}
