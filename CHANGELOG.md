# Changelog

Versions are semver on the repo as a whole — hub and agent ship together.
`protocol` moves separately, only when the agent↔hub wire shape changes in a way
an older peer can't read.

## Unreleased

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
