import { join } from "node:path";

/**
 * Where a node keeps state that outlives a process: installed modules, the
 * fleet CA it trusts. One answer, so the module store and the `ca` module
 * can't drift apart on where "the state directory" is.
 *
 * It is a system directory, shared by every user on the machine: nodes are
 * installed as root. systemd's StateDirectory= wins when set, since it creates
 * and chowns the path for us.
 */
export function stateDir(): string {
	if (process.env.STATE_DIRECTORY) return process.env.STATE_DIRECTORY;
	if (process.platform === "win32") {
		return join(process.env.ProgramData ?? "C:\\ProgramData", "stats");
	}
	return "/var/lib/stats";
}
