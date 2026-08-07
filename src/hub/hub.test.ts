import { expect, test, describe, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { loadConfig, publicServer } from "./config.ts";
import { MetricStore } from "./db.ts";
import type { SystemStats } from "../types.ts";

const tmp = (name: string) => `${import.meta.dir}/../../.test-${name}`;
const written: string[] = [];

async function writeConfig(name: string, body: unknown): Promise<string> {
  const path = tmp(`${name}.json`);
  await Bun.write(path, JSON.stringify(body));
  written.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(written.splice(0).map((p) => rm(p, { force: true })));
});

describe("config", () => {
  test("applies defaults", async () => {
    const path = await writeConfig("defaults", {
      servers: [{ id: "a", name: "A", driver: "local" }],
    });
    const config = await loadConfig(path);

    expect(config.port).toBe(3000);
    expect(config.host).toBe("127.0.0.1");
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.servers).toHaveLength(1);
  });

  test("clamps a too-aggressive poll interval", async () => {
    const path = await writeConfig("fast", { pollIntervalMs: 10, servers: [] });
    expect((await loadConfig(path)).pollIntervalMs).toBe(1000);
  });

  test("resolves env: token indirection", async () => {
    process.env.TEST_AGENT_TOKEN = "s3cret";
    const path = await writeConfig("env", {
      servers: [
        {
          id: "a",
          name: "A",
          driver: "agent",
          url: "http://10.0.0.1:9101",
          token: "env:TEST_AGENT_TOKEN",
        },
      ],
    });
    expect((await loadConfig(path)).servers[0]!.token).toBe("s3cret");
    delete process.env.TEST_AGENT_TOKEN;
  });

  test("rejects an agent server with no url", async () => {
    const path = await writeConfig("nourl", {
      servers: [{ id: "a", name: "A", driver: "agent" }],
    });
    expect(loadConfig(path)).rejects.toThrow(/requires 'url'/);
  });

  test("rejects duplicate ids", async () => {
    const path = await writeConfig("dupe", {
      servers: [
        { id: "a", name: "A", driver: "local" },
        { id: "a", name: "B", driver: "local" },
      ],
    });
    expect(loadConfig(path)).rejects.toThrow(/duplicate server id/);
  });

  test("rejects an unknown driver", async () => {
    const path = await writeConfig("driver", {
      servers: [{ id: "a", name: "A", driver: "telepathy" }],
    });
    expect(loadConfig(path)).rejects.toThrow(/must be 'local' or 'agent'/);
  });

  test("explains a missing file", async () => {
    expect(loadConfig(tmp("absent.json"))).rejects.toThrow(/config not found/);
  });

  test("publicServer strips the token", () => {
    const stripped = publicServer({
      id: "a",
      name: "A",
      driver: "agent",
      url: "http://x",
      token: "s3cret",
    });
    expect(JSON.stringify(stripped)).not.toContain("s3cret");
    expect("token" in stripped).toBe(false);
  });
});

function fakeStats(ts: number, cpu: number): SystemStats {
  return {
    hostname: "test",
    platform: "Linux",
    kernel: "test",
    uptimeSec: 100,
    loadavg: [0.5, 0.4, 0.3],
    cpu: { usage: cpu, cores: 4, perCore: [], model: null },
    mem: {
      total: 1000,
      used: 400,
      free: 600,
      available: 600,
      buffers: 0,
      cached: 0,
      swapTotal: 0,
      swapUsed: 0,
    },
    disks: [{ filesystem: "/dev/sda1", mount: "/", total: 500, used: 250, available: 250, usage: 0.5 }],
    net: [{ name: "eth0", rxBytes: 10, txBytes: 20, rxRate: 5, txRate: 6 }],
    temps: [],
    timestamp: ts,
  };
}

describe("MetricStore", () => {
  test("records, reads back, and prunes", () => {
    const store = new MetricStore(":memory:");
    const now = Date.now();

    store.record("srv", fakeStats(now - 1000, 0.25));
    store.record("srv", fakeStats(now, 0.5));
    store.record("other", fakeStats(now, 0.9));

    const rows = store.history("srv", now - 60_000);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cpu).toBe(0.25);
    // ordered oldest-first so charts can render without re-sorting
    expect(rows[1]!.ts).toBeGreaterThan(rows[0]!.ts);
    // rates and disk are summed across interfaces/mounts
    expect(rows[1]!.rxRate).toBe(5);
    expect(rows[1]!.diskTotal).toBe(500);

    // history is scoped per server
    expect(store.history("other", now - 60_000)).toHaveLength(1);

    // a sample older than the window is dropped
    store.record("srv", fakeStats(now - 48 * 3600_000, 0.1));
    expect(store.history("srv", 0)).toHaveLength(3);
    store.prune(24);
    expect(store.history("srv", 0)).toHaveLength(2);

    store.close();
  });

  test("events round-trip newest first", () => {
    const store = new MetricStore(":memory:");
    store.recordEvent("srv", "offline", "went away");
    store.recordEvent("srv", "online", "came back");

    const events = store.events(0);
    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe("online");
    expect(events[0]!.serverId).toBe("srv");

    store.close();
  });
});
