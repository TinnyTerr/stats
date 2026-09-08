#!/usr/bin/env bun
/**
 * Cross-compiles standalone `stats` executables — one per CPU/libc combination
 * we care about — into dist/.
 *
 *   bun run build                       # every Linux target
 *   bun run build --targets linux-x64   # just one
 *   bun run build --host                # only what this machine runs
 *   bun run build --all                 # Linux + the experimental macOS builds
 *
 * Each binary embeds the Bun runtime, the server and the bundled dashboard, so
 * the install target needs nothing preinstalled — no bun, no node, no npm.
 *
 * Cross-compiling downloads the matching Bun runtime (~35 MB per target) into
 * Bun's install cache on first use, so the first run needs network access.
 */

import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

interface Target {
	/** What `bun build --target` calls it. */
	target: string;
	/** Asset name, and what install.sh derives from uname. */
	asset: string;
	note: string;
}

/**
 * Linux is the whole story for this project — the collectors read /proc, /sys,
 * ss, systemctl and the Docker socket, and terminals need a pty — so these are
 * what ship.
 *
 * "baseline" targets drop AVX2 and friends: needed on pre-2013 Intel, early
 * AMD, and quite a lot of cheap VPS hosts that mask CPU features. They are
 * slower, so they are a fallback the installer only picks when it has to.
 */
const LINUX_TARGETS: Target[] = [
	{
		target: "bun-linux-x64",
		asset: "stats-linux-x64",
		note: "glibc, x86-64 with AVX2",
	},
	{
		target: "bun-linux-x64-baseline",
		asset: "stats-linux-x64-baseline",
		note: "glibc, x86-64 without AVX2 (older/masked CPUs)",
	},
	{
		target: "bun-linux-x64-musl",
		asset: "stats-linux-x64-musl",
		note: "musl (Alpine), x86-64 with AVX2",
	},
	{
		target: "bun-linux-x64-musl-baseline",
		asset: "stats-linux-x64-musl-baseline",
		note: "musl (Alpine), x86-64 without AVX2",
	},
	{
		target: "bun-linux-arm64",
		asset: "stats-linux-arm64",
		note: "glibc, arm64 (Pi 4/5 64-bit, Graviton, Ampere)",
	},
	{
		target: "bun-linux-arm64-musl",
		asset: "stats-linux-arm64-musl",
		note: "musl (Alpine), arm64",
	},
];

/**
 * Built only with --all. The hub half runs fine on macOS — it only listens and
 * relays — but every collector is Linux-specific, so a macOS box can never be
 * a node, only the machine the dashboard runs on.
 */
const EXTRA_TARGETS: Target[] = [
	{
		target: "bun-darwin-arm64",
		asset: "stats-darwin-arm64",
		note: "macOS Apple Silicon (hub only)",
	},
	{
		target: "bun-darwin-x64",
		asset: "stats-darwin-x64",
		note: "macOS Intel (hub only)",
	},
	{
		target: "bun-windows-x64",
		asset: "stats-windows-x64.exe",
		note: "Windows x86-64 (node only — no system probe yet; terminal, " +
			"projects and ca work)",
	},
];

const ALL_TARGETS = [...LINUX_TARGETS, ...EXTRA_TARGETS];

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	if (
		i !== -1 &&
		process.argv[i + 1] &&
		!process.argv[i + 1]!.startsWith("--")
	) {
		return process.argv[i + 1];
	}
	return process.argv
		.find((a) => a.startsWith(`--${name}=`))
		?.split("=")
		.slice(1)
		.join("=");
}

const has = (name: string) =>
	process.argv.includes(`--${name}`) ||
	process.argv.some((a) => a.startsWith(`--${name}=`));

/** Maps this machine to its asset name, so --host builds only what it can run. */
function hostAsset(): string {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	if (process.platform === "darwin") return `stats-darwin-${arch}`;
	const musl =
		Bun.file("/lib/ld-musl-x86_64.so.1").size > 0 ||
		Bun.file("/lib/ld-musl-aarch64.so.1").size > 0;
	return `stats-linux-${arch}${musl ? "-musl" : ""}`;
}

function selectTargets(): Target[] {
	if (has("host")) {
		const asset = hostAsset();
		const found = ALL_TARGETS.find((t) => t.asset === asset);
		if (!found) throw new Error(`no target matches this machine (${asset})`);
		return [found];
	}

	const requested = flag("targets");
	if (!requested) return has("all") ? ALL_TARGETS : LINUX_TARGETS;

	return requested.split(",").map((name) => {
		const key = name.trim();
		const found = ALL_TARGETS.find(
			(t) => t.asset === key || t.asset === `stats-${key}` || t.target === key,
		);
		if (!found) {
			throw new Error(
				`unknown target '${key}'. Known: ${ALL_TARGETS.map((t) => t.asset.replace("stats-", "")).join(", ")}`,
			);
		}
		return found;
	});
}

function mib(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const outDir = flag("out") ?? "dist";
const compress = !has("no-compress");

async function build(target: Target): Promise<{ path: string; bytes: number }> {
	const outfile = `${outDir}/${target.asset}`;
	const started = Date.now();

	const args = [
		"build",
		"--compile",
		"--target",
		target.target,
		// Dead-code-eliminates the hot-reload branch in startHub and puts React
		// into its production build; without it the binary ships the dev runtime.
		//
		// This must be --production, NOT --define process.env.NODE_ENV="production".
		// --define only rewrites the identifier, so React resolves through its
		// production export condition while Bun still transpiles web/frontend.tsx
		// with the *development* JSX transform. React's production
		// jsx-dev-runtime exports `jsxDEV = undefined`, so the dashboard bundle
		// throws "jsxDEV is not a function" on its first JSX call — which is top
		// level, so React never mounts and the WebSocket never opens, and nothing
		// appears in the hub's logs because the failure is entirely browser-side.
		// --production sets both halves consistently.
		"--production",
		"--minify",
		// Precompiled bytecode: bigger file, faster cold start. Requires the entry
		// point to be free of top-level await, which is why index.ts wraps main().
		"--bytecode",
		"--sourcemap=none",
		"--outfile",
		outfile,
		"./index.ts",
	];

	const proc = Bun.spawn(["bun", ...args], { stdout: "pipe", stderr: "pipe" });
	const [stderr, code] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`${target.target} failed:\n${stderr.trim()}`);

	const bytes = Bun.file(outfile).size;
	console.log(
		`  ${target.asset.padEnd(32)} ${mib(bytes).padStart(9)}  ${((Date.now() - started) / 1000).toFixed(1)}s`,
	);
	return { path: outfile, bytes };
}

/** Halves the download for anyone installing over a slow link. */
async function gzip(path: string): Promise<number> {
	const data = await Bun.file(path).bytes();
	const packed = Bun.gzipSync(data, { level: 9 });
	await Bun.write(`${path}.gz`, packed);
	return packed.length;
}

async function sha256(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(await Bun.file(path).bytes());
	return hasher.digest("hex");
}

/** A binary for this machine should at least be able to print its version. */
async function smokeTest(path: string) {
	const proc = Bun.spawn([resolve(path), "version"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, code] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	]);
	if (code !== 0 || !out.includes(pkg.version)) {
		throw new Error(
			`smoke test failed for ${path}: exit ${code}, output ${JSON.stringify(out)}`,
		);
	}
	console.log(`  smoke test: ${out.trim()}`);
}

const targets = selectTargets();

console.log(
	`stats ${pkg.version} — building ${targets.length} target(s) into ${outDir}/\n`,
);
await rm(outDir, { recursive: true, force: true });

const artifacts: {
	asset: string;
	target: string;
	note: string;
	bytes: number;
	sha256: string;
	gzBytes?: number;
	gzSha256?: string;
}[] = [];

for (const target of targets) {
	const { path, bytes } = await build(target);
	const entry = {
		asset: target.asset,
		target: target.target,
		note: target.note,
		bytes,
		sha256: await sha256(path),
	} as (typeof artifacts)[number];

	if (compress) {
		entry.gzBytes = await gzip(path);
		entry.gzSha256 = await sha256(`${path}.gz`);
	}
	artifacts.push(entry);
}

const host = hostAsset();
const native = artifacts.find((a) => a.asset === host);
if (native) await smokeTest(`${outDir}/${native.asset}`);

// SHA256SUMS in the usual `sha256sum -c` format, so an installer (or a human)
// can verify a download without this repo checked out.
const sums = artifacts
	.flatMap((a) => [
		`${a.sha256}  ${a.asset}`,
		...(a.gzSha256 ? [`${a.gzSha256}  ${a.asset}.gz`] : []),
	])
	.join("\n");
await Bun.write(`${outDir}/SHA256SUMS`, `${sums}\n`);

await Bun.write(
	`${outDir}/manifest.json`,
	`${JSON.stringify(
		{
			name: "stats",
			version: pkg.version,
			builtAt: new Date().toISOString(),
			bun: Bun.version,
			artifacts,
		},
		null,
		2,
	)}\n`,
);

// The HTML bundler drops browser sourcemaps next to the outfile even though the
// chunks themselves are embedded in the binary. Nothing serves them, so they are
// just noise in a release directory.
const keep = new Set([
	"SHA256SUMS",
	"manifest.json",
	...artifacts.flatMap((a) => [a.asset, `${a.asset}.gz`]),
]);
for (const name of new Bun.Glob("*").scanSync(outDir)) {
	if (!keep.has(name)) await rm(`${outDir}/${name}`, { force: true });
}

const total = artifacts.reduce((sum, a) => sum + (a.gzBytes ?? a.bytes), 0);
console.log(`\n${artifacts.length} artifact(s), ${mib(total)} to publish.`);
console.log(`Install one locally with:  sudo ./install.sh --from ${outDir}`);
