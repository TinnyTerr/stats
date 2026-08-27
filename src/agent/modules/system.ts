import { type SystemProbe, selectProbe } from "../../collect/probe.ts";
import { MODULES } from "../../modules/manifest.ts";
import type { NodeModule } from "./mod.ts";

/**
 * CPU, memory, disks, network and temperatures — whatever the host's probe can
 * answer.
 *
 * This module used to be Linux with the platform left implicit. It is now the
 * platform-neutral half: it picks the probe for the host it woke up on (see
 * src/collect/probe.ts) and has no idea whether the answers came from /proc,
 * from `vm_stat` or from a CIM query.
 *
 * It is also no longer required. Hostname and address are the node's core
 * report — see src/agent/identity.ts — so a host whose platform has no probe
 * yet drops this module and keeps everything else, which is what makes bringing
 * up a new platform additive rather than a precondition.
 */

/** Resolved once: the probe can't change under a running node. */
let probe: SystemProbe | null | undefined;

async function resolveProbe(): Promise<SystemProbe | null> {
	if (probe === undefined) probe = await selectProbe();
	return probe;
}

/** Test seam — a probe for a platform this process isn't running on. */
export function setSystemProbe(next: SystemProbe | null | undefined) {
	probe = next;
}

export const systemModule: NodeModule = {
	manifest: MODULES.system,

	/**
	 * Two questions in one: is there a probe for this platform, and does it work
	 * on this particular host. A stub probe answers false to the second, which is
	 * how a declared-but-unwritten platform stays honest.
	 */
	async available() {
		const found = await resolveProbe();
		return found ? await found.available() : false;
	},

	async collect() {
		const found = await resolveProbe();
		// `available` already ran, so this is the belt to that braces: a throw here
		// would land in telemetry.errors and the card would show it, which is the
		// right outcome but a worse message than simply having no system section.
		if (!found) return {};
		const [stats, facts] = await Promise.all([found.stats(), found.facts()]);
		return { stats, facts };
	},

	actions: {
		"facts.refresh": async () => {
			const found = await resolveProbe();
			if (!found) return null;
			return await found.facts(true);
		},
	},
};
