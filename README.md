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
- **Charted, not just listed** — a node's overview draws CPU, memory, load,
  network and storage over the last hour, six hours or day from the hub's own
  series, with a table view of the same numbers beside it.
- **Host identity, spelled out** — distribution and version from os-release and
  lsb-release, kernel, architecture, virtualisation, init system, systemd
  version, machine id, Docker version.
- **systemd, formatted** — units with load/active/sub kept apart rather than
  flattened, failed units surfaced first, `systemctl show` in a drawer, and
  start/stop/restart/reload from the dashboard.
- **Docker** — containers grouped by compose project, health and restart counts,
  CPU and memory, start/stop/restart, log tails.
- **Proxmox** — VMs and containers across a PVE host or cluster, with per-host
  load and storage. On the hypervisor it uses `pvesh` and needs no credentials;
  from anywhere else, an API token.
- **Pi-hole** — queries, block rate, clients, top domains and upstreams from a
  Pi-hole's own API, v5 or v6, with blocking pausable from the dashboard and a
  timer so it comes back on by itself.
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
`--clean`, `--uninstall [--purge]`, `--help`.

Re-running it upgrades in place; configs and tokens are never overwritten.
`--clean` is the other thing: it drops this machine's config and units for the
role being installed — scoped, so cleaning a node next to a hub leaves the hub
alone — and installs fresh. It lists what it will remove and asks first, unless
you pass `--yes`.

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

  "modules": {                  // fleet-wide switches; subtractive only
    "terminal": false           // no shells anywhere, whatever a node offers
  },
  "embeddedNode": false,        // run a node in-process for the hub's own host

  "nodes": [                    // optional per-node overrides
    { "id": "web-1", "name": "Web 1", "tags": ["prod"], "notes": "nginx" }
  ],

  "notion": {                   // omit the block entirely to disable
    "token": "env:NOTION_TOKEN",
    "database": "1f2a…",        // the 32-char id from the database URL
    "intervalMs": 60000,        // floored at 15s
    "archiveStale": false       // true: archive rows whose project is gone
  }
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

## Modules

Docker, systemd, Proxmox, Pi-hole, terminals, processes, ports, logs and
projects are modules, not built-in special cases. A module owns a slice of the telemetry frame, the
control actions that go with it, the tab it draws in the detail pane, and the
faces it offers the front of a node card. Turn one off and all four go with it —
no tab, no actions, no empty section.

```bash
stats modules                                  # what's available
stats node --hub … --modules docker,systemd    # only these (plus system)
stats node --hub … --modules -terminal         # everything but this
STATS_MODULES=-docker,-terminal stats node …   # same, from the environment
```

or in `/etc/stats/agent.json`:

```jsonc
{ "modules": { "terminal": false, "docker": true } }
```

Everything is a module, `system` included. A node's own report is its hostname
and its addresses; CPU, memory, disks and host facts come from `system` like
anything else comes from its module. A node that loads nothing still connects
and still appears in the fleet — which is what makes bringing up a new platform
additive rather than all-or-nothing.

A module whose host can't serve it (no docker socket, no systemd) drops itself
at startup and says so in the node's log, so the dashboard hides it rather than
showing an empty tab.

### Platforms

A module declares which hosts it runs on, the way `package.json` declares `os`:

```bash
stats modules      # the table, with a [not on this platform] marker
```

| Module | Runs on |
| --- | --- |
| `system` | Linux, macOS, Windows — one probe per platform |
| `projects`, `logs`, `proxmox`, `pihole` | any platform |
| `docker`, `processes`, `ports` | Linux, macOS |
| `systemd` | Linux |
| `terminal` | Linux, macOS, Windows |

An empty list means portable, which is the default and the honest answer for a
module made of HTTP calls. The loader drops anything that doesn't name the host
it woke up on, before asking the module anything.

Only the Linux probe for `system` is implemented today; macOS and Windows are
declared stubs that report unavailable, so a node on either connects, shows its
hostname and addresses, and runs its portable modules with the system card
absent. `src/collect/probe.ts` is the seam and `src/collect/platform/` is where
a new one goes.

### Managing modules from the hub

The dashboard's **modules** page lists every node beside every module it could
run, and lets you set the hub's intent per node. The page deliberately keeps two
things apart:

| State | Means |
| --- | --- |
| `on` | the node is running it |
| `off` | nothing asked for it |
| `pending` | the hub asked; the node applies it the next time it connects |
| `refused` | the hub asked, but that node won't take module direction |
| `n/a` | the module doesn't run on that node's platform |
| `blocked` | `hub.json` has it off for the whole fleet |

Intent is stored on the hub and survives a node being offline when it was set —
the node picks it up on its next connection without anyone touching it.

**Narrowing always works; widening depends on who the node is.** The hub can
take a module away from any node. Turning one *on* is the hub reaching into a
machine, so it needs `--allow-hub-modules` — which **a node running as root
defaults to on**, because a root node has already handed the machine over and
the hub is the source of truth for what it should be running. A node running as
anyone else has it off until asked, answers "no", and the page shows `refused`
rather than pretending it worked.

```bash
stats node --hub … --allow-hub-modules     # let a non-root node take additions
STATS_ALLOW_HUB_MODULES=1 stats node …     # same, from the environment
STATS_ALLOW_HUB_MODULES=0 stats node …     # refuse them even as root
```

`modules` in `hub.json` stays fleet-wide and stays subtractive: it beats
per-node intent in both directions, and no node can turn one back on.

### What a module may touch

A module reaches the outside world through one gated host object, and only
through the grants it declared in `src/modules/manifest.ts`:

| Grant | What it gives |
| --- | --- |
| `read` | reading files under the policy's roots (`/proc`, `/sys`, `/etc`, `/run`, `/var/log`) |
| `http` | outbound HTTP, host-allowlisted |
| `ws` | outbound WebSocket, same allowlist |
| `socket` | HTTP over a named unix socket — how the docker module reaches the engine |
| `exec` | **privileged**: running a command |
| `pty` | **privileged**: spawning a process on a pty |

The first four are the open set: any module may ask for them. `exec` and `pty`
hand over the machine, so a module holding either has to be in the policy's
trust list — the modules in this repo are, and nothing else is unless you say
so. Asking for a grant the policy won't give means the module doesn't load at
all, reported at startup rather than discovered when it first misbehaves.

**All of which stops applying when the node runs as root.** A root node's policy
is unrestricted: every grant is held, every path readable, every socket and host
reachable, and the trust list goes unread. This is not a shortcut, it is the
honest version — a module denied `exec` inside a root process is one `Bun.spawn`
away from having it, so the refusal bought nothing and cost you an evening
working out why your module wouldn't load. The confinement that does the work is
*who can run the node as root* and *who can reach the hub*. The grants stay in
the manifest either way: `stats modules install` prints them and the module page
shows them, so you can still see what a module says it touches before you
install it.

### Installing a module from a git repository

A module doesn't have to ship in this repo. One git repository with a
`stats.module.json` at its root is a module, and a node can install it:

```bash
stats modules install https://git.example.com/you/stats-module-weather
stats modules install owner/repo --ref v2      # GitHub shorthand, a tag
stats modules install ./path/to/checkout       # a repository on this machine
stats modules                                  # what's installed, and at which commit
stats modules update                           # fast-forward all of them
stats modules remove weather
```

They land in `/var/lib/stats/modules` (`~/.local/share/stats/modules` when the
node doesn't run as root, `STATS_MODULE_DIR` to override), and a node loads them
on its next start. From then on an installed module is an ordinary one: it can
be switched off with `--modules -weather`, narrowed away fleet-wide from
`hub.json`, and it appears in `stats modules` next to the builtins.

Configure one in the node's `agent.json`:

```jsonc
{
  "moduleSettings": {
    "weather": { "cities": ["Bristol", "Leeds"] }
  }
}
```

**Installing a module means running its code on that host.** On an unprivileged
node the grant policy is what limits it: it gets the open set and nothing more,
so it can make HTTP requests but cannot run a command unless you add its id to
`trustedModules` in the node config. **On a root node it gets everything it
asked for and everything it didn't** — read the manifest before you install it,
and treat installing on a root node as what it is: running someone else's code
as root. Either way it never gets the supervisor, the terminal manager or the
log streams — those are builtin territory.

Its dashboard half is a *declaration*, not code. The manifest says which columns
its tab has and which tiles and meter its card face shows, and the dashboard
renders that; nothing from the module executes in a browser. The node returns
matching data every tick:

```ts
export default {
  available: (ctx) => true,
  collect: async (ctx) => ({
    values: { cities: 2, reporting: 2 },   // scalars the card face reads
    rows: [{ city: "Bristol", tempC: 14 }],// the tab's table
    status: "ok",                          // colours the meter, badges the tab
  }),
  actions: { "weather.refresh": async (params, ctx) => ({}) },
};
```

An installed module declares its platforms the same way a builtin does, and can
ship one entry per platform when it needs to:

```jsonc
{
  "id": "weather",
  "entry": "./node.ts",              // one file, portable
  "platforms": []                    // ...which is also the default
}
```

```jsonc
{
  "id": "eventlog",
  "entry": { "win32": "./windows.ts", "linux": "./journal.ts" },
  // omitted: a map with no "default" declares its platforms on its own
}
```

A `default` key catches everything the map didn't name. Declaring a platform you
ship no entry for is refused at install time rather than at start-up on the one
host it mattered on.

`examples/stats-module-endpoints/` is a complete, working one — HTTP checks
against a list of URLs — written to be read.

## Notion mirror

The hub can mirror every project the fleet reports into a Notion database, one
row per (node, project), refreshed on a timer.

It only ever writes. The node's `projects.json` stays the source of truth — the
hub can narrow what a node reports but never widen it — so nothing you type in
Notion changes what a node runs. Treat the database as a view.

Setup:

1. Create an internal integration at
   [notion.so/my-integrations](https://www.notion.so/my-integrations), copy the
   secret into `NOTION_TOKEN`.
2. Create a database, then **… → Connections → your integration**. Without
   this the API returns 404 for a database that plainly exists.
3. Copy the database id — the 32 hex characters in its URL, before the `?`.

The database needs these properties. Any that are missing are logged once and
skipped, so you can start with a subset:

| Property    | Type           | Holds                              |
| ----------- | -------------- | ---------------------------------- |
| *(title)*   | `title`        | project name — any name works      |
| `Key`       | `rich_text`    | `nodeId/projectId`, the upsert key |
| `Node`      | `rich_text`    | node display name                  |
| `Status`    | `select`       | running / degraded / stopped / empty / offline |
| `Processes` | `rich_text`    | `3/4 running`                      |
| `Uptime`    | `rich_text`    | longest-running process            |
| `Restarts`  | `number`       | summed across the project          |
| `Tags`      | `multi_select` | the project's tags                 |
| `URL`       | `url`          | the project's `url`                |
| `Updated`   | `date`         | last sync                          |

`Key` is the one that matters: it is what makes the sync an upsert. Without it
every pass creates duplicate rows, so the hub refuses to guess and says so.
Rename any column via `"properties": { "restarts": "Crash count" }`.

A project on a node the hub has lost contact with reports `offline` rather than
whatever its last telemetry claimed. Rows are only rewritten when something
other than the timestamp changed, so a quiet fleet costs one query per pass.

**On reaching the hub from Notion:** you can't. A tailnet address is only
routable inside your tailnet, and Notion's servers aren't on it — so Notion
automations, webhooks and buttons pointed at the hub will simply time out. This
mirror works because every request goes the other way, out to `api.notion.com`.
Exposing the hub publicly (Tailscale Funnel, a reverse proxy) is the only way
round that, and is worth wanting only if you need Notion to drive the fleet.

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

Control actions a hub sends a node: `snapshot`, `modules`, `facts.refresh`, `logs.tail`,
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
| `GET /api/nodes/:id/history?minutes=60&buckets=240` | time series for charts; `buckets` averages the window into that many even slots, which is the only honest way to ask for a long one |
| `GET /api/events?minutes=1440` | connections, crashes, failed units |
| `GET /schema/projects.schema.json` | the projects schema |
| `WS /node` | where nodes connect |
| `WS /ws` | where the dashboard connects |

## Security notes

This is the part that changed most from 0.1, so read it before rolling it out.

- **A node is no longer read-only.** By default it will open a shell and
  start/stop projects, units and containers on request. Both are node-side
  switches: `--no-terminal` (the terminal module) and `--no-control` (or
  `STATS_TERMINAL=0`, `STATS_CONTROL=0`) refuse them outright, and the hub's
  `modules.terminal: false` can narrow it further but never widen it.
- **Whoever can reach the dashboard can do those things.** Set `token` in
  `hub.json` if the hub isn't on localhost.
- **Set `nodeToken`.** Without one, any host that can reach the hub can
  register as a node and appear on your dashboard. Set
  `allowUnknownNodes: false` to accept only ids you've listed.
- **Terminals and supervised processes run as the user the node runs as, and
  the packaged node unit runs as root.** That is what makes `user:` in projects,
  unit control and unrestricted modules work, and it is equivalent to handing
  out a root shell to whoever can reach the dashboard. A root node also takes
  module changes and update requests from the hub by default. Install with
  `--user stats` for the sandboxed, least-privilege node instead — modules keep
  the grant policy and both hub-directed switches go back to off. Choose
  deliberately.
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
| `PROXMOX_URL` | node | none (unset means "use pvesh on this host") |
| `PROXMOX_TOKEN` | node | none |
| `PROXMOX_INSECURE` | node | `0` |
| `PIHOLE_URL` | node | none (unset means "no Pi-hole here") |
| `PIHOLE_PASSWORD` | node | none (v6 app password) |
| `PIHOLE_TOKEN` | node | none (v5 API token) |
| `STATS_ALLOW_REMOTE_UPDATE` | node | `0` |
| `STATS_ALLOW_HUB_MODULES` | node | `0` (let the hub turn modules on, not just off) |
| `STATS_HOST` | both | `git.tinnyterr.com` (where updates come from) |
| `STATS_REPO` | both | `tinnyterr/stats` |
| `STATS_ASSET` | both | detected from arch, libc and AVX2 |
| `NOTION_TOKEN` | hub | none (only if `hub.json` refers to it) |

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

## Updating

**Update the hub first, then the nodes.** Payloads are additive and nothing
validates the frame's version byte, so a node one release behind keeps
reporting — it just has nothing to say about whatever the new release added.
The other order works too, but an older hub silently drops modules it has never
heard of, so a new node looks like it lost capabilities.

The dashboard tracks the rollout for you: any online node not on the hub's
version gets a pill on its card, and the header shows `5/7 up to date` until
they all are.

Three ways to move a machine, in increasing order of "I would like to stop
ssh-ing into things":

```bash
# 1. the installer, re-run — always works, upgrades the binary and restarts
curl -fsSL https://git.tinnyterr.com/tinnyterr/stats/raw/branch/main/install.sh | sudo sh -s -- --node

# 2. the binary updating itself
stats update                 # to the latest release
stats update --check         # exit 0 up to date, 10 if there's a newer one
stats update --version v0.4.0 --no-restart
```

`stats update` does what the installer does — resolves the release, picks the
build for this CPU (arch, libc, and AVX2 vs baseline), checks it against the
release's `SHA256SUMS`, proves the new binary runs *before* installing it, then
swaps it atomically and restarts the unit it's running under. It refuses to
install anything it can't verify, and it refuses to run from source, where the
"binary" would be Bun itself.

3. From the dashboard: a node's **overview** tab has *check for updates*, and an
**update** button when one is waiting. A node running as root accepts these by
default; any other node has to be started with `--allow-remote-update` (or
`allowRemoteUpdate: true` in `agent.json`, or `STATS_ALLOW_REMOTE_UPDATE=1`)
first. Setting any of those to false refuses them on a root node too.

The hub can only ask. It cannot say where from: the node resolves the release
from the forge *it* is configured with and verifies it against that release's
published checksums, so a compromised hub can at worst ask for an update the
node was already willing to install.

### Making a hardened node able to update itself

The root unit replaces its own binary without any of this. But a node installed
with `--user stats` runs with `ProtectSystem=full`, which makes `/usr`
read-only — so it cannot replace its own binary, and `update.apply` fails with a
clear permission error rather than half-swapping anything. If you want option 3
on such a node, you have to open exactly that hole:

```ini
# /etc/systemd/system/stats-node.service.d/update.conf
[Service]
ReadWritePaths=/usr/local/bin
```

```bash
sudo chown stats /usr/local/bin/stats
```

Weigh that: it means anything that compromises the `stats` user can rewrite a
binary root runs. If it doesn't appeal, options 1 and 2 stay available and need
no privilege the node didn't already have.

## Layout

```
index.ts                CLI: `hub`, `node`, `check`, `version`
src/version.ts          release version + wire protocol number
src/update.ts           resolving, verifying and swapping the binary in place
src/types.ts            every type that crosses the wire
src/http.ts             the little HTTP that's left: health, JSON mirror, auth
src/proto/frame.ts      the binary frame codec
src/proto/messages.ts   payload shapes and control action names
src/proto/link.ts       PeerLink: correlation, streams, acks, heartbeats
src/collect/            system.ts, facts.ts (the Linux probe's collectors),
                        systemd.ts, docker.ts, proxmox.ts, pihole.ts,
                        processes.ts, logs.ts
src/collect/probe.ts    the per-platform seam under the `system` module
src/collect/platform/   linux.ts (real), darwin.ts and win32.ts (declared stubs)
src/agent/agent.ts      the node: dial, telemetry loop, control dispatch
src/agent/identity.ts   hostname and addresses — the only thing not from a module
src/agent/config.ts     node configuration and hub URL normalisation
src/agent/projects.ts   projects file loading and validation
src/agent/supervisor.ts runs and watches declared processes
src/agent/terminal.ts   pty sessions
src/agent/modules/      the node half of each module
src/modules/            the manifest all three peers read, the gated host, and
                        the git-backed store for installed modules
src/modules/platform.ts which hosts a module runs on, and per-platform entries
examples/               a complete example module, written to be read
src/hub/config.ts       hub.json loading
src/hub/db.ts           SQLite history, events and known nodes
src/hub/registry.ts     who's connected, and the alerts derived from telemetry
src/hub/modules.ts      module intent vs. reality, and what the hub may decide
src/hub/notion.ts       outbound mirror of projects into a Notion database
src/hub/server.ts       node and browser endpoints, and the relay between them
web/                    React dashboard (link.ts, panels.tsx, modules.tsx,
                        external.tsx — the renderer for installed modules,
                        modulespage.tsx — the fleet's module management page)
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

Linux is the only platform with collectors today: the `system` probe reads
`/proc` and `/sys`, and `processes`, `ports` and `systemd` shell out to `ps`,
`ss` and `systemctl`. macOS and Windows probes are declared but unwritten, so a
node on either connects and reports its identity with an empty system card —
see **Platforms** above. The hub itself runs anywhere Bun does.
