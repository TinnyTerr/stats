# stats

A single-pane view of your servers — what they're doing, what they're running,
and a shell into any of them — meant to live full-screen on a laptop you're
using as a status display.

Two roles, one codebase, one socket between them:

- **hub** — runs on the laptop. Listens; never dials out. Keeps rolling history
  in SQLite, serves the dashboard, and relays control down to the nodes.
- **node** — runs on each server. Dials the hub over a WebSocket and streams
  telemetry up it: system metrics, Docker, systemd, processes, ports, and the
  projects it has been told to run.

```
server-a  ──ws──▶ ┐
server-b  ──ws──▶ ├── laptop (hub :3000) ──▶ dashboard
server-c  ──ws──▶ ┘        │
                        stats.db
```

Nodes connect outward, so a server behind NAT, a firewall or a dynamic address
needs no inbound rule and no fixed address — only the hub does.

## What it does

- **Live metrics** — CPU (per core), memory, swap, disks, network rates,
  temperatures, load, uptime; a rolling history that survives a hub restart.
- **Host identity, spelled out** — distribution and version from os-release and
  lsb-release, kernel, architecture, virtualisation, init system, systemd
  version, machine id, Docker version.
- **systemd, formatted** — units with load/active/sub kept apart rather than
  flattened, failed units surfaced first, `systemctl show` in a drawer, and
  start/stop/restart/reload from the dashboard.
- **Docker** — containers grouped by compose project, health and restart counts,
  CPU and memory, start/stop/restart, log tails.
- **Projects** — a file on each node declares what that host runs; the node
  supervises those processes and reports them as first-class things. See below.
- **Logs** — live tails from journald, Docker, files, or a supervised process,
  streamed over the same socket.
- **Terminals** — a real pty on any node (or inside a container), rendered with
  xterm.js. Job control, colour and curses apps all work.

## Install

`stats` ships as one self-contained executable — the Bun runtime, the hub, the
node and the dashboard are all inside it — so servers need nothing installed
first.

Start with the hub, on the machine that shows the dashboard. It generates the
token the nodes will need and prints the exact command to run on them:

```bash
curl -fsSL https://git.tinnyterr.com/tinnyterr/stats/raw/branch/main/install.sh | \
  sudo sh -s -- --hub --host 0.0.0.0
```

Then on each server you want to watch:

```bash
curl -fsSL .../install.sh | \
  sudo sh -s -- --node --hub-url ws://laptop.lan:3000 --token <token>
```

That drops the binary at `/usr/local/bin/stats`, writes `/etc/stats/node.env`
(mode 0600), starts `stats-node.service`, and the node appears on the dashboard
within a few seconds.

The installer picks the right build for the machine — x86-64 or arm64, glibc or
musl, and a no-AVX2 "baseline" build for older CPUs — verifies it against
`SHA256SUMS`, and checks it actually runs before putting it in place. Useful
flags: `--from dist` (install a local build), `--no-terminal`, `--no-control`,
`--id`, `--name`, `--port`, `--host`, `--prefix`, `--no-service`,
`--uninstall [--purge]`, `--help`.

Re-running it upgrades in place; configs and tokens are never overwritten.

## Quick start (from source)

```bash
bun install
bun run hub                                  # http://127.0.0.1:3000
bun run node -- --hub ws://127.0.0.1:3000    # in another terminal
```

`bun run dev` runs the hub with hot reload for the frontend. A hub with no
config file at all starts on `127.0.0.1:3000` and accepts any node.

## Projects: telling a node what to run

The point of the projects file is that "is the app up?" stops being a question
you answer by reading `ps`. A node **runs** what the file declares, restarts it
under a policy, keeps its logs, samples its CPU and memory, and reports the lot
as a named thing on the dashboard with start/stop/restart buttons.

It lives at `/etc/stats/projects.json`, or as any number of files in
`/etc/stats/projects.d/*.json`, or wherever `--projects` points.

```jsonc
{
  "$schema": "http://your-hub:3000/schema/projects.schema.json",
  "version": 1,
  "projects": [
    {
      "id": "billing-api",
      "name": "Billing API",
      "cwd": "/srv/billing",
      "envFiles": [".env"],
      "tags": ["prod"],
      "url": "https://billing.example.com",

      "processes": [
        {
          "id": "web",
          "command": ["bun", "run", "start"],
          "restart": "always",
          "user": "billing",
          "healthcheck": { "type": "http", "url": "http://127.0.0.1:3000/health" }
        },
        { "id": "worker", "command": ["bun", "run", "worker"], "stopSignal": "SIGINT" }
      ],

      // things this project owns but doesn't run, grouped onto its card
      "watch": {
        "systemd": ["nginx.service"],
        "containers": ["billing-postgres"],
        "ports": [3000]
      }
    }
  ]
}
```

The full schema — every field, every default — is
[`schema/projects.schema.json`](schema/projects.schema.json), and each hub
serves it at `/schema/projects.schema.json` so editors can validate against the
hub you actually run. `projects.example.json` is a worked example.

Check a file before restarting anything:

```bash
stats check --projects /etc/stats/projects.json
```

Notes worth knowing:

- `restart` is `always`, `on-failure` (default) or `never`. Restarts back off
  linearly up to 30s, and `maxRestarts` inside `restartWindowSec` gives up
  rather than flapping forever — the process goes `fatal` and says why.
- A healthcheck (`http`, `tcp` or `command`) never restarts anything; it marks
  the process unhealthy so the dashboard can show it.
- `user:` needs the node to run as root; it drops privileges with `setpriv`,
  falling back to `runuser`.
- A project with no processes is fine — it just groups the units, containers
  and ports it `watch`es.
- Reloading the file (a button on the dashboard) adopts new definitions without
  restarting processes that didn't change.

## Configuration

The hub reads `hub.json` (`--config`, or `STATS_CONFIG`, default `./hub.json`).
Every field is optional:

```jsonc
{
  "port": 3000,
  "host": "127.0.0.1",          // 0.0.0.0 to accept nodes and remote browsers

  "token": null,                // bearer token for the dashboard
  "nodeToken": "env:STATS_NODE_TOKEN",   // token nodes must present
  "allowUnknownNodes": true,    // false: only ids listed in "nodes" may join

  "dbPath": "./stats.db",
  "retentionHours": 24,
  "telemetryIntervalMs": 3000,  // handed to every node when it connects

  "terminal": true,             // hub-side switch for shells
  "embeddedNode": false,        // run a node in-process for the hub's own host

  "nodes": [                    // optional per-node overrides
    { "id": "web-1", "name": "Web 1", "tags": ["prod"], "notes": "nginx" }
  ]
}
```

A node is configured by flags, environment, or `/etc/stats/agent.json` — flags
win, then environment, then the file:

```bash
stats node --hub ws://hub.lan:3000 --token secret \
           --id web-1 --name "Web 1" --tags prod,docker \
           --projects /etc/stats/projects.json
```

Any `token` in `hub.json` may be written `"env:VAR_NAME"` so the config stays
committable. A node's id defaults to `/etc/machine-id` — stable across reboots
and address changes — and the hub keys everything on it.

## The wire protocol

One binary framing carries everything, on both links (node⇄hub and
browser⇄hub):

```
[1 byte]  version
[1 byte]  message type   (0x01 telemetry, 0x02 control_req, 0x03 control_resp,
                          0x04 ack, 0x05 error, 0x06 stream_data, 0x07 stream_end,
                          0x08 hello, 0x09 welcome, 0x0a ping, 0x0b pong)
[2 bytes] flags           (0x1 compressed, 0x2 requires_ack, 0x4 binary)
[4 bytes] correlation id  (0 for telemetry, non-zero for control req/resp pairs)
[4 bytes] payload length
[N bytes] payload
```

Multi-byte fields are big-endian; one frame per WebSocket message. Payloads are
UTF-8 JSON unless `binary` is set, in which case they're opaque bytes belonging
to the stream named by the correlation id — that's how terminal I/O travels.
Payloads over 1 KiB are gzipped and flagged.

Correlation ids are split by parity: the hub allocates odd ids on every link it
terminates, nodes and browsers allocate even ones, so a request in flight one
way can never be confused with one going the other. A control request that
opens a stream keeps its id alive in both directions until either side sends
`stream_end`.

Control actions a hub sends a node: `snapshot`, `facts.refresh`, `logs.tail`,
`terminal.open` / `.resize` / `.close`, `unit.show`, `unit.action`,
`container.action`, `projects.list`, `projects.reload`, `project.action`. A
browser sends the same actions with a `nodeId`, plus the hub's own: `nodes`,
`node`, `history`, `events`, `info`, `node.forget`.

## HTTP API

The dashboard uses the protocol above, but a read-only JSON mirror exists for
curl and scripts (all under the hub's `token` when one is set):

| Route | Purpose |
| --- | --- |
| `GET /api/health` | liveness, no auth |
| `GET /api/nodes` | summary of every known node |
| `GET /api/nodes/:id` | summary plus the last full telemetry frame |
| `GET /api/nodes/:id/history?minutes=60` | time series for charts |
| `GET /api/events?minutes=1440` | connections, crashes, failed units |
| `GET /schema/projects.schema.json` | the projects schema |
| `WS /node` | where nodes connect |
| `WS /ws` | where the dashboard connects |

## Security notes

This is the part that changed most from 0.1, so read it before rolling it out.

- **A node is no longer read-only.** By default it will open a shell and
  start/stop projects, units and containers on request. Both are node-side
  switches: `--no-terminal` and `--no-control` (or `STATS_TERMINAL=0`,
  `STATS_CONTROL=0`) refuse them outright, and the hub's `terminal: false` can
  narrow it further but never widen it.
- **Whoever can reach the dashboard can do those things.** Set `token` in
  `hub.json` if the hub isn't on localhost.
- **Set `nodeToken`.** Without one, any host that can reach the hub can
  register as a node and appear on your dashboard. Set
  `allowUnknownNodes: false` to accept only ids you've listed.
- Terminals and supervised processes run as the user the node runs as. The
  packaged unit uses an unprivileged `stats` user; running it as root is what
  makes `user:` in projects and unit control work, and is equivalent to handing
  out a root shell. Choose deliberately.
- Traffic is plain WebSocket. Run it over a private network (Tailscale,
  WireGuard, LAN) or put a TLS proxy in front and point nodes at `wss://`.
- The `file` log source is allowlisted to `STATS_LOG_DIRS` (default `/var/log`)
  so a token can't be turned into arbitrary file read.
- The hub binds to `127.0.0.1` by default, which accepts no nodes at all.

## Environment

| Variable | Role | Default |
| --- | --- | --- |
| `STATS_CONFIG` | hub | `./hub.json` |
| `STATS_AGENT_CONFIG` | node | `/etc/stats/agent.json` |
| `STATS_HUB` | node | none (required) |
| `STATS_NODE_TOKEN` | node | none |
| `STATS_NODE_ID` | node | `/etc/machine-id`, else hostname |
| `STATS_NODE_NAME` | node | hostname |
| `STATS_TAGS` | node | none |
| `STATS_INTERVAL` | node | `3000` |
| `STATS_TERMINAL` | node | `1` |
| `STATS_CONTROL` | node | `1` |
| `STATS_PROJECTS` | node | `/etc/stats/projects.json`, `/etc/stats/projects.d` |
| `STATS_LOG_DIRS` | node | `/var/log` |
| `DOCKER_SOCKET` | node | `/var/run/docker.sock` |

## Building executables

```bash
bun run build                          # every Linux target, into dist/
bun run build:host                     # just this machine's
bun run build --targets linux-arm64    # one of them
bun run build --all                    # Linux + macOS (hub only)
```

| Asset | Runs on |
| --- | --- |
| `stats-linux-x64` | glibc x86-64 with AVX2 — most servers since ~2013 |
| `stats-linux-x64-baseline` | glibc x86-64 without AVX2 — old CPUs, some VPS hosts |
| `stats-linux-x64-musl` | Alpine x86-64 |
| `stats-linux-x64-musl-baseline` | Alpine x86-64 without AVX2 |
| `stats-linux-arm64` | glibc arm64 — Pi 4/5 (64-bit), Graviton, Ampere |
| `stats-linux-arm64-musl` | Alpine arm64 |

Each is built with `bun build --compile --minify --bytecode` and
`--production`, which strips the dev-only hot-reload path and bundles React's
production build. Bytecode is why `index.ts` keeps its work inside `main()` —
the flag needs an entry point free of top-level await.

Alongside the binaries the build writes gzipped copies (~40 MB, what the
installer prefers), `SHA256SUMS` and `manifest.json`. Cross-compiling downloads
the matching Bun runtime once per target, so the first build needs network
access.

macOS builds exist under `--all` and can run the hub, but never a node: every
collector reads `/proc`, `/sys`, `ss`, `systemctl` or the Docker socket.

## Versioning

One version for the whole repo — hub and node ship together, so
`package.json`'s `version` is the only source of truth (`src/version.ts`
re-exports it). Alongside it sits `protocol`, which is both the version byte in
every frame and the number both roles report. See `CHANGELOG.md`.

```bash
bun index.ts version          # stats 0.2.0 (protocol 2)
curl -s :3000/api/health      # {"ok":true,"role":"hub","version":"0.2.0","protocol":2,...}
```

Every node reports its version, so `/api/nodes` exposes `version` and
`protocol` per node; the hub logs a warning when a node's protocol differs from
its own. Mismatches are reported, not enforced — payloads are additive, so a
slightly stale node keeps working.

## Layout

```
index.ts                CLI: `hub`, `node`, `check`, `version`
src/version.ts          release version + wire protocol number
src/types.ts            every type that crosses the wire
src/http.ts             the little HTTP that's left: health, JSON mirror, auth
src/proto/frame.ts      the binary frame codec
src/proto/messages.ts   payload shapes and control action names
src/proto/link.ts       PeerLink: correlation, streams, acks, heartbeats
src/collect/            system.ts, facts.ts, systemd.ts, docker.ts,
                        processes.ts, logs.ts
src/agent/agent.ts      the node: dial, telemetry loop, control dispatch
src/agent/config.ts     node configuration and hub URL normalisation
src/agent/projects.ts   projects file loading and validation
src/agent/supervisor.ts runs and watches declared processes
src/agent/terminal.ts   pty sessions
src/hub/config.ts       hub.json loading
src/hub/db.ts           SQLite history, events and known nodes
src/hub/registry.ts     who's connected, and the alerts derived from telemetry
src/hub/server.ts       node and browser endpoints, and the relay between them
web/                    React dashboard (link.ts, panels.tsx, terminal.tsx, …)
schema/                 the projects JSON Schema
scripts/build.ts        cross-compiles the standalone binaries into dist/
install.sh              download/verify/install + systemd units, either role
deploy/                 systemd units, for installing by hand
```

## Development

```bash
bun test          # protocol, supervisor, collectors, config, hub↔node e2e
bun run typecheck
```

The end-to-end tests start a real hub, connect a real node to it over a real
WebSocket, and drive it the way the browser does — including opening a pty and
checking `stty size` after a resize.

Collectors degrade rather than fail: a host with no Docker, no systemd or no
thermal sensors still reports everything else, and the missing collector's
error shows up on that node's card.

## Notes

Linux-only for nodes — the collectors read `/proc`, `/sys`, `df`, `ps`, `ss`,
`systemctl` and the Docker socket directly, and terminals need a pty.
