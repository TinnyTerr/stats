import type { Platform } from "../modules/platform.ts";
import { currentPlatform } from "../modules/platform.ts";
import type { HostFacts, SystemStats } from "../types.ts";

/**
 * The seam under the `system` module.
 *
 * `system` used to *be* /proc and /sys — the module and the Linux
 * implementation were the same code, which is why a Windows node was never a
 * few files away but a rewrite. A probe is the platform-shaped half pulled out
 * from behind the module: one per platform, each answering the same two
 * questions, and the module itself knows nothing about how either is answered.
 *
 * Probes are imported lazily and one at a time. A Linux node must never load
 * the Windows probe — not because it would crash today, but because the moment
 * one of them needs a platform-only dependency the import is what breaks, and
 * finding that out at start-up on the wrong host is exactly the failure this
 * layout is meant to prevent.
 */
export interface SystemProbe {
	platform: Platform;

	/**
	 * Whether this probe can actually read this host. A probe exists for a
	 * platform; `available` is whether it works here — a Linux container without
	 * /proc mounted is a real case, and so is a platform whose probe is still a
	 * stub. Returning false drops the `system` module rather than filling the
	 * dashboard with zeroes.
	 */
	available(): Promise<boolean>;

	/** One tick: CPU, memory, disks, network, temperatures. */
	stats(): Promise<SystemStats>;

	/** The slow-moving description of the machine; cached by the probe. */
	facts(force?: boolean): Promise<HostFacts>;
}

/**
 * Lazy constructors, keyed by platform. Adding a platform is a file and a row —
 * which is the whole point of this table existing rather than a switch inside
 * the module.
 */
const PROBES: Partial<Record<Platform, () => Promise<SystemProbe>>> = {
	linux: async () => (await import("./platform/linux.ts")).linuxProbe,
	darwin: async () => (await import("./platform/darwin.ts")).darwinProbe,
	win32: async () => (await import("./platform/win32.ts")).win32Probe,
};

/** Platforms with a probe at all — what the `system` module can claim. */
export function probedPlatforms(): Platform[] {
	return Object.keys(PROBES) as Platform[];
}

/**
 * The probe for a host, or null when there is none. Null is a supported
 * outcome, not an error: the node still connects, still reports its hostname
 * and addresses, and still runs every other module.
 */
export async function selectProbe(
	platform: Platform | null = currentPlatform(),
): Promise<SystemProbe | null> {
	if (!platform) return null;
	const load = PROBES[platform];
	if (!load) return null;
	return await load();
}

/**
 * Thrown by a probe that exists but hasn't been written yet. It carries the
 * platform so the note on the node's card names it, rather than the operator
 * reading "collect failed" and going looking for a broken sensor.
 */
export class ProbeUnimplemented extends Error {
	constructor(
		readonly platform: Platform,
		what: string,
	) {
		super(`${what} is not implemented for ${platform} yet`);
		this.name = "ProbeUnimplemented";
	}
}
