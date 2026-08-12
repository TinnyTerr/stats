# stats-module-endpoints

An example [stats](../../README.md) module: HTTP checks against a list of URLs,
reported as a card face and a table.

It exists to be read. Two files are the whole thing — `stats.module.json` says
what the dashboard should draw, `node.ts` produces the numbers — and between
them they use every part of the interface an installed module has.

## Installing it

A module is a git repository, so this directory has to be one:

```bash
stats modules install https://example.com/you/stats-module-endpoints
```

or, to try it from a checkout of this repo:

```bash
git init examples/stats-module-endpoints && git -C examples/stats-module-endpoints add -A
git -C examples/stats-module-endpoints commit -m "example"
stats modules install ./examples/stats-module-endpoints
```

Then tell the node what to check, in `/etc/stats/agent.json`:

```jsonc
{
  "moduleSettings": {
    "endpoints": {
      "urls": [
        "https://example.com/health",
        { "name": "grafana", "url": "http://127.0.0.1:3000/api/health" }
      ]
    }
  }
}
```

and restart the node. `stats modules` lists it, with the commit it's running.

## What the two halves do

`stats.module.json` is read by all three peers. The node uses `grants` and
`actions`; the browser uses `tab` and `face`, which are declarations rather than
code — the dashboard renders them, so nothing from this repository executes in
anyone's browser.

`node.ts` runs in the node's process, behind the same gate every module is
behind. This one declared `http`, so `ctx.host.fetch` works and
`ctx.host.exec` throws. `exec` and `pty` are available too, but only to modules
an operator has named in `trustedModules` — installing a module is not the same
as trusting it with the machine.

## The shape, in short

```ts
export default {
  available(ctx): boolean,          // is this host worth loading it on?
  collect(ctx): { values, rows, status?, detail? },
  actions: { "endpoints.check"(params, ctx) {} },
};
```

`values` are scalars the card face reads by name. `rows` are the tab's table,
one object per row keyed by the column keys in the manifest. `status` is the
module's own verdict — it colours the meter and lights the tab's badge.
