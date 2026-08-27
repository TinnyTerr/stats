import { ProbeUnimplemented, type SystemProbe } from "../probe.ts";

/**
 * The macOS probe — declared, not yet written.
 *
 * The hub has run on macOS since the beginning and a node never has, so this is
 * the first of the two files that changes that. It reports unavailable rather
 * than throwing, which means a macOS node connects today, shows its hostname
 * and addresses, and runs its portable modules with the `system` card simply
 * absent. Filling this in is additive from there.
 *
 * What it needs, roughly one command each:
 *   cpu     `host_processor_info` via sysctl `hw.ncpu` + `top -l 1` deltas
 *   memory  `vm_stat` pages × `hw.pagesize`, against `hw.memsize`
 *   disks   `df -Pk` — the same parser ../system.ts already has for Linux
 *   net     `netstat -ibn`, deltas kept the way the Linux probe keeps them
 *   temps   requires IOKit; likely stays empty rather than shelling to a helper
 *   facts   `sw_vers`, `sysctl -n machdep.cpu.brand_string`, `uname -r`
 */
export const darwinProbe: SystemProbe = {
	platform: "darwin",

	async available() {
		return false;
	},

	async stats(): Promise<never> {
		throw new ProbeUnimplemented("darwin", "system statistics");
	},

	async facts(): Promise<never> {
		throw new ProbeUnimplemented("darwin", "host facts");
	},
};
