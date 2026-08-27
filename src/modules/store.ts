import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { $ } from "bun";
import { type ExternalManifest, parseExternalManifest } from "./external.ts";
import { BUILTIN_MODULE_IDS } from "./manifest.ts";
import { currentPlatform, resolveEntry } from "./platform.ts";

/**
 * Where installed modules live, and how they get there.
 *
 * One module is one git repository, checked out into its own directory under
 * the store. Git is the whole distribution mechanism: no registry to run, no
 * package format to invent, and `git log` in the module's directory is a
 * complete answer to "what changed and who changed it". The commit is recorded
 * at install time so `stats modules` can say exactly what is running.
 *
 * Installing a module means agreeing to run its code on that host. Nothing here
 * pretends otherwise — the CLI says so, and the grant policy in
 * src/modules/host.ts is what actually holds the line: an installed module gets
 * the open grants and nothing else unless an operator names it in
 * `trustedModules`.
 */

export const MANIFEST_FILE = "stats.module.json";

/** Metadata the installer leaves behind, so a checkout knows where it came from. */
const RECORD_FILE = ".stats-install.json";

export interface InstallRecord {
	source: string;
	ref: string | null;
	commit: string | null;
	installedAt: number;
}

export interface InstalledModule {
	manifest: ExternalManifest;
	/** absolute path to the module's directory */
	dir: string;
	record: InstallRecord;
}

/** A module directory that exists but can't be used, and why. */
export interface BrokenModule {
	dir: string;
	id: string;
	problems: string[];
}

/**
 * Root-run nodes keep modules with the rest of their state; a node running as
 * you keeps them in your data directory. STATS_MODULE_DIR overrides both, which
 * is what the tests use.
 */
export function moduleStoreDir(): string {
	const override = process.env.STATS_MODULE_DIR;
	if (override) return resolve(override);
	const uid = process.getuid?.();
	if (uid === 0) return "/var/lib/stats/modules";
	return join(homedir(), ".local", "share", "stats", "modules");
}

async function isDirectory(path: string): Promise<boolean> {
	return await stat(path)
		.then((entry) => entry.isDirectory())
		.catch(() => false);
}

/* ---------- reading the store ---------- */

/**
 * `expectDirName` is on for anything already in the store and off while a clone
 * is still sitting in a scratch directory, which by definition isn't named
 * after the module yet.
 */
async function readModule(
	dir: string,
	expectDirName = true,
): Promise<InstalledModule | BrokenModule> {
	const id = dir.split("/").pop() ?? dir;
	const manifestFile = Bun.file(join(dir, MANIFEST_FILE));
	if (!(await manifestFile.exists())) {
		return { dir, id, problems: [`no ${MANIFEST_FILE}`] };
	}

	let raw: unknown;
	try {
		raw = await manifestFile.json();
	} catch (err) {
		return {
			dir,
			id,
			problems: [
				`${MANIFEST_FILE} is not valid JSON: ${err instanceof Error ? err.message : err}`,
			],
		};
	}

	const { manifest, problems } = parseExternalManifest(raw, BUILTIN_MODULE_IDS);
	if (!manifest) return { dir, id, problems };

	// The directory name is the id the config refers to, so a manifest that
	// renamed itself after install would answer to a name nothing can switch off.
	if (expectDirName && manifest.id !== id) {
		return {
			dir,
			id,
			problems: [
				`the manifest calls this module '${manifest.id}' but it is installed as '${id}' — reinstall it`,
			],
		};
	}

	// A module can be installed on a host it doesn't run on — that isn't broken,
	// it's a module for a different platform sitting in a store shared by a fleet.
	// The loader is what drops it; the store only refuses to lie about the entry.
	const platform = currentPlatform();
	const entryPath = resolveEntry(manifest.entry, platform);
	if (entryPath) {
		const entry = resolve(dir, entryPath);
		if (!entry.startsWith(`${dir}/`)) {
			return {
				dir,
				id,
				problems: [`entry '${entryPath}' escapes the module`],
			};
		}
		if (!(await Bun.file(entry).exists())) {
			return { dir, id, problems: [`entry '${entryPath}' does not exist`] };
		}
	}

	const record = (await Bun.file(join(dir, RECORD_FILE))
		.json()
		.catch(() => null)) as InstallRecord | null;

	return {
		manifest,
		dir,
		record: record ?? {
			source: "unknown",
			ref: null,
			commit: null,
			installedAt: 0,
		},
	};
}

export function isBroken(
	module: InstalledModule | BrokenModule,
): module is BrokenModule {
	return "problems" in module;
}

/** Everything in the store, usable or not, sorted by id. */
export async function listModules(
	storeDir = moduleStoreDir(),
): Promise<(InstalledModule | BrokenModule)[]> {
	if (!(await isDirectory(storeDir))) return [];
	const entries = await readdir(storeDir);
	const modules: (InstalledModule | BrokenModule)[] = [];
	for (const entry of entries.sort()) {
		if (entry.startsWith(".")) continue;
		const dir = join(storeDir, entry);
		if (!(await isDirectory(dir))) continue;
		modules.push(await readModule(dir));
	}
	return modules;
}

/** Just the ones a node can actually load. */
export async function installedModules(
	storeDir = moduleStoreDir(),
): Promise<InstalledModule[]> {
	return (await listModules(storeDir)).filter(
		(module): module is InstalledModule => !isBroken(module),
	);
}

/* ---------- git ---------- */

/**
 * Accepts what someone would paste: a full URL, an `scp`-style git address, a
 * `github:owner/repo` or bare `owner/repo` shorthand, or a path to a repository
 * on this machine.
 */
export function resolveSource(spec: string): string {
	const raw = spec.trim();
	if (!raw) throw new Error("no repository given");

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
	if (/^[^/]+@[^/]+:/.test(raw)) return raw; // git@host:owner/repo.git
	if (raw.startsWith("github:")) {
		return `https://github.com/${raw.slice("github:".length)}`;
	}
	if (raw.startsWith(".") || isAbsolute(raw)) return resolve(raw);
	if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;

	throw new Error(
		`'${spec}' doesn't look like a repository — try a URL, owner/repo, or a path`,
	);
}

async function git(cwd: string, args: string[]): Promise<string> {
	const out = await $`git ${args}`.cwd(cwd).nothrow().quiet();
	if (out.exitCode !== 0) {
		throw new Error(
			out.stderr.toString().trim() ||
				`git ${args.join(" ")} exited ${out.exitCode}`,
		);
	}
	return out.stdout.toString().trim();
}

async function headCommit(dir: string): Promise<string | null> {
	return await git(dir, ["rev-parse", "HEAD"]).catch(() => null);
}

/* ---------- installing ---------- */

export interface InstallResult {
	module: InstalledModule;
	/** true when this replaced an existing checkout of the same id */
	replaced: boolean;
}

export interface InstallOptions {
	/** branch or tag; the repository's default when omitted */
	ref?: string;
	/** replace an id that is already installed */
	force?: boolean;
	storeDir?: string;
}

/**
 * Clones into a scratch directory first and only moves it into place once the
 * manifest has been read and accepted. A half-installed module in the store
 * would be loaded on the next node restart, which is not the kind of thing to
 * find out about at three in the morning.
 */
export async function installModule(
	spec: string,
	options: InstallOptions = {},
): Promise<InstallResult> {
	const storeDir = options.storeDir ?? moduleStoreDir();
	const source = resolveSource(spec);
	await mkdir(storeDir, { recursive: true });

	const scratch = join(storeDir, `.tmp-${Date.now().toString(36)}`);
	await rm(scratch, { recursive: true, force: true });

	try {
		await git(storeDir, [
			"clone",
			"--depth",
			"1",
			...(options.ref ? ["--branch", options.ref] : []),
			source,
			scratch,
		]);

		const candidate = await readModule(scratch, false);
		if (isBroken(candidate)) {
			throw new Error(
				`${source} is not a stats module:\n  - ${candidate.problems.join("\n  - ")}`,
			);
		}

		const manifest = candidate.manifest;
		const target = join(storeDir, manifest.id);
		const existed = await isDirectory(target);
		if (existed && !options.force) {
			throw new Error(
				`module '${manifest.id}' is already installed — pass --force to replace it`,
			);
		}

		const record: InstallRecord = {
			source,
			ref: options.ref ?? null,
			commit: await headCommit(scratch),
			installedAt: Date.now(),
		};
		await Bun.write(
			join(scratch, RECORD_FILE),
			`${JSON.stringify(record, null, "\t")}\n`,
		);

		if (existed) await rm(target, { recursive: true, force: true });
		await rename(scratch, target);

		const installed = await readModule(target);
		if (isBroken(installed)) {
			throw new Error(installed.problems.join("; "));
		}
		return { module: installed, replaced: existed };
	} finally {
		await rm(scratch, { recursive: true, force: true }).catch(() => {});
	}
}

/** Fast-forwards a checkout to whatever its source has now. */
export async function updateModule(
	id: string,
	storeDir = moduleStoreDir(),
): Promise<{
	module: InstalledModule;
	from: string | null;
	to: string | null;
}> {
	const dir = await moduleDir(id, storeDir);
	const from = await headCommit(dir);

	const record = (await Bun.file(join(dir, RECORD_FILE))
		.json()
		.catch(() => null)) as InstallRecord | null;

	await git(dir, [
		"fetch",
		"--depth",
		"1",
		"origin",
		...(record?.ref ? [record.ref] : []),
	]);
	await git(dir, ["reset", "--hard", "FETCH_HEAD"]);

	const updated = await readModule(dir);
	if (isBroken(updated)) {
		// The checkout is now whatever upstream says, and upstream broke it. Say
		// so loudly rather than leaving a module that silently stops loading.
		throw new Error(
			`'${id}' no longer parses after updating:\n  - ${updated.problems.join("\n  - ")}`,
		);
	}

	const to = await headCommit(dir);
	if (record) {
		await Bun.write(
			join(dir, RECORD_FILE),
			`${JSON.stringify({ ...record, commit: to }, null, "\t")}\n`,
		);
	}
	return { module: updated, from, to };
}

async function moduleDir(id: string, storeDir: string): Promise<string> {
	// The id becomes a path, so it gets the same treatment as any other untrusted
	// segment even though it usually came from a manifest we already validated.
	if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) {
		throw new Error(`'${id}' is not a module id`);
	}
	const dir = join(storeDir, id);
	if (!(await isDirectory(dir))) {
		throw new Error(`module '${id}' is not installed`);
	}
	return dir;
}

export async function removeModule(
	id: string,
	storeDir = moduleStoreDir(),
): Promise<string> {
	const dir = await moduleDir(id, storeDir);
	await rm(dir, { recursive: true, force: true });
	return dir;
}
