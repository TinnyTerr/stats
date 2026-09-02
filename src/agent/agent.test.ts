import { expect, test } from "bun:test";
import os from "node:os";

import { collectIdentity } from "./identity.ts";

// A node whose hub is unreachable has nothing else holding the event loop open:
// no socket, no telemetry interval, and usually no supervised processes. When
// the reconnect timer was unref'd the process therefore *exited 0* between
// attempts, which systemd reads as a clean shutdown — the unit flaps instead of
// retrying, and `install.sh` reports that the node "didn't come up".
test("the node stays alive while its hub is unreachable", async () => {
	const proc = Bun.spawn(
		[
			process.execPath,
			"index.ts",
			"node",
			"--hub",
			"ws://127.0.0.1:9", // discard port: refused, never connects
			"--token",
			"x",
			"--no-terminal",
		],
		{
			cwd: new URL("../..", import.meta.url).pathname,
			env: { ...process.env, STATS_AGENT_CONFIG: "/nonexistent/agent.json" },
			stdout: "ignore",
			stderr: "ignore",
		},
	);

	// Long enough for the first attempt to fail and the backoff to be the only
	// thing left running.
	await Bun.sleep(4000);
	const alive = proc.exitCode === null && proc.signalCode === null;
	proc.kill();
	await proc.exited;

	expect(alive).toBe(true);
}, 20_000);

// The hub's own unit used to omit AF_NETLINK from RestrictAddressFamilies,
// which makes the getifaddrs() behind os.networkInterfaces() *throw*. That took
// down the embedded node — and with it the hub — while it was doing nothing
// more than introducing itself.
test("identity survives a host that refuses getifaddrs", () => {
	const real = os.networkInterfaces;
	(os as { networkInterfaces: unknown }).networkInterfaces = () => {
		throw new Error("A system error occurred: getifaddrs returned an error");
	};
	try {
		const id = collectIdentity();
		expect(id.hostname).toBe(os.hostname());
		expect(id.addresses).toEqual([]);
	} finally {
		(os as { networkInterfaces: unknown }).networkInterfaces = real;
	}
});
