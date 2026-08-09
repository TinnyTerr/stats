# Changelog

Versions are semver on the repo as a whole — hub and node ship together.
`protocol` moves separately, only when the wire shape changes in a way an older
peer can't read. It is also the version byte in every frame.

## 0.2.0 — protocol 2

The connection is inverted and the agent is no longer read-only. **Nothing from
0.1 keeps working**: upgrade the hub and every agent together.

### Nodes dial the hub

- Agents are now **nodes**, and they connect *out* to the hub over a WebSocket
  instead of listening for it to poll them. A server behind NAT, a firewall or
  a dynamic address needs no inbound rule and no fixed address.
- The hub no longer lists the machines it watches; nodes announce themselves
  with a `Hello` and are admitted by `nodeToken` (or a per-node token). Set
  `allowUnknownNodes: false` to accept only ids you've listed.
- A node that has ever connected stays on the dashboard as **offline** rather
  than disappearing, and survives a hub restart via a `nodes` table.
- `bun index.ts agent` still works as an alias for `node`, and says so.

### One binary protocol for everything

- 12-byte header — version, message type, flags, correlation id, payload
  length — then a payload that is UTF-8 JSON, or opaque bytes when the `binary`
  flag is set. Payloads over 1 KiB are gzipped and flagged.
- Message types: telemetry, control_req, control_resp, ack, error, stream_data,
  stream_end, hello, welcome, ping, pong.
- Correlation ids are split by parity so both directions can have requests in
  flight; a request that opens a stream keeps its id alive both ways until
  either side sends `stream_end`.
- The browser speaks the same protocol on `/ws`, so the hub is a relay rather
  than a second API: log tails and terminals are copied frame-for-frame between
  the two links.

### Terminals

- The dashboard can open a real pty on any node — job control, colour and
  curses apps all work — rendered with xterm.js, with resize wired through to
  the kernel's window size.
- A shell can be opened in a project's working directory and environment, or
  inside a running container via `docker exec`.
- Node-side switches: `--no-terminal` refuses outright, `--no-control` refuses
  start/stop/restart. The hub's `terminal: false` can narrow what a node
  offers, never widen it.

### Projects

- A node reads `/etc/stats/projects.json` (or `projects.d/*.json`, or
  `--projects`) and **runs** what it declares: start, restart policy with
  backoff and a give-up threshold, stop signal and timeout, privilege dropping
  via `setpriv`/`runuser`, env files, per-process CPU and memory sampling, and
  an in-memory log ring you can tail from the dashboard.
- Healthchecks (`http`, `tcp`, `command`) mark a process healthy or unhealthy
  without restarting it.
- Projects can also just `watch` — units, containers, ports and log paths that
  belong to them but that the node doesn't run.
- The schema is published at `schema/projects.schema.json`, served by every hub
  at `/schema/projects.schema.json`, and validated by `stats check`.

### Formatting for what a host actually is

- New host facts: os-release and lsb-release (distribution, version, codename,
  and the lsb value when it disagrees), kernel, architecture, virtualisation,
  init system, systemd version, machine id, timezone, Docker version. The
  dashboard shows the distribution as a chip in its own colours.
- systemd is reported properly: load/active/sub kept apart rather than
  flattened into one string, `is-system-running` state, failed units surfaced
  first, `systemctl show` in a drawer, and start/stop/restart/reload.
- Containers gained start/stop/restart; ports, processes and disks gained
  filters and per-row detail.
- The hub derives alerts from consecutive telemetry frames — a unit that just
  failed, a process that just crashed, went unhealthy or came back — and pushes
  them to the dashboard, edge-triggered so a long-failed unit doesn't shout
  every few seconds.

### Configuration

- `servers.json` is replaced by `hub.json`: `token`, `nodeToken`,
  `allowUnknownNodes`, `telemetryIntervalMs`, `nodeTimeoutMs`, `terminal`,
  `embeddedNode`, and optional per-node overrides. A hub with no config file
  starts on `127.0.0.1:3000`.
- `deploy/stats-agent.service` becomes `deploy/stats-node.service`, and
  `install.sh` grows `--node --hub-url … --token …`, `--no-terminal`,
  `--no-control`, `--id` and `--name`. Installing the hub generates the node
  token and prints the exact command to run on each server.
- The metrics tables are rekeyed from `server_id` to `node_id`; the old rolling
  window is dropped on first start rather than migrated.

## 0.1.1

- `bun run build` cross-compiles standalone executables into `dist/` — six Linux
  targets covering x86-64/arm64, glibc/musl and no-AVX2 CPUs — plus gzipped
  copies, `SHA256SUMS` and `manifest.json`. Each embeds the Bun runtime and the
  bundled dashboard, so an install target needs nothing preinstalled.
- `install.sh` detects the machine's architecture, libc and CPU features, fetches
  or unpacks the matching build, verifies its checksum, and can install either
  role as a hardened systemd unit (`--agent` / `--hub`), generating the agent
  token as it goes. Also does `--from dist`, `--uninstall` and in-place upgrades.
- `deploy/stats-hub.service` joins the agent unit; both now assume the compiled
  binary and read config from `/etc/stats/`.
- `index.ts` does its work in `main()` rather than at the top level, so the build
  can use `--bytecode` (no top-level await allowed) for a faster cold start.

## 0.1.0 — protocol 1

First versioned release.

- `bun index.ts version` prints the version and protocol; both roles log it at
  startup.
- `GET /api/health` reports `version` (string) and `protocol` (number) on hub and
  agent. **Breaking:** the agent previously returned `version: 1`, which was the
  protocol number; that value now lives in `protocol`.
- Agent snapshots carry `agent: { version, protocol }`, surfaced as
  `agentVersion` / `agentProtocol` on `/api/servers` and shown in the dashboard.
- The hub warns once per server when an agent's protocol doesn't match its own.
