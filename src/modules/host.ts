import { readdir, readFile } from "node:fs/promises";
import {
	isPrivilegedGrant,
	type ModuleGrant,
	type ModuleManifest,
	OPEN_GRANTS,
} from "./manifest.ts";

/**
 * The only way a module touches anything outside itself.
 *
 * A module declares its grants in the manifest and gets a host wired to exactly
 * those: ask for something you didn't declare and you get a {@link ModuleDenied}
 * rather than the resource. The open set is deliberately small — HTTP, a
 * WebSocket, a unix socket, reading a file — and that is all a new module
 * should ever need. `exec` and `pty` hand over the machine, so they are
 * privileged: a module holding one has to be named in the policy's trust list,
 * and the loader refuses to start it otherwise.
 *
 * The in-tree modules under src/agent/modules/ are the privileged
 * implementations behind those two grants: they delegate to src/collect/*,
 * which shells out to systemctl, ps and journalctl. Anything loaded from
 * outside the tree gets the open set unless an operator says otherwise, which
 * is the point of keeping the surface here rather than in each module.
 */

export class ModuleDenied extends Error {
	constructor(
		readonly moduleId: string,
		readonly grant: ModuleGrant,
		detail: string,
	) {
		super(`module '${moduleId}' is not allowed to ${grant}: ${detail}`);
		this.name = "ModuleDenied";
	}
}

export interface ModulePolicy {
	/** grants any module may hold; privileged ones need `trusted` as well */
	open: readonly ModuleGrant[];
	/** module ids permitted to hold `exec` or `pty` */
	trusted: Set<string>;
	/** absolute path prefixes `readFile` and `readDir` will serve */
	readRoots: string[];
	/** unix socket paths `socket()` will dial */
	sockets: string[];
	/** hostnames `fetch()` and `websocket()` will reach; ["*"] for anywhere */
	hosts: string[];
}

/**
 * What a node runs with out of the box: read the places telemetry comes from,
 * dial the docker socket, reach anywhere over HTTP, and trust the modules that
 * ship in this repo with exec and pty.
 */
export function defaultPolicy(trusted: Iterable<string>): ModulePolicy {
	return {
		open: OPEN_GRANTS,
		trusted: new Set(trusted),
		readRoots: ["/proc", "/sys", "/etc", "/run", "/var/log", "/usr/lib"],
		sockets: [process.env.DOCKER_SOCKET ?? "/var/run/docker.sock"],
		hosts: ["*"],
	};
}

/**
 * Checked before a module is loaded, not when it first misbehaves: a module
 * asking for more than the policy allows is a configuration problem, and the
 * operator should hear about it at startup.
 */
export function checkGrants(
	manifest: ModuleManifest,
	policy: ModulePolicy,
): string[] {
	const problems: string[] = [];
	for (const grant of manifest.grants) {
		if (isPrivilegedGrant(grant)) {
			if (!policy.trusted.has(manifest.id)) {
				problems.push(
					`module '${manifest.id}' needs the privileged '${grant}' grant but is not trusted`,
				);
			}
			continue;
		}
		if (!policy.open.includes(grant)) {
			problems.push(
				`module '${manifest.id}' needs '${grant}', which this hub's policy does not allow`,
			);
		}
	}
	return problems;
}

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ModuleHost {
	/** reads a file under one of the policy's roots */
	readFile(path: string): Promise<string>;
	readDir(path: string): Promise<string[]>;
	/** an ordinary HTTP request, host-allowlisted */
	fetch(url: string, init?: RequestInit): Promise<Response>;
	websocket(url: string, protocols?: string | string[]): WebSocket;
	/** HTTP over a unix socket — how the docker module reaches the engine */
	socket(
		socketPath: string,
		url: string,
		init?: RequestInit,
	): Promise<Response>;
	/** privileged: run a command to completion */
	exec(argv: string[], opts?: { cwd?: string }): Promise<ExecResult>;
	/** privileged: spawn a process, optionally on a pty */
	spawn(argv: string[], opts?: Record<string, unknown>): unknown;
}

function normalise(path: string): string {
	return path.replace(/\/+$/, "");
}

export function createModuleHost(
	manifest: ModuleManifest,
	policy: ModulePolicy,
): ModuleHost {
	const id = manifest.id;
	const held = new Set(manifest.grants);

	const require = (grant: ModuleGrant, detail: string) => {
		if (!held.has(grant)) throw new ModuleDenied(id, grant, detail);
		if (isPrivilegedGrant(grant) && !policy.trusted.has(id)) {
			throw new ModuleDenied(id, grant, "this module is not trusted");
		}
	};

	const readable = (path: string) => {
		require("read", path);
		if (!path.startsWith("/") || path.includes(".."))
			throw new ModuleDenied(id, "read", `'${path}' is not an absolute path`);
		const root = policy.readRoots.find(
			(dir) => path === normalise(dir) || path.startsWith(`${normalise(dir)}/`),
		);
		if (!root)
			throw new ModuleDenied(id, "read", `'${path}' is outside the read roots`);
	};

	const reachable = (grant: "http" | "ws", url: string) => {
		require(grant, url);
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new ModuleDenied(id, grant, `'${url}' is not a URL`);
		}
		if (policy.hosts.includes("*") || policy.hosts.includes(parsed.hostname))
			return;
		throw new ModuleDenied(
			id,
			grant,
			`host '${parsed.hostname}' is not allowed`,
		);
	};

	return {
		async readFile(path) {
			readable(path);
			return await readFile(path, "utf8");
		},

		async readDir(path) {
			readable(path);
			return await readdir(path);
		},

		async fetch(url, init) {
			reachable("http", url);
			return await fetch(url, init);
		},

		websocket(url, protocols) {
			reachable("ws", url);
			return new WebSocket(url, protocols);
		},

		async socket(socketPath, url, init) {
			require("socket", socketPath);
			if (!policy.sockets.includes(socketPath)) {
				throw new ModuleDenied(
					id,
					"socket",
					`'${socketPath}' is not in the allowed sockets`,
				);
			}
			return await fetch(url, { ...init, unix: socketPath });
		},

		async exec(argv, opts) {
			require("exec", argv[0] ?? "");
			const proc = Bun.spawn(argv, {
				cwd: opts?.cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { code, stdout, stderr };
		},

		spawn(argv, opts) {
			// A pty is the strictly bigger ask, so a module holding it may spawn
			// plainly too; one without it still needs `exec`.
			require(held.has("pty") ? "pty" : "exec", argv[0] ?? "");
			return Bun.spawn(argv, opts as never);
		},
	};
}
