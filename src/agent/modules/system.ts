import { collectFacts } from "../../collect/facts.ts";
import { collectSystem } from "../../collect/system.ts";
import { MODULES } from "../../modules/manifest.ts";
import type { NodeModule } from "./mod.ts";

/**
 * The one module that can't be turned off: without CPU, memory and a hostname
 * a node card has nothing on it. Facts are cached and self-healing, so they
 * ride along here rather than needing a collector of their own.
 */
export const systemModule: NodeModule = {
	manifest: MODULES.system,

	async collect() {
		const [stats, facts] = await Promise.all([collectSystem(), collectFacts()]);
		return { stats, facts };
	},

	actions: {
		"facts.refresh": async () => await collectFacts(true),
	},
};
