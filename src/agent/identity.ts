import os from "node:os";
import { currentPlatform } from "../modules/platform.ts";
import type { HostIdentity } from "../types.ts";

/**
 * The node's core report: who it is and where it is.
 *
 * This is the whole of what the agent collects on its own. Every other field in
 * a telemetry frame comes from a module, which is what lets a node run on a
 * platform none of the collectors support yet — it connects, it appears in the
 * fleet, and its card says the true thing (a name and an address) instead of
 * being absent or full of zeroes.
 *
 * Nothing here shells out or reads a file, on purpose: `os.hostname()` and
 * `os.networkInterfaces()` are the two calls Bun implements the same way on
 * every platform it builds for, so this function needs no probe of its own.
 */
export function collectIdentity(): HostIdentity {
	return {
		hostname: os.hostname(),
		addresses: interfaceAddresses(),
		platform: currentPlatform() ?? process.platform,
		arch: process.arch,
	};
}

/**
 * `os.networkInterfaces()` *throws* when the host refuses the call — a systemd
 * unit whose `RestrictAddressFamilies=` omits `AF_NETLINK` blocks the
 * `getifaddrs()` behind it, and the hub's own unit did exactly that. A node
 * that can't see its addresses still knows its name, which is a true report;
 * crashing the process that was only trying to introduce itself is not.
 */
function interfaceAddresses(): string[] {
	const addresses: string[] = [];
	let interfaces: ReturnType<typeof os.networkInterfaces>;
	try {
		interfaces = os.networkInterfaces();
	} catch (err) {
		console.warn(
			`identity: no network addresses (${err instanceof Error ? err.message : String(err)})`,
		);
		return addresses;
	}
	for (const entries of Object.values(interfaces)) {
		for (const entry of entries ?? []) {
			// Loopback tells you nothing about where a node is, and link-local
			// IPv6 is per-interface noise that would differ on every tick.
			if (entry.internal) continue;
			if (entry.family === "IPv6" && entry.address.startsWith("fe80")) continue;
			addresses.push(entry.address);
		}
	}
	return addresses;
}
