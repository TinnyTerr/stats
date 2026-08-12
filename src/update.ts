import { createReadStream, createWriteStream } from "node:fs";
import { chmod, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { $ } from "bun";
import { compareVersions, VERSION } from "./version.ts";

/**
 * Replacing the binary with a newer one, from the machine it's running on.
 *
 * This is install.sh's job done from inside the executable, and it makes the
 * same promises: pick the build this CPU can actually run, check it against the
 * published checksums, prove it starts *before* it becomes the thing systemd
 * restarts, and swap it atomically so a running service doesn't get ETXTBSY.
 *
 * It deliberately resolves the release itself rather than being handed a URL.
 * That matters for the hub-driven path in src/agent/agent.ts: the hub can ask a
 * node to update, but it cannot say where from, so "update" can never turn into
 * "run this". The node trusts its own repo and nothing else.
 */

export interface UpdateSource {
	/** the forge's host, e.g. git.tinnyterr.com or github.com */
	host: string;
	/** owner/repo */
	repo: string;
}

/** Matches install.sh's STATS_HOST / STATS_REPO, so both agree on "latest". */
export function defaultSource(): UpdateSource {
	return {
		host: process.env.STATS_HOST ?? "git.tinnyterr.com",
		repo: process.env.STATS_REPO ?? "tinnyterr/stats",
	};
}

export class UpdateError extends Error {}

/* ---------- which build this machine can run ---------- */

async function exists(path: string): Promise<boolean> {
	return await stat(path)
		.then(() => true)
		.catch(() => false);
}

/**
 * The same four questions install.sh asks — OS, architecture, libc, and whether
 * an x86-64 CPU has AVX2. Getting this wrong is the difference between an
 * update and "Illegal instruction (core dumped)" on the next restart.
 */
export async function detectAsset(): Promise<string> {
	const override = process.env.STATS_ASSET;
	if (override) return override;

	const arch =
		process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
	if (!arch) {
		throw new UpdateError(
			`${process.arch} is not supported — stats ships 64-bit builds only`,
		);
	}
	if (process.platform === "darwin") return `stats-darwin-${arch}`;
	if (process.platform !== "linux") {
		throw new UpdateError(
			`${process.platform} is not supported — stats is Linux-only (macOS runs the hub only)`,
		);
	}

	const musl =
		(await exists("/lib/ld-musl-x86_64.so.1")) ||
		(await exists("/lib/ld-musl-aarch64.so.1"));

	// Only x86-64 has a baseline build; arm64 has no equivalent split.
	let baseline = "";
	if (arch === "x64") {
		const cpuinfo = await Bun.file("/proc/cpuinfo")
			.text()
			.catch(() => "");
		if (cpuinfo && !/\savx2\b/.test(cpuinfo)) baseline = "-baseline";
	}

	return `stats-linux-${arch}${musl ? "-musl" : ""}${baseline}`;
}

/* ---------- the release ---------- */

function releaseApi(source: UpdateSource): string {
	return source.host === "github.com"
		? `https://api.github.com/repos/${source.repo}/releases/latest`
		: `https://${source.host}/api/v1/repos/${source.repo}/releases/latest`;
}

export function downloadBase(source: UpdateSource, tag: string): string {
	return `https://${source.host}/${source.repo}/releases/download/${tag}`;
}

/** Release tags are a path segment and a filename; treat them as untrusted. */
export function isValidTag(tag: string): boolean {
	return /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag);
}

export async function resolveLatest(
	source: UpdateSource = defaultSource(),
): Promise<string> {
	let response: Response;
	try {
		response = await fetch(releaseApi(source), {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(20_000),
		});
	} catch (err) {
		throw new UpdateError(
			`couldn't reach ${source.host}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!response.ok) {
		throw new UpdateError(
			`${releaseApi(source)} returned ${response.status} ${response.statusText}`,
		);
	}

	const body = (await response.json()) as { tag_name?: string };
	const tag = body.tag_name?.trim();
	if (!tag) {
		throw new UpdateError(
			`no tag_name in the latest release from ${source.host}`,
		);
	}
	if (!isValidTag(tag)) {
		throw new UpdateError(`the latest release tag '${tag}' is not a version`);
	}
	return tag;
}

export interface UpdateCheck {
	current: string;
	latest: string;
	/** the release is newer than what's running */
	behind: boolean;
	asset: string;
	source: UpdateSource;
}

export async function checkForUpdate(
	source: UpdateSource = defaultSource(),
): Promise<UpdateCheck> {
	const latest = await resolveLatest(source);
	return {
		current: VERSION,
		latest,
		behind: compareVersions(latest, VERSION) > 0,
		asset: await detectAsset(),
		source,
	};
}

/* ---------- applying it ---------- */

/**
 * True when this is a `bun build --compile` executable rather than `bun
 * index.ts`. Only the former has a binary worth replacing — from source, the
 * answer to "update" is `git pull`.
 */
export function isCompiledBinary(): boolean {
	return Bun.main.startsWith("/$bunfs/");
}

/**
 * Streams a download to disk, hashing as it goes.
 *
 * One pass and bounded memory, which matters twice over: `Bun.write(path,
 * response)` doesn't complete for a body this size, and buffering a ~100 MB
 * binary would be a rude thing to do to the smallest node in a fleet.
 */
async function downloadHashed(url: string, dest: string): Promise<string> {
	let response: Response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
	} catch (err) {
		throw new UpdateError(
			`couldn't download ${url}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!response.ok) {
		throw new UpdateError(
			`${url} returned ${response.status} ${response.statusText}`,
		);
	}
	if (!response.body) throw new UpdateError(`${url} returned an empty body`);

	const hasher = new Bun.CryptoHasher("sha256");
	const writer = Bun.file(dest).writer();
	const reader = response.body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			hasher.update(value);
			writer.write(value);
		}
	} finally {
		await writer.end();
	}
	return hasher.digest("hex");
}

/** SHA256SUMS is `<hex>  <name>` per line. Null when the asset isn't listed. */
function findSum(sums: string, asset: string): string | null {
	for (const line of sums.split("\n")) {
		const [hex, name] = line.trim().split(/\s+/);
		if (name === asset && hex) return hex;
	}
	return null;
}

/** Inflates through a pipe rather than in memory — see {@link downloadHashed}. */
async function gunzipToFile(source: string, dest: string): Promise<void> {
	await pipeline(
		createReadStream(source),
		createGunzip(),
		createWriteStream(dest),
	);
}

export interface ApplyOptions {
	source?: UpdateSource;
	/** the tag to install; the latest release when omitted */
	version?: string;
	/** where the running binary is; process.execPath by default */
	binary?: string;
}

export interface ApplyResult {
	from: string;
	to: string;
	asset: string;
	binary: string;
}

/**
 * Downloads, verifies, proves it runs, and swaps it in. Everything happens
 * beside the target rather than in /tmp: the rename at the end has to be within
 * one filesystem to be atomic, and an update that fell back to a copy would
 * have a window where the binary is half-written.
 */
/**
 * One update at a time per process. Two overlapping calls would stage to the
 * same path and race each other onto the binary — and the obvious way to cause
 * that is an impatient second click while the first download is still running.
 */
let inFlight: Promise<ApplyResult> | null = null;

export function applyUpdate(options: ApplyOptions = {}): Promise<ApplyResult> {
	if (inFlight) return inFlight;
	inFlight = runUpdate(options).finally(() => {
		inFlight = null;
	});
	return inFlight;
}

async function runUpdate(options: ApplyOptions): Promise<ApplyResult> {
	if (!isCompiledBinary()) {
		throw new UpdateError(
			"this is running from source, so there is no binary to replace — use git pull, or build with `bun run build`",
		);
	}

	const source = options.source ?? defaultSource();
	const binary = options.binary ?? process.execPath;
	const asset = await detectAsset();

	const tag = options.version ?? (await resolveLatest(source));
	if (!isValidTag(tag)) throw new UpdateError(`'${tag}' is not a release tag`);

	const base = downloadBase(source, tag);
	const dir = dirname(binary);
	const staged = join(dir, `.stats-update-${process.pid}`);
	const compressed = `${staged}.gz`;

	// Writing next to the binary means we find out about a read-only /usr/local
	// or a full disk now, rather than half way through the swap.
	try {
		await Bun.write(staged, "");
	} catch (err) {
		throw new UpdateError(
			`can't write to ${dir}: ${err instanceof Error ? err.message : String(err)} — run this as the user that owns ${binary}`,
		);
	}

	try {
		const sums = await fetch(`${base}/SHA256SUMS`, {
			signal: AbortSignal.timeout(60_000),
		})
			.then((res) => (res.ok ? res.text() : null))
			.catch(() => null);
		if (!sums) {
			throw new UpdateError(
				`no SHA256SUMS published alongside ${tag} — refusing to install an unverified binary`,
			);
		}

		const mismatch = (name: string, want: string, got: string) =>
			new UpdateError(
				`checksum mismatch for ${name}\n  expected ${want}\n  got      ${got}`,
			);

		// The gzipped asset is about a third of the size, so it's preferred; the
		// raw one is for releases that don't publish it. Which file to fetch is
		// decided by what SHA256SUMS lists, never by a download failing — a bad
		// checksum must never be a reason to go and try the other one.
		const gzWant = findSum(sums, `${asset}.gz`);
		if (gzWant) {
			const got = await downloadHashed(`${base}/${asset}.gz`, compressed);
			if (got !== gzWant) throw mismatch(`${asset}.gz`, gzWant, got);
			await gunzipToFile(compressed, staged);
		} else {
			const want = findSum(sums, asset);
			if (!want) {
				throw new UpdateError(
					`${asset} is not listed in ${tag}'s SHA256SUMS — this release has no build for this machine`,
				);
			}
			const got = await downloadHashed(`${base}/${asset}`, staged);
			if (got !== want) throw mismatch(asset, want, got);
		}

		await chmod(staged, 0o755);

		// The last gate, and the one that matters most: a binary that can't run
		// here must not become the thing systemd tries to restart.
		const proof = await $`${staged} version`.nothrow().quiet();
		if (proof.exitCode !== 0) {
			throw new UpdateError(
				`the downloaded ${asset} doesn't run on this machine — keeping ${VERSION}.\n` +
					`Force a different build with STATS_ASSET, e.g. STATS_ASSET=stats-linux-x64-baseline`,
			);
		}
		const reported = proof.stdout.toString().trim();

		await rename(staged, binary);
		return { from: VERSION, to: reported, asset, binary };
	} finally {
		await rm(staged, { force: true }).catch(() => {});
		await rm(compressed, { force: true }).catch(() => {});
	}
}

/* ---------- restarting whatever is running us ---------- */

/**
 * The systemd unit this process belongs to, read from its cgroup. Guessing the
 * name from the role would restart the wrong thing on a host running both, or
 * on one where somebody renamed the unit.
 */
export async function currentUnit(): Promise<string | null> {
	const cgroup = await Bun.file("/proc/self/cgroup")
		.text()
		.catch(() => null);
	const match = cgroup?.match(/([\w@.\\-]+\.service)/);
	return match?.[1] ?? null;
}

/**
 * Restarts the unit, which for a self-update means killing the caller. Detached
 * on purpose: `systemctl restart` from inside the unit would otherwise wait for
 * a stop that can't finish until this process exits.
 */
export async function restartUnit(unit: string): Promise<void> {
	Bun.spawn(["systemctl", "restart", unit], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	}).unref();
}
