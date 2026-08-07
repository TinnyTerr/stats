# stats

A single-pane overview of your servers, meant to live full-screen on a laptop
you're using as a status display.

Two roles, one codebase:

- **hub** — runs on the laptop. Polls every configured server, keeps rolling
  history in SQLite, serves the dashboard and its API.
- **agent** — runs on each server. Read-only HTTP endpoints for system stats,
  Docker containers, processes, systemd services, listening ports and log tails.

```
laptop (hub :3000)  ──poll──> server-a:9101  (agent)
   │  dashboard + API ──poll──> server-b:9101  (agent)
   └── "local" driver ────────> itself, in-process, no agent needed
```

## Quick start

```bash
bun install
cp servers.example.json servers.json   # then edit it
bun run hub                            # http://127.0.0.1:3000
```

`bun run dev` does the same with hot reload for the frontend.

On each remote server:

```bash
git clone <this repo> /opt/stats && cd /opt/stats && bun install
STATS_AGENT_TOKEN=$(openssl rand -hex 32) bun run agent --port 9101
```

See `deploy/stats-agent.service` for a hardened systemd unit.

## Versioning

One version for the whole repo — hub and agent ship together, so
`package.json`'s `version` is the only source of truth (`src/version.ts` re-exports
it). Alongside it sits `protocol`, the agent↔hub wire contract, which is bumped
only when an older peer would misread a newer one. See `CHANGELOG.md`.

```bash
bun index.ts version          # stats 0.1.0 (protocol 1)
curl -s :9101/api/health      # {"ok":true,"role":"agent","version":"0.1.0","protocol":1,...}
```

Every snapshot carries the agent's version, so `/api/servers` exposes
`agentVersion` and `agentProtocol` per server. The dashboard tags any server
whose agent doesn't match the hub, and the hub logs a warning once per server on
a protocol mismatch. Mismatches are reported, not enforced — the snapshot shape
is additive, so a slightly stale agent keeps working.

Releasing: bump `version` in `package.json`, add a `CHANGELOG.md` entry, tag it.

## Configuration

`servers.json`:

```jsonc
{
  "port": 3000,
  "host": "127.0.0.1",        // 0.0.0.0 to reach the dashboard from other devices
  "pollIntervalMs": 5000,
  "retentionHours": 24,       // history window; older samples are pruned
  "dbPath": "./stats.db",
  "token": null,              // optional bearer token for the hub itself

  "servers": [
    { "id": "laptop", "name": "This laptop", "driver": "local" },
    {
      "id": "web-1",
      "name": "Web 1",
      "driver": "agent",
      "url": "http://10.0.0.5:9101",
      "token": "env:WEB1_TOKEN",   // read from the environment, not the file
      "tags": ["prod"],
      "notes": "nginx + compose stack"
    }
  ]
}
```

Any `token` field may be written as `"env:VAR_NAME"` so the config stays
committable. `id` must be unique and alphanumeric.

## API

Hub (`:3000`), all under a bearer token when `token` is set:

| Route | Purpose |
| --- | --- |
| `GET /api/health` | liveness, no auth |
| `GET /api/servers` | summary of every server — what the grid renders |
| `GET /api/servers/:id` | summary plus the full snapshot |
| `GET /api/servers/:id/stats` | cpu, memory, disks, network, temps |
| `GET /api/servers/:id/containers` | Docker containers, grouped by compose project |
| `GET /api/servers/:id/processes` | top processes by CPU |
| `GET /api/servers/:id/services` | running systemd units |
| `GET /api/servers/:id/ports` | TCP/UDP listeners and owning process |
| `GET /api/servers/:id/history?minutes=60` | time series for charts |
| `GET /api/servers/:id/logs/stream?kind=&target=` | live log tail (SSE) |
| `GET /api/events?minutes=1440` | online/offline transitions |
| `POST /api/refresh` | poll immediately instead of waiting for the interval |
| `WS /ws` | pushes each server's summary as it's polled |

Agent (`:9101`) mirrors the collector routes plus `GET /api/snapshot`, which
returns everything in one round trip — that's what the hub actually calls.

### Log sources

`kind` is one of:

- `docker` — `target` is a container name or id
- `journal` — `target` is a systemd unit, e.g. `nginx.service`
- `file` — `target` is an absolute path, restricted to `STATS_LOG_DIRS`
  (default `/var/log`)

Both `/api/logs` (last N lines, then closes) and `/api/logs/stream` (SSE, tails
live) accept the same parameters.

## Security notes

- The agent is **read-only**. There is no endpoint that starts, stops, or execs
  anything, so a leaked token discloses metrics and logs and nothing more.
- Set `STATS_AGENT_TOKEN` on every agent, or bind agents to a private interface
  (Tailscale, WireGuard, LAN). Without a token they are unauthenticated.
- Agent traffic is plain HTTP. Run it over a private network rather than the
  public internet, or put a TLS proxy in front.
- The `file` log source is allowlisted to `/var/log` precisely so a token can't
  be turned into arbitrary file read.
- The hub binds to `127.0.0.1` by default.

## Environment

| Variable | Role | Default |
| --- | --- | --- |
| `STATS_CONFIG` | hub | `./servers.json` |
| `STATS_AGENT_TOKEN` | agent | none (unauthenticated) |
| `STATS_AGENT_PORT` | agent | `9101` |
| `STATS_LOG_DIRS` | agent | `/var/log` |
| `DOCKER_SOCKET` | both | `/var/run/docker.sock` |

## Layout

```
index.ts              CLI: `hub`, `agent` and `version` roles
src/version.ts        release version + wire protocol number
src/types.ts          wire types shared by both sides and the frontend
src/http.ts           JSON, bearer auth, SSE helpers
src/collect/          system.ts, docker.ts, processes.ts, logs.ts
src/agent/server.ts   the read-only agent API
src/hub/config.ts     servers.json loading and validation
src/hub/db.ts         SQLite metric history
src/hub/source.ts     local | agent drivers behind one interface
src/hub/poller.ts     poll loop, online/offline tracking
src/hub/server.ts     dashboard API, WebSocket, static frontend
web/                  React dashboard (index.html, frontend.tsx, api.ts)
deploy/               systemd unit for the agent
```

Adding a transport (ssh, for instance) means implementing `Source` in
`src/hub/source.ts` and nothing else.

## Development

```bash
bun test          # collectors, config validation, metric store
bun run typecheck
```

Collectors degrade rather than fail: a host with no Docker, no systemd, or no
thermal sensors still reports everything else, and the missing collector's error
shows up in `collectorErrors` on that server's card.

## Notes

Linux-only — the collectors read `/proc`, `/sys`, `df`, `ps`, `ss`, `systemctl`
and the Docker socket directly.
