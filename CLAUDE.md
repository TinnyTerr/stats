# stats

A fleet dashboard. **Nodes dial the hub**, never the other way round: each node
opens one WebSocket to the hub and everything — telemetry up, control down, log
tails and terminals both ways — rides on it as binary frames.

```
node (src/agent) ──ws /node──▶ hub (src/hub) ◀──ws /ws── browser (web/)
```

## Architecture rules

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
- **The hub can only narrow a node's capabilities, never widen them.** A node
  decides whether it allows terminals and control; `hub.json` can turn them off
  for everyone but can't turn them on.
- **Bump `PROTOCOL` in `src/version.ts` when the wire shape changes** in a way
  an older peer would misread. It is also the version byte in every frame, and
  a test asserts the two agree.
- **Collectors degrade, never throw the snapshot away.** A host without Docker
  or systemd still reports everything else; the failure lands in
  `telemetry.errors` and shows on the node's card.
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

## Commands

```bash
bun run hub                                  # hub on :3000
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
