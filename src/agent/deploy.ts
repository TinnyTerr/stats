import { stat } from "node:fs/promises";
import type { ProjectSpec } from "../types.ts";

/**
 * A deploy: get the code to `source.ref`, run `build.steps`, and report. The
 * supervisor restarts the processes afterwards, so a failure here leaves the
 * running version alone.
 */

const SHELL: string[] =
	process.platform === "win32" ? ["cmd", "/c"] : ["sh", "-c"];

export type DeployLog = (stream: "deploy" | "stderr", message: string) => void;

interface RunOptions {
	cwd: string;
	env: Record<string, string>;
	timeoutSec: number;
	log: DeployLog;
	signal?: AbortSignal;
}

async function pump(
	stream: ReadableStream<Uint8Array>,
	kind: "deploy" | "stderr",
	log: DeployLog,
) {
	const decoder = new TextDecoder();
	let pending = "";
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		pending += decoder.decode(value, { stream: true });
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) log(kind, line.replace(/\r$/, ""));
	}
	if (pending) log(kind, pending);
}

/** Runs one command to completion, streaming its output; throws on non-zero. */
export async function run(argv: string[], opts: RunOptions): Promise<void> {
	opts.log("deploy", `$ ${argv.at(-1) ?? argv.join(" ")}`);
	const proc = Bun.spawn(argv, {
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env },
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	let timedOut = false;
	const kill = () => proc.kill("SIGKILL");
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, opts.timeoutSec * 1000);
	opts.signal?.addEventListener("abort", kill, { once: true });
	try {
		const [code] = await Promise.all([
			proc.exited,
			pump(proc.stdout, "deploy", opts.log),
			pump(proc.stderr, "stderr", opts.log),
		]);
		if (timedOut) throw new Error(`timed out after ${opts.timeoutSec}s`);
		if (code !== 0) throw new Error(`exit ${code}`);
	} finally {
		clearTimeout(timer);
	}
}

async function isRepo(dir: string): Promise<boolean> {
	return stat(`${dir}/.git`)
		.then(() => true)
		.catch(() => false);
}

/** Clone, or fetch and fast-forward. Local changes are never discarded. */
export async function fetchSource(
	project: ProjectSpec,
	opts: Omit<RunOptions, "cwd">,
): Promise<void> {
	const { source, cwd } = project;
	if (!source || !cwd) return;
	const git = (...args: string[]) => ["git", ...args];

	if (!(await isRepo(cwd))) {
		await run(git("clone", "--branch", source.ref, source.repo, cwd), {
			...opts,
			cwd: "/",
		});
		return;
	}
	const here = { ...opts, cwd };
	await run(git("fetch", "--tags", "--prune", "origin"), here);
	await run(git("checkout", source.ref), here);
	// A tag has no origin/<ref>; checking it out was the whole job.
	const isBranch = await Bun.spawn(
		git("rev-parse", "--verify", "--quiet", `origin/${source.ref}`),
		{ cwd, stdout: "ignore", stderr: "ignore" },
	).exited;
	if (isBranch === 0)
		await run(git("merge", "--ff-only", `origin/${source.ref}`), here);
}

export async function buildSteps(
	project: ProjectSpec,
	opts: Omit<RunOptions, "cwd" | "timeoutSec">,
): Promise<void> {
	const { build, cwd } = project;
	if (!build) return;
	for (const step of build.steps) {
		await run([...SHELL, step], {
			...opts,
			cwd: cwd ?? "/",
			timeoutSec: build.timeoutSec,
		});
	}
}
