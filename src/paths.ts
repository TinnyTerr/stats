import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a node keeps state that outlives a process: installed modules, the
 * fleet CA it trusts. One answer, so the module store and the `ca` module
 * can't drift apart on where "the state directory" is.
 *
 * systemd's StateDirectory= creates and chowns this for us and — under
 * ProtectHome — is the only writable state directory a non-root unit has, so
 * it wins when set. Root outside systemd keeps the same path; anyone else gets
 * their own data directory.
 */
export function stateDir(): string {
	if (process.env.STATE_DIRECTORY) return process.env.STATE_DIRECTORY;
	if (process.getuid?.() === 0) return "/var/lib/stats";
	if (process.platform === "win32") {
		return join(
			process.env.LOCALAPPDATA ?? process.env.APPDATA ?? homedir(),
			"stats",
		);
	}
	return join(homedir(), ".local", "share", "stats");
}
