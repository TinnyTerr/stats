# Changelog

Versions are semver on the repo as a whole — hub and agent ship together.
`protocol` moves separately, only when the agent↔hub wire shape changes in a way
an older peer can't read.

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
