#!/usr/bin/env bun
/**
 * Entry point for both roles:
 *
 *   bun index.ts hub                  # laptop: dashboard + API, polls every server
 *   bun index.ts agent --port 9101    # each server: read-only metrics endpoint
 */

import { startAgent } from "./src/agent/server.ts";
import { loadConfig } from "./src/hub/config.ts";
import { startHub } from "./src/hub/server.ts";
import { PROTOCOL, VERSION } from "./src/version.ts";

function flag(name: string): string | undefined {
  const args = process.argv.slice(3);
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline?.split("=").slice(1).join("=");
}

const usage = `stats ${VERSION} — server overview dashboard

Usage:
  bun index.ts hub    [--config servers.json] [--port 3000] [--host 127.0.0.1]
  bun index.ts agent  [--port 9101] [--host 0.0.0.0] [--token <token>]
  bun index.ts version

Environment:
  STATS_CONFIG        hub config path (default ./servers.json)
  STATS_AGENT_TOKEN   bearer token the agent requires
  STATS_LOG_DIRS      colon-separated dirs readable via kind=file (default /var/log)
  DOCKER_SOCKET       docker socket path (default /var/run/docker.sock)
`;

const role = process.argv[2];

switch (role) {
  case "version":
  case "--version":
  case "-v":
    console.log(`stats ${VERSION} (protocol ${PROTOCOL})`);
    break;

  case "agent": {
    const port = Number(flag("port") ?? process.env.STATS_AGENT_PORT ?? 9101);
    const host = flag("host") ?? "0.0.0.0";
    const token = flag("token") ?? process.env.STATS_AGENT_TOKEN ?? null;

    const server = startAgent({ port, host, token });
    console.log(`stats agent ${VERSION} listening on http://${host}:${port}`);
    if (!token) {
      console.warn(
        "warning: no token set — this agent is unauthenticated. Set STATS_AGENT_TOKEN " +
          "or bind it to a private interface.",
      );
    }
    process.on("SIGINT", () => {
      void server.stop(true);
      process.exit(0);
    });
    break;
  }

  case "hub": {
    const config = await loadConfig(flag("config"));
    const portOverride = flag("port");
    const hostOverride = flag("host");
    if (portOverride) config.port = Number(portOverride);
    if (hostOverride) config.host = hostOverride;

    startHub(config);
    console.log(`stats hub ${VERSION} listening on http://${config.host}:${config.port}`);
    console.log(
      `watching ${config.servers.length} server(s): ${config.servers.map((s) => s.id).join(", ")}`,
    );
    break;
  }

  default:
    console.log(usage);
    process.exit(role ? 1 : 0);
}
