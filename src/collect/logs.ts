import type { LogLine, LogQuery } from "../types.ts";
import { containerLogStream } from "./docker.ts";

/**
 * Unified log tailing. Every source is normalised to an async iterable of
 * LogLine so the agent's SSE endpoint doesn't care where the bytes came from.
 */

/** Splits a byte stream into lines, carrying the partial tail between chunks. */
async function* lines(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
) {
	const decoder = new TextDecoder();
	let buffer = "";
	const reader = stream.getReader();
	const onAbort = () => void reader.cancel().catch(() => {});
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const line of parts) yield line;
		}
		if (buffer) yield buffer;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}

/**
 * Docker's multiplexed framing: an 8-byte header per frame where byte 0 is the
 * stream id (1=stdout, 2=stderr) and bytes 4..8 are a big-endian payload length.
 * Frames can be split across chunks, so we buffer until a full frame arrives.
 */
async function* demuxDocker(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<{ stream: string; text: string }> {
	const reader = stream.getReader();
	const onAbort = () => void reader.cancel().catch(() => {});
	signal?.addEventListener("abort", onAbort, { once: true });
	const decoder = new TextDecoder();
	let buf = new Uint8Array(0);

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const next = new Uint8Array(buf.length + value.length);
			next.set(buf);
			next.set(value, buf.length);
			buf = next;

			while (buf.length >= 8) {
				const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
				const streamId = view.getUint8(0);
				const size = view.getUint32(4, false);
				if (buf.length < 8 + size) break;
				const payload = buf.subarray(8, 8 + size);
				buf = buf.subarray(8 + size);
				yield {
					stream: streamId === 2 ? "stderr" : "stdout",
					text: decoder.decode(payload),
				};
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}

/** Docker prefixes each line with an RFC3339 timestamp when timestamps=1. */
function splitDockerTimestamp(text: string): { ts: number; message: string } {
	const m = text.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/s);
	if (!m) return { ts: Date.now(), message: text };
	const ts = Date.parse(m[1]!);
	return { ts: Number.isFinite(ts) ? ts : Date.now(), message: m[2] ?? "" };
}

async function* dockerLogs(
	query: LogQuery,
	follow: boolean,
	signal?: AbortSignal,
): AsyncGenerator<LogLine> {
	const { body, multiplexed } = await containerLogStream(query.target, {
		tail: query.tail,
		follow,
		signal,
	});

	if (!multiplexed) {
		for await (const line of lines(body, signal)) {
			if (!line) continue;
			const { ts, message } = splitDockerTimestamp(line);
			yield { ts, stream: "stdout", message };
		}
		return;
	}

	// Frames don't align to line boundaries, so re-split per stream.
	const pending = new Map<string, string>();
	for await (const frame of demuxDocker(body, signal)) {
		const carried = (pending.get(frame.stream) ?? "") + frame.text;
		const parts = carried.split("\n");
		pending.set(frame.stream, parts.pop() ?? "");
		for (const line of parts) {
			if (!line) continue;
			const { ts, message } = splitDockerTimestamp(line);
			yield { ts, stream: frame.stream, message };
		}
	}
	for (const [stream, rest] of pending) {
		if (!rest) continue;
		const { ts, message } = splitDockerTimestamp(rest);
		yield { ts, stream, message };
	}
}

/** Runs a command and yields its stdout line by line, killing it on abort. */
async function* commandLines(
	cmd: string[],
	signal?: AbortSignal,
): AsyncGenerator<{ line: string; stream: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const onAbort = () => proc.kill();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		for await (const line of lines(proc.stdout, signal)) {
			yield { line, stream: "stdout" };
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		proc.kill();
		await proc.exited.catch(() => {});
	}
}

async function* journalLogs(
	query: LogQuery,
	follow: boolean,
	signal?: AbortSignal,
): AsyncGenerator<LogLine> {
	const cmd = [
		"journalctl",
		"-u",
		query.target,
		"-n",
		String(query.tail),
		"-o",
		"json",
		"--no-pager",
	];
	if (follow) cmd.push("-f");

	for await (const { line } of commandLines(cmd, signal)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as {
				__REALTIME_TIMESTAMP?: string;
				MESSAGE?: string | number[];
				PRIORITY?: string;
			};
			// journald timestamps are microseconds since epoch.
			const micros = Number(entry.__REALTIME_TIMESTAMP);
			const message = Array.isArray(entry.MESSAGE)
				? new TextDecoder().decode(Uint8Array.from(entry.MESSAGE))
				: (entry.MESSAGE ?? "");
			yield {
				ts: Number.isFinite(micros) ? Math.round(micros / 1000) : Date.now(),
				// priority <= 3 is err/crit/alert/emerg
				stream: Number(entry.PRIORITY ?? 6) <= 3 ? "stderr" : "stdout",
				message,
			};
		} catch {
			yield { ts: Date.now(), stream: "unknown", message: line };
		}
	}
}

async function* fileLogs(
	query: LogQuery,
	follow: boolean,
	signal?: AbortSignal,
): AsyncGenerator<LogLine> {
	const cmd = follow
		? ["tail", "-n", String(query.tail), "-F", query.target]
		: ["tail", "-n", String(query.tail), query.target];
	for await (const { line } of commandLines(cmd, signal)) {
		yield { ts: Date.now(), stream: "stdout", message: line };
	}
}

/** Guards against `kind=file` being used to read arbitrary paths. */
export function fileTargetAllowed(target: string): boolean {
	const allowed = (process.env.STATS_LOG_DIRS ?? "/var/log")
		.split(":")
		.map((d) => d.replace(/\/+$/, ""))
		.filter(Boolean);
	if (!target.startsWith("/") || target.includes("..")) return false;
	return allowed.some((dir) => target === dir || target.startsWith(`${dir}/`));
}

/**
 * Tails one source. `project` is deliberately absent: those lines come from the
 * supervisor's own ring buffer, not the filesystem, so the agent handles that
 * kind before it gets here.
 */
export function streamLogs(
	query: LogQuery,
	signal?: AbortSignal,
): AsyncGenerator<LogLine> {
	const follow = query.follow;
	switch (query.kind) {
		case "docker":
			return dockerLogs(query, follow, signal);
		case "journal":
			if (!/^[A-Za-z0-9:_.\\@-]+$/.test(query.target)) {
				throw new Error(`invalid unit name '${query.target}'`);
			}
			return journalLogs(query, follow, signal);
		case "file":
			if (!fileTargetAllowed(query.target)) {
				throw new Error(
					`file logs are restricted to STATS_LOG_DIRS (default /var/log); refused ${query.target}`,
				);
			}
			return fileLogs(query, follow, signal);
		case "project":
			throw new Error(
				"project logs are served by the supervisor, not the log collector",
			);
	}
}
