import { readdir, readFile } from "node:fs/promises";
import {
	ALL_GRANTS,
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
 *
 * All of that is the *unprivileged* half. A node running as root gets
 * {@link rootPolicy} instead and nothing here refuses it anything: see the
 * comment on that function for why a fence inside a root process is furniture
 * rather than a boundary. The manifest's grants survive either way as a
 * declaration — what `stats modules install` prints and what the module page
 * shows — they simply stop being enforced once the node is uid 0.
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
	/**
	 * Every grant is held, every path is readable, every socket and host is
	 * reachable and every module is trusted. Set by {@link rootPolicy} and read
	 * by every check in this file; absent means the fields below are the truth.
	 */
	unrestricted?: boolean;
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
 * Whether this process is root, which is the only question the permissive path
 * asks. `process.getuid` doesn't exist on Windows and reads as "no" there — the
 * restricted policy is the honest answer for a host we can't ask.
 */
export function isRoot(): boolean {
	return process.getuid?.() === 0;
}

/**
 * What a root node runs with: everything.
 *
 * A policy is only a boundary when something on the other side of it can't be
 * reached anyway. A node running as uid 0 can already read any file, dial any
 * socket and spawn any process, and a module denied `exec` by this file is one
 * `Bun.spawn` away from having it — same process, same uid, no wall in
 * between. So under root the enforcement stops pretending: it buys no safety
 * and costs an operator an evening working out why their module won't load.
 *
 * The real confinement moved outward, to who is allowed to run the node as
 * root in the first place, and to the hub — which is the source of truth for
 * what a node should be doing at all. Neither is this file's business.
 *
 * The fields are still filled in rather than emptied. `unrestricted` is what
 * every check actually reads; these values are what the rest of them mean if
 * something reads one directly.
 */
export function rootPolicy(): ModulePolicy {
	return {
		unrestricted: true,
		open: ALL_GRANTS,
		trusted: new Set<string>(),
		readRoots: ["/"],
		sockets: [],
		hosts: ["*"],
	};
}

/**
 * The policy this process should actually run under, which is the only choice
 * the agent makes: root gets everything, anyone else gets the restricted set,
 * because there the policy is the one thing standing between a module and the
 * account the node runs as. Callers wanting a specific answer regardless of
 * who they are — tests, mostly — call {@link defaultPolicy} or
 * {@link rootPolicy} directly.
 */
export function hostPolicy(
	trusted: Iterable<string>,
	root: boolean = isRoot(),
): ModulePolicy {
	return root ? rootPolicy() : defaultPolicy(trusted);
}

/**
 * Checked before a module is loaded, not when it first misbehaves: a module
 * asking for more than the policy allows is a configuration problem, and the
 * operator should hear about it at startup. Under an unrestricted policy there
 * is nothing to report — every grant is allowed and the manifest is a
 * declaration, not a request.
 */
export function checkGrants(
	manifest: ModuleManifest,
	policy: ModulePolicy,
): string[] {
	if (policy.unrestricted) return [];
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
		if (policy.unrestricted) return;
		if (!held.has(grant)) throw new ModuleDenied(id, grant, detail);
		if (isPrivilegedGrant(grant) && !policy.trusted.has(id)) {
			throw new ModuleDenied(id, grant, "this module is not trusted");
		}
	};

	const readable = (path: string) => {
		require("read", path);
		if (policy.unrestricted) return;
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
		if (policy.unrestricted) return;
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
			if (!policy.unrestricted && !policy.sockets.includes(socketPath)) {
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
