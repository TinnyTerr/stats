# Changelog

Versions are semver on the repo as a whole — hub and node ship together.
`protocol` moves separately, only when the wire shape changes in a way an older
peer can't read. It is also the version byte in every frame.

## Unreleased — protocol 5

Scaffolding for multiplatform nodes, and a hub that can manage the fleet's
modules. Update the hub before the nodes.

- **A Pi-hole module.** On the Pi-hole itself a root node needs no
  configuration at all: v6 ships `pihole api <endpoint>`, which is the same REST
  API reached over the loopback and authenticated out of `/etc/pihole/cli_pw` —
  a file only root can read. So the module loads wherever that command and that
  uid meet, and asks for no URL and no password. Anywhere else `PIHOLE_URL` is
  the whole of the configuration, and the node detects whether it is talking to
  v6's REST API or v5's `api.php`. Either way it reports queries, block rate,
  cached and forwarded counts, clients, gravity size and the top domains,
  clients and upstreams. Blocking can be paused from the dashboard with a timer,
  so it switches itself back on rather than being left off by whoever was
  debugging. The module is portable — the HTTP path is made of HTTP calls, and
  the node need not be the Pi-hole — and holds `http` and `exec`, the second
  being the local command and nothing else (builtin modules are trusted by
  default, so this only matters to a hand-written `trustedModules`). A Pi-hole
  that stops answering is a collection error on the node's card, not a module
  that quietly disappears. `PIHOLE_CLI=0` is for the node that is a Pi-hole but
  is meant to be watching a different one.

- **Everything is a module; hostname and addresses are the core.**
  `src/agent/identity.ts` is now the whole of what a node collects on its own.
  CPU, memory, disks and host facts come from the `system` module like anything
  else does, so `telemetry.stats` and `telemetry.facts` are optional and
  `telemetry.host` is not. Nothing in the manifest is `required` any more: a
  node that loads no modules at all connects, appears in the fleet and reports a
  true hostname instead of a zeroed card. This is what makes bringing up a new
  platform additive rather than all-or-nothing.

- **Modules declare the platforms they run on**, the way `package.json`
  declares `os`. `platforms: []` is portable and the default; a non-empty list
  is a closed set, and the loader drops anything that doesn't name the host it
  woke up on — before asking the module anything, since the check needs no host
  access. `stats modules` shows the column and marks what can't run here.
  Installed modules can also ship one entry per platform
  (`"entry": {"linux": "./linux.ts", "win32": "./windows.ts"}`); a map with no
  `default` declares its platforms on its own, and declaring a platform you ship
  no entry for is refused at install time.

- **`system` is one module with one probe per platform.**
  `src/collect/probe.ts` is the seam; the Linux probe is the implementation this
  codebase grew up around, and macOS and Windows are declared stubs that report
  unavailable — each carrying the list of what it needs. Probes load lazily and
  one at a time, so a Linux node never imports the Windows one. A node on an
  unprobed platform shows its identity with an empty system card rather than
  failing to start.

- **A modules page on the hub.** Every node beside every module it could run,
  with the hub's intent set per node. Intent lives on the hub, survives a node
  being offline when it was set, and is picked up on the node's next connection.
  The page keeps reality and intent visibly apart — `on`, `off`, `pending`,
  `refused`, `n/a`, `blocked` — because a node being offline or on the wrong
  platform is an ordinary state, not an error.

  **Narrowing is unconditional; widening is opt-in.** The hub can always take a
  module away. Turning one *on* is the hub reaching into a machine, so it needs
  `--allow-hub-modules` on the node — the same shape as `--allow-remote-update`.
  A node that hasn't opted in answers "no" and the page says `refused`, rather
  than the dashboard claiming something it didn't do. `hub.json`'s `modules`
  block stays fleet-wide and subtractive, and beats per-node intent both ways.

- **Root is the boundary now, and a root node is unrestricted.** The module
  grant policy was a fence inside the node's own process: a module denied `exec`
  was one `Bun.spawn` from having it, so on a root node it bought no safety and
  cost an operator an evening. A node running as uid 0 now gets `rootPolicy()` —
  every grant held, every path readable, every socket and host reachable, the
  trust list unread — and it defaults `allowHubModules` and `allowRemoteUpdate`
  to **on**, because the hub is the source of truth for what the fleet runs and
  that machine has already been handed over. A flag, an env var or `agent.json`
  still says no to any of it.

  **Nothing changes for a node running as anyone else.** There the policy is the
  only thing between a module and that account, so it keeps enforcing: declared
  grants only, `exec`/`pty` for `trustedModules` only, both hub switches off
  until asked for. The grants stay in every manifest either way — `stats modules
  install` prints them and the module page shows them, so you can still see what
  a module says it touches before installing it. They stop being a request and
  go back to being a declaration.

  **The shipped node unit and `install.sh --node` now default to root**, with
  the old `User=stats` sandbox one `--user stats` (or a few uncommented lines)
  away. Installing a module on a root node is running someone else's code as
  root; the README says so where it matters.

- **The node drawer pops out over the fleet instead of taking a column beside
  it.** Opening a node no longer reflows the grid into half its width, the
  drawer gets the room its tables always needed, and the fleet stays visible
  behind a blur as context rather than as competition. Escape closes it, so does
  the backdrop, focus moves into it and the grid behind it goes inert.

- **The modules page was drawn underneath the node grid.** `.grid` sets
  `display: grid`, which beats the UA's `[hidden] { display: none }` on
  specificity, so switching views left a full grid of invisible cards on top of
  the page taking every click. Fixed in the stylesheet, where the bug was.

- **The overview tab is a dashboard now, not a facts sheet.** A counts strip
  that links into the tab that lists each thing; a *Right now* panel with CPU,
  memory, swap and the busiest mount as meters, the load average read as a
  fraction of the machine's cores, and a **per-core CPU strip** — the probe has
  always reported `cpu.perCore` and nothing drew it, and it is the only thing on
  the page that separates "busy" from "one thread pinned"; a **History** panel
  charting CPU, memory, load, network and storage from the hub's own rolling
  series; and the node's addresses, loaded modules, latency and connection time
  alongside the host facts.

- **`history` can be asked for buckets, and a long window now means one.**
  `MetricStore.history()` capped at the *oldest* 2000 rows, so at a three-second
  tick a chart labelled "24 hours" was drawn from its first ninety minutes.
  Passing `buckets` averages the window into that many even slots; without it
  the rows stay exact and the cap keeps the most recent ones. The param is
  optional and additive, so the wire shape is unchanged.

- **A node whose hub is unreachable no longer exits.** Its reconnect timer was
  unref'd, and with no socket, no telemetry tick and nothing supervised it was
  the only thing holding the loop open — so the process exited *0* between
  attempts. systemd read that as a clean shutdown and restarted it, which is how
  a wrong hub URL came out looking like a crash loop and made `install.sh`
  report that the node "didn't come up". The timer is ref'd; `stop()` still
  clears it.

- **The hub stopped crashing on `getifaddrs`.** Its unit omitted `AF_NETLINK`
  from `RestrictAddressFamilies=`, which blocks the netlink socket behind
  `os.networkInterfaces()` — so the embedded node threw while introducing
  itself and took the hub down with it, once every restart. The generated unit
  now grants it (the one in `deploy/` already did), and `collectIdentity()`
  reports a hostname with no addresses rather than throwing, because a node that
  can't see its own addresses still knows its name.

- **`install.sh --clean`.** The installer's whole posture is "re-running
  upgrades in place and never overwrites your config", which leaves `rm -rf
  /etc/stats` as the only way to ask for a genuinely fresh one. `--clean` is
  that, scoped to the role being installed — a clean node install next to a hub
  leaves `hub.json`, `hub.env` and the history alone — and it lists what it will
  remove and asks first. It stops the units before deleting their
  `EnvironmentFile`, which is also what keeps the journal free of the restart
  loop the manual version caused. After a node install the script now reads the
  journal back and says whether the node actually reached the hub, rather than
  reporting success for a process that is merely running.

## 0.4.0 — protocol 4

- **Updating, three ways.** Re-running `install.sh` still works and is still
  the fallback that needs nothing. On top of it:

  `stats update` does the same job from inside the binary — resolves the
  release, picks the build for this CPU, checks it against the release's
  `SHA256SUMS`, proves the new binary *runs* before installing it, swaps it
  atomically and restarts its own unit. `--check` exits 0 when up to date and
  10 when there's a newer release, so a fleet loop can branch on it. It refuses
  to install anything it can't verify, and refuses to run from source.

  From the dashboard, a node's overview tab can check for updates and apply
  one — but only if the node was started with `--allow-remote-update`. The hub
  can ask; it cannot say where from. The node resolves and verifies the release
  against the forge *it* trusts, so a compromised hub can at worst ask for an
  update the node would already have accepted. The shipped hardened unit runs
  as `User=stats` with `ProtectSystem=full`, so this fails with a clear
  permission error until an operator deliberately opens it up — see "Updating"
  in the README.

- **The dashboard tracks a rollout.** Any online node not on the hub's version
  gets a pill on its card, and the header shows `5/7 up to date` until they all
  are. A node *ahead* of the hub is called out separately, because that means
  the upgrade happened in the wrong order.

- **Modules can be installed from a git repository.** A repository with a
  `stats.module.json` at its root is a module:

  ```bash
  stats modules install https://git.example.com/you/stats-module-weather
  stats modules install owner/repo --ref v2
  stats modules update
  stats modules remove weather
  ```

  They live in `/var/lib/stats/modules` (`STATS_MODULE_DIR` overrides), and from
  the node's point of view an installed module is an ordinary one: same manifest
  row, same grant check, same `--modules -weather` switch, same fleet-wide
  narrowing from `hub.json`. `stats modules` lists them with the commit each is
  running.

  The node half is code and runs on the host, behind the same gate as
  everything else — the open grants only, unless an operator names the module in
  `trustedModules`, and never the supervisor, terminals or streams. The browser
  half is *not* code: the manifest declares a table and a card face and the
  dashboard renders them, so nothing from a third party executes in a browser.
  Data rides in `telemetry.extras[id]`, and its scalars in the node summary.
  `examples/stats-module-endpoints/` is a working one.

- **Proxmox.** VMs and containers across a PVE host or cluster, with per-host
  CPU, memory and uptime, storage, tags, HA state and locks, and
  start/shutdown/stop/reboot from the dashboard. On the hypervisor itself it
  uses `pvesh`, which is already authenticated, so there is nothing to
  configure; from another node, set `PROXMOX_URL` and `PROXMOX_TOKEN`
  (and `PROXMOX_INSECURE=1` for PVE's default self-signed certificate).

- **Meters where full is good are no longer red at full.** A card's bar was
  always coloured as pressure on a resource, which is right for CPU and disk
  and backwards for "units active", "containers up" and "projects running" —
  99% of systemd's units running rendered as an alarm. Those three now colour
  from the thing they actually measure: systemd's own `is-system-running`
  verdict and failed list, and the unhealthy/degraded counts.

  **Protocol 4**: telemetry carries `proxmox`, `guests` and `extras`, and
  capabilities carry installed modules' manifests.

## 0.3.0 — protocol 3

- **Modules.** Docker, systemd, terminals, processes, ports, logs and projects
  are no longer wired through the codebase as special cases: each is a module
  that owns a slice of the telemetry frame, its control actions, its tab in the
  detail pane and the faces it offers the front of a node card. `stats modules`
  lists them; `--modules docker,systemd` or `--modules -terminal` picks a set,
  as does `modules` in `agent.json`. `system` is required — everything else can
  go. A module whose host can't serve it (no docker socket, no systemd) drops
  itself at startup and says why, so the dashboard hides its tab instead of
  showing an empty one.

  The hub's `modules` block narrows the fleet the same way `terminal` used to
  narrow shells, and `terminal: true/false` still works as the terminal
  module's switch. Turning a module off in `hub.json` refuses its actions at
  the hub, before they reach a node.

  **Protocol 3**: `capabilities` is now `{ modules, control }` rather than a
  fixed list of booleans. A 0.2.x node connecting to a 0.3 hub reports
  telemetry but can't be asked to do anything, which is the safe direction.

- **A module reaches the world through one gated object.** Every module
  declares what it needs — `read`, `http`, `ws`, `socket` — and gets a host
  wired to exactly that; asking for anything else is a `ModuleDenied` rather
  than the resource. Reads are confined to `/proc`, `/sys`, `/etc`, `/run` and
  `/var/log`, and sockets to the ones the policy names. `exec` and `pty` hand
  over the machine, so they are privileged: the modules in this repo hold them,
  and a module from anywhere else has to be listed in `trustedModules` to. A
  module asking for more than the policy allows doesn't load, and says so at
  startup.

- **The node card's front block rotates.** The three meters, the sparkline and
  the facts grid are now one face among several — load, temps, network,
  storage, containers, units, projects — each contributed by the module that
  owns the data, all in the same fixed-height slot so the grid never jumps.
  The whole grid turns over on one timer (`hold`, 8s, 15s or 30s, in the top
  bar), and clicking a card's face dot pins that card until you click it again.

- **Shorter sparklines.** 30 points instead of 60, seeded from 10 minutes of
  history instead of 30, and 28px tall instead of 34. These are shapes read at
  a glance, and the long tail was crowding out the part anyone looks at.

- **Notion mirror.** The hub can push every project the fleet reports into a
  Notion database, one row per (node, project), upserted on `Key`. Configure it
  with a `notion` block in `hub.json`; omitting the block leaves it off. The
  protocol is untouched — this rides on telemetry the hub already has.

  It writes and never reads back, because the node's projects file is the
  source of truth and the hub can only narrow what a node reports. It is also
  outbound-only: Notion cannot reach a tailnet address, so anything driving the
  fleet *from* Notion would need the hub exposed publicly.

  Missing or wrong-typed columns are reported once and skipped rather than
  failing the whole page, the same way collectors degrade. Rows are only
  rewritten when something other than the timestamp changed.

## 0.2.2

The dashboard was reading almost nothing the hub sent it. Frames over 1 KiB are
gzipped, and the browser has no sync gunzip — `Bun.gzipSync` and
`Bun.gunzipSync` don't exist there — so `decodeFrame` threw, `PeerLink.receive`
caught it, and every large push went in the bin without a word. Telemetry is
tens of kilobytes, so in practice that was all of it.

- **Live stats update again.** The hub no longer compresses frames sent to a
  browser; `permessage-deflate` on the socket does that job instead, so the
  bytes on the wire are unchanged. `PeerLink` takes a `compress` option, and
  the frame codec now skips gzip where the runtime has none rather than
  throwing into a `catch`.
- **Services no longer claim the host has no systemd.** Same cause: with
  telemetry never arriving, the panel fell through to its "no systemd
  (`unknown` instead)" message. Logs kept working because they stream.
- **Terminals open on hosts whose `$HOME` was never created.** The installer
  makes the service user with `--no-create-home`, so systemd handed the node a
  `HOME` that isn't there — and Bun reports a missing cwd as
  `ENOENT … posix_spawn '/bin/bash'`, which reads as a missing shell. The node
  now falls back to `/`, and says "no such directory" when a project's own cwd
  is the thing that's missing.
- Requests the dashboard sent that were over 1 KiB were dropped the same way,
  on the encode side. Also fixed.

## 0.2.1

Frontend fetched /api/nodes, yet did nothing with the information it had fetched.
Fixed this to ensure the hub dashboard populates the entries correctly.

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
