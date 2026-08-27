import { stat } from "node:fs/promises";
import { collectFacts } from "../facts.ts";
import type { SystemProbe } from "../probe.ts";
import { collectSystem } from "../system.ts";

/**
 * The Linux probe: /proc, /sys, `df`, and the os-release family. This is the
 * implementation the rest of the codebase grew up around, so the file is thin —
 * everything it does still lives in ../system.ts and ../facts.ts, and this is
 * only the row that plugs them into {@link SystemProbe}.
 */
export const linuxProbe: SystemProbe = {
	platform: "linux",

	/**
	 * /proc/stat rather than /proc: a container with a hidden or partial procfs
	 * mounts the directory but not the file, and the file is the one every
	 * collector here actually opens.
	 */
	async available() {
		return await stat("/proc/stat")
			.then((entry) => entry.isFile())
			.catch(() => false);
	},

	stats: () => collectSystem(),
	facts: (force = false) => collectFacts(force),
};
