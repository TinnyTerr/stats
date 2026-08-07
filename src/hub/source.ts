import type { LogLine, LogQuery, ServerConfig, Snapshot } from "../types.ts";
import { collectSnapshot } from "../agent/server.ts";
import { streamLogs } from "../collect/logs.ts";

/**
 * A Source is how the hub reaches one server. `local` runs the collectors
 * in-process (so the laptop can watch itself with no agent); `agent` speaks
 * HTTP to a remote agent. Adding an ssh driver later means implementing this
 * interface and nothing else.
 */
export interface Source {
  snapshot(signal?: AbortSignal): Promise<Snapshot>;
  logs(query: LogQuery, signal?: AbortSignal): AsyncGenerator<LogLine>;
}

class LocalSource implements Source {
  snapshot(): Promise<Snapshot> {
    return collectSnapshot();
  }
  logs(query: LogQuery, signal?: AbortSignal): AsyncGenerator<LogLine> {
    return streamLogs(query, true, signal);
  }
}

class AgentSource implements Source {
  constructor(
    private base: string,
    private token: string | null,
  ) {
    this.base = base.replace(/\/+$/, "");
  }

  private headers(): HeadersInit {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  async snapshot(signal?: AbortSignal): Promise<Snapshot> {
    const res = await fetch(`${this.base}/api/snapshot`, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok) {
      throw new Error(`agent responded ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as Snapshot;
  }

  /**
   * Proxies the agent's SSE log stream back into an async iterable, so hub
   * callers can't tell a remote server from a local one.
   */
  async *logs(query: LogQuery, signal?: AbortSignal): AsyncGenerator<LogLine> {
    const params = new URLSearchParams({
      kind: query.kind,
      target: query.target,
      tail: String(query.tail),
    });
    const res = await fetch(`${this.base}/api/logs/stream?${params}`, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`agent responded ${res.status} for log stream`);
    }

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let split: number;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (frame.startsWith(":")) continue; // heartbeat

          let event = "message";
          const dataLines: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          const payload = JSON.parse(dataLines.join("\n"));
          if (event === "error") throw new Error(payload?.message ?? "agent log stream error");
          if (event === "log") yield payload as LogLine;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

export function createSource(config: ServerConfig): Source {
  switch (config.driver) {
    case "local":
      return new LocalSource();
    case "agent":
      return new AgentSource(config.url!, config.token ?? null);
  }
}
