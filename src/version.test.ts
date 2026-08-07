import { expect, test, describe } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { collectSnapshot, startAgent } from "./agent/server.ts";
import { PROTOCOL, VERSION, versionInfo } from "./version.ts";

describe("version", () => {
  test("tracks package.json and looks like semver", () => {
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("agent health reports version and protocol", async () => {
    const server = startAgent({ port: 0, host: "127.0.0.1", token: null });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, role: "agent", version: VERSION, protocol: PROTOCOL });
    } finally {
      await server.stop(true);
    }
  });

  test("snapshots identify the agent that produced them", async () => {
    const snapshot = await collectSnapshot({ stats: false });
    expect(snapshot.agent).toEqual(versionInfo);
  });
});
