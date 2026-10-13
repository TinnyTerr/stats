import { readdir, readFile } from "node:fs/promises";
import type { ModuleManifest } from "./manifest.ts";

/**
 * The only way a module touches anything outside itself.
 *
 * There is no filtering here. A node is installed as root, and a fence inside a
 * root process is furniture: the module it stops is one `Bun.spawn` from what
 * it was denied. The manifest's grants survive as a declaration — what
 * `stats modules install` prints and what the module page shows — but nothing
 * checks them. The confinement is who can reach the hub, not what a node will
 * do once asked.
 */

/**
 * Whether this process is root. `process.getuid` doesn't exist on Windows and
 * reads as "no" there.
 */
export function isRoot(): boolean {
	return process.getuid?.() === 0;
}

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ModuleHost {
	/** reads a file */
	readFile(path: string): Promise<string>;
	readDir(path: string): Promise<string[]>;
	/** an ordinary HTTP request */
	fetch(url: string, init?: RequestInit): Promise<Response>;
	websocket(url: string, protocols?: string | string[]): WebSocket;
	/** HTTP over a unix socket — how the docker module reaches the engine */
	socket(
		socketPath: string,
		url: string,
		init?: RequestInit,
	): Promise<Response>;
	/**
	 * privileged: run a command to completion. `timeoutMs` is what a collector
	 * on a telemetry tick wants — a command that never returns costs the frame,
	 * so the killed process is a failure it can report rather than a hang.
	 */
	exec(
		argv: string[],
		opts?: { cwd?: string; timeoutMs?: number },
	): Promise<ExecResult>;
	/** spawn a process, optionally on a pty */
	spawn(argv: string[], opts?: Record<string, unknown>): unknown;
}

export function createModuleHost(_manifest: ModuleManifest): ModuleHost {
	return {
		async readFile(path) {
			return await readFile(path, "utf8");
		},

		async readDir(path) {
			return await readdir(path);
		},

		async fetch(url, init) {
			return await fetch(url, init);
		},

		websocket(url, protocols) {
			return new WebSocket(url, protocols);
		},

		async socket(socketPath, url, init) {
			return await fetch(url, { ...init, unix: socketPath });
		},

		async exec(argv, opts) {
			const proc = Bun.spawn(argv, {
				cwd: opts?.cwd,
				stdout: "pipe",
				stderr: "pipe",
				timeout: opts?.timeoutMs,
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { code, stdout, stderr };
		},

		spawn(argv, opts) {
			return Bun.spawn(argv, opts as never);
		},
	};
}
