import type { HubConfig, ServerConfig } from "../types.ts";

/**
 * Config lives in servers.json next to the project. Tokens may be written
 * inline or, preferably, as "env:VAR_NAME" so the file stays committable.
 */

const DEFAULT_PATH = process.env.STATS_CONFIG ?? "./servers.json";

interface RawConfig {
  port?: number;
  host?: string;
  pollIntervalMs?: number;
  retentionHours?: number;
  dbPath?: string;
  token?: string | null;
  servers?: ServerConfig[];
}

/** Resolves "env:NAME" indirection; passes anything else through. */
function resolveSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("env:")) return process.env[value.slice(4)] ?? null;
  return value;
}

function validateServer(server: ServerConfig, index: number): string[] {
  const errors: string[] = [];
  const where = `servers[${index}]`;
  if (!server.id) errors.push(`${where}: missing 'id'`);
  if (!/^[a-zA-Z0-9_-]+$/.test(server.id ?? "")) {
    errors.push(`${where}: 'id' must be alphanumeric, dash or underscore (got '${server.id}')`);
  }
  if (server.driver !== "local" && server.driver !== "agent") {
    errors.push(`${where}: 'driver' must be 'local' or 'agent' (got '${server.driver}')`);
  }
  if (server.driver === "agent") {
    if (!server.url) {
      errors.push(`${where}: agent driver requires 'url'`);
    } else {
      try {
        new URL(server.url);
      } catch {
        errors.push(`${where}: 'url' is not a valid URL (got '${server.url}')`);
      }
    }
  }
  return errors;
}

export async function loadConfig(path = DEFAULT_PATH): Promise<HubConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `config not found at ${path}. Copy servers.example.json to servers.json to get started.`,
    );
  }

  let raw: RawConfig;
  try {
    raw = (await file.json()) as RawConfig;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }

  const servers = raw.servers ?? [];
  const errors = servers.flatMap(validateServer);

  const ids = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id)) errors.push(`duplicate server id '${server.id}'`);
    ids.add(server.id);
  }
  if (errors.length) throw new Error(`invalid ${path}:\n  - ${errors.join("\n  - ")}`);

  return {
    port: raw.port ?? 3000,
    host: raw.host ?? "127.0.0.1",
    pollIntervalMs: Math.max(raw.pollIntervalMs ?? 5000, 1000),
    retentionHours: raw.retentionHours ?? 24,
    dbPath: raw.dbPath ?? "./stats.db",
    token: resolveSecret(raw.token),
    servers: servers.map((s) => ({ ...s, token: resolveSecret(s.token) ?? undefined })),
  };
}

/** Strips secrets before a config object is sent to the browser. */
export function publicServer(server: ServerConfig): Omit<ServerConfig, "token"> {
  const { token: _token, ...rest } = server;
  return rest;
}
