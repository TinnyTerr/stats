# stats

A fleet dashboard. **Nodes dial the hub**, never the other way round: each node
opens one WebSocket to the hub and everything — telemetry up, control down, log
tails and terminals both ways — rides on it as binary frames.

```
node (src/agent) ──ws /node──▶ hub (src/hub) ◀──ws /ws── browser (web/)
```

## Architecture rules

- **The node's core report is its hostname and addresses. Everything else is a
  module.** `src/agent/identity.ts` is the whole of what the agent collects on
  its own; CPU, memory, disks and the host's facts come from the `system`
  module like anything else, and `telemetry.stats` is therefore optional. A node
  that loads no modules at all is a valid node: it connects, it appears in the
  fleet, and its card says a true thing instead of a zeroed one. Nothing in the
  manifest is `required` any more, and new modules should not be.
- **A module declares the platforms it runs on, and the loader gates on it.**
  `platforms: []` is portable — the default, and the honest answer for a module
  made of HTTP calls; a non-empty list is a closed set. `src/modules/platform.ts`
  is the vocabulary, the gate is the first thing `loadModules()` checks, and it
  runs before the module is asked anything because it needs no host access.
  An installed module can also ship one entry per platform
  (`"entry": {"linux": "./linux.ts", "win32": "./windows.ts"}`), and a map with
  no `default` declares its platforms on its own.
- **`system` is one module with one probe per platform.** `src/collect/probe.ts`
  is the seam; `src/collect/platform/linux.ts` is the implementation the rest of
  the codebase grew up around, and darwin/win32 are declared stubs that report
  unavailable. Probes are imported lazily and one at a time, so a Linux node
  never loads the Windows probe. Adding a platform is a file and a row in
  `PROBES` — not a change to the module, the agent, or the wire.
- **Docker, systemd, terminals and the rest are modules, not special cases.**
  `src/modules/manifest.ts` is the table all three peers read — what a module
  provides, which actions it owns, which tab it draws, what it may touch.
  `src/agent/modules/` is the node half (availability, a slice of the telemetry
  frame, action handlers); `web/modules.tsx` is the browser half (a tab and the
  card faces). Adding a capability is a row in the manifest plus those two
  halves; the shell doesn't change.
- **A module only reaches what it declared — until the node is root.** Grants
  are `read`, `http`, `ws` and `socket` for anyone, `exec` and `pty` for modules
  in the policy's trust list. `src/modules/host.ts` is the enforcement, checked
  at load, and a module wanting more than the policy allows doesn't start. That
  is the *unprivileged* half: `hostPolicy()` hands a root node `rootPolicy()`
  instead, where `unrestricted` is set and nothing is refused — a fence inside a
  root process is furniture, since the module it stops is one `Bun.spawn` from
  what it was denied. The grants survive as a declaration (the CLI prints them,
  the module page shows them); they stop being a request. Root is the only thing
  that switches this, and non-root keeps the real enforcement, because there the
  policy is all that stands between a module and the account the node runs as.
- **A module can come from a git repository, and then it isn't in the
  manifest.** `src/modules/store.ts` clones one per directory; the repo's
  `stats.module.json` becomes an ordinary `ModuleManifest` via
  `toModuleManifest()` and everything downstream stops being able to tell.
  `ModuleId` is therefore `string` — `BUILTIN_MODULE_IDS` is the closed set for
  the code in this repo, and anything iterating "all modules" has to work off
  the ids a peer actually announced.
- **An installed module's browser half is a declaration, never code.** The
  manifest's `tab` and `face` are drawn by the one renderer in
  `web/external.tsx`; the node's data rides in `telemetry.extras[id]` and its
  scalars in `NodeSummary.extras[id]`. Rows stay out of summaries — those go to
  every browser on every tick. A capability that needs a real widget is a
  builtin in `web/modules.tsx`, not an install.
- **One protocol, three peers.** `src/proto/` is the whole wire contract:
  `frame.ts` (12-byte header codec), `messages.ts` (payload shapes and control
  action names), `link.ts` (`PeerLink` — correlation ids, streams, acks,
  heartbeats). Node, hub and browser all run a `PeerLink`; the hub is a relay
  between two of them, so a new capability usually means one action name and
  one handler, not a new endpoint.
- **A stream that might produce data later must call `req.stream.open()` before
  the handler returns.** Otherwise the link closes the correlation id with the
  response. This is what terminals and log tails depend on.
- **Correlation id parity:** the hub allocates odd ids on every link it
  terminates; nodes and browsers allocate even ones. Don't break this.
- **The hub is the source of truth for module *intent*; the node is the source
  of truth for module *state*.** `src/hub/modules.ts` is where the two are
  resolved and `src/hub/db.ts`'s `node_modules` table is where intent is kept,
  so it survives the node being offline when it was set. The asymmetry is the
  whole design: **narrowing is unconditional** — the hub can always take a
  module away, which is the rule this codebase has always had — but **widening
  needs the node's `allowHubModules`**, the same opt-in shape as
  `allowRemoteUpdate`, because turning a module *on* is the hub reaching into a
  machine. Both default to **on for a root node** and off for any other, decided
  in `loadAgentConfig()` and nowhere else: a config built by hand (tests, the
  embedded node) means exactly what it says, and `agent.ts` only ever reads
  `=== true`. A node that hasn't opted in answers "no" rather than erroring, and
  the module page renders that as `refused` instead of pretending it worked.
  `plannedModules()` carries intent and *only* intent: a module the hub has no
  opinion about is absent from the plan, never echoed back from what the node
  announced. Echoing it turns "docker isn't installed here" into "the hub wants
  docker off", and the node reloads on every connection.
- **`hub.json`'s `modules` block is still fleet-wide and still subtractive.** It
  beats per-node intent in both directions, and no node can turn one back on.
- **The hub can ask a node to update; it can never say where from.**
  `src/update.ts` resolves the release from the node's own forge and verifies it
  against that release's `SHA256SUMS`, so `update.apply` carries a version tag
  at most. It is on by default for a root node and off for any other, the same
  shape as `allowHubModules`. Anything that would let the hub name a URL, a
  checksum or a file path breaks the one rule this feature rests on — that rule
  holds under root too, where the hub may ask freely and still cannot say where
  from.
- **Bump `PROTOCOL` in `src/version.ts` when the wire shape changes** in a way
  an older peer would misread. It is also the version byte in every frame, and
  a test asserts the two agree.
- **Collectors degrade, never throw the snapshot away.** A host without Docker
  or systemd still reports everything else; the failure lands in
  `telemetry.errors` and shows on the node's card. A host with no *probe* is not
  a failure at all — the `system` module is simply absent, which is how a new
  platform is brought up additively.
- **Outbound integrations mirror, they don't drive.** `src/hub/notion.ts`
  pushes projects into a Notion database and never reads anything back: the
  node's projects file is the source of truth, and the hub can only narrow it.
  Everything is an outbound call to the third party, which is also the only
  reason it works behind Tailscale — nothing off-tailnet can reach the hub.
- **`schema/projects.schema.json` is the documentation for the projects file;
  `src/agent/projects.ts` is the enforcement.** A test compares the schema's
  `default` keywords against the loader's `DEFAULTS`, so change both together.

## Things that bit us, worth not rediscovering

- `Bun.spawn(..., { terminal: {...} })` gives a real pty. Do **not** set
  `COLUMNS`/`LINES` in the child's env: `tput` and friends prefer them over the
  pty, which makes every later resize look ignored. Test resizes with
  `stty size`.
- `server.stop(true)` never resolves once the server has closed a WebSocket
  itself (Bun 1.3). Tests race it with a short sleep.
- `Bun.file(dir).exists()` is false for directories — stat it instead.
- `systemd-detect-virt` exits non-zero when the answer is "none", which is
  still an answer.
- A collector's `collect()` result is `Object.assign`ed into the frame, so two
  modules writing the same key means the last one to finish wins. `extras` is
  the exception and is merged — see `loadModules().collect()`.
- Proxmox's `/cluster/resources` reports templates alongside real guests. The
  counts exclude them; the list doesn't.
- `Bun.write(path, response)` never completes for a body the size of a release
  asset. `src/update.ts` reads the stream and hashes it in the same pass, which
  it wants to do anyway.
- The hub's relay times out a one-shot at 30s. `update.apply` is in
  `SLOW_ACTIONS` because a download isn't a click; a timeout there wouldn't stop
  the node updating, it would just tell the operator it failed.

## Commands

```bash
bun run hub                                  # hub on :3000
bun index.ts modules                         # what a node can load
bun index.ts modules install <repo>          # add one from a git repository
bun index.ts update --check                  # 0 up to date, 10 if behind
bun run node -- --hub ws://127.0.0.1:3000    # a node against it
bun run check                                # validate the projects file
bun test && bun run typecheck
```

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
