import type { Container, ContainerPort } from "../types.ts";

/**
 * Talks to the Docker Engine API over its unix socket via Bun's `fetch({ unix })`.
 * No docker CLI required, which also means it works fine inside a container that
 * has the socket bind-mounted.
 */

const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const API = "v1.43";

export class DockerUnavailable extends Error {}

async function dockerFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`http://localhost/${API}${path}`, { ...init, unix: SOCKET });
  } catch (err) {
    throw new DockerUnavailable(
      `docker socket ${SOCKET} unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    const res = await dockerFetch("/_ping");
    return res.ok;
  } catch {
    return false;
  }
}

interface RawContainer {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Created: number;
  Ports?: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[];
  Labels?: Record<string, string>;
}

function mapPorts(raw: RawContainer["Ports"]): ContainerPort[] {
  const seen = new Set<string>();
  const ports: ContainerPort[] = [];
  for (const p of raw ?? []) {
    // Docker lists IPv4 and IPv6 bindings separately; collapse the duplicates.
    const key = `${p.PrivatePort}/${p.Type}/${p.PublicPort ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({
      ip: p.IP ?? null,
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort ?? null,
      type: p.Type,
    });
  }
  return ports;
}

/** Health and restart count only exist on the inspect endpoint, not the list. */
async function inspectExtras(
  id: string,
): Promise<{ health: string | null; restartCount: number | null }> {
  try {
    const res = await dockerFetch(`/containers/${id}/json`);
    if (!res.ok) return { health: null, restartCount: null };
    const json = (await res.json()) as {
      State?: { Health?: { Status?: string } };
      RestartCount?: number;
    };
    return {
      health: json.State?.Health?.Status ?? null,
      restartCount: json.RestartCount ?? null,
    };
  } catch {
    return { health: null, restartCount: null };
  }
}

interface RawStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number } };
}

/**
 * One-shot resource sample. `stream=false` makes the engine return a single
 * JSON document; it still costs ~1s server-side because the engine needs two
 * internal samples to compute the CPU delta, so callers should run these in
 * parallel and only for running containers.
 */
async function containerStats(
  id: string,
): Promise<{ cpu: number | null; memUsage: number | null; memLimit: number | null }> {
  const empty = { cpu: null, memUsage: null, memLimit: null };
  try {
    const res = await dockerFetch(`/containers/${id}/stats?stream=false&one-shot=false`);
    if (!res.ok) return empty;
    const s = (await res.json()) as RawStats;

    const cpuDelta =
      (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
    const cpus =
      s.cpu_stats?.online_cpus ?? s.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
    const cpu = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus : 0;

    // Match `docker stats`: page cache is reclaimable, so exclude it.
    const usage = s.memory_stats?.usage ?? null;
    const inactive = s.memory_stats?.stats?.inactive_file ?? 0;
    return {
      cpu,
      memUsage: usage === null ? null : Math.max(0, usage - inactive),
      memLimit: s.memory_stats?.limit ?? null,
    };
  } catch {
    return empty;
  }
}

export async function collectContainers(opts: { stats?: boolean } = {}): Promise<Container[]> {
  const res = await dockerFetch("/containers/json?all=true");
  if (!res.ok) {
    throw new DockerUnavailable(`docker returned ${res.status} listing containers`);
  }
  const raw = (await res.json()) as RawContainer[];

  return await Promise.all(
    raw.map(async (c): Promise<Container> => {
      const running = c.State === "running";
      const [extras, resources] = await Promise.all([
        inspectExtras(c.Id),
        opts.stats !== false && running
          ? containerStats(c.Id)
          : Promise.resolve({ cpu: null, memUsage: null, memLimit: null }),
      ]);
      const labels = c.Labels ?? {};
      return {
        id: c.Id,
        name: (c.Names[0] ?? c.Id).replace(/^\//, ""),
        image: c.Image,
        state: c.State,
        status: c.Status,
        health: extras.health,
        createdAt: c.Created * 1000,
        ports: mapPorts(c.Ports),
        labels,
        project: labels["com.docker.compose.project"] ?? null,
        restartCount: extras.restartCount,
        ...resources,
      };
    }),
  );
}

/**
 * Raw log stream for a container. Docker multiplexes stdout/stderr into a
 * framed protocol unless the container was started with a TTY, in which case
 * the body is plain bytes — the `Content-Type` tells us which.
 */
export async function containerLogStream(
  target: string,
  opts: { tail: number; follow: boolean; signal?: AbortSignal },
): Promise<{ body: ReadableStream<Uint8Array>; multiplexed: boolean }> {
  const params = new URLSearchParams({
    stdout: "1",
    stderr: "1",
    timestamps: "1",
    tail: String(opts.tail),
    follow: opts.follow ? "1" : "0",
  });
  const res = await dockerFetch(`/containers/${encodeURIComponent(target)}/logs?${params}`, {
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new DockerUnavailable(`docker returned ${res.status} for logs of ${target}`);
  }
  return {
    body: res.body,
    multiplexed: res.headers.get("content-type") === "application/vnd.docker.multiplexed-stream",
  };
}
