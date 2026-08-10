import { streamLogs } from "../../collect/logs.ts";
import { MODULES } from "../../modules/manifest.ts";
import type { InboundRequest } from "../../proto/link.ts";
import { RemoteError } from "../../proto/link.ts";
import type { LogsTailParams } from "../../proto/messages.ts";
import type { LogLine, LogQuery } from "../../types.ts";
import type { NodeModule, NodeModuleContext } from "./mod.ts";

/**
 * Log tails: journal units, container output, files under STATS_LOG_DIRS, and
 * a project's own ring buffer. It is the one module that reads from the
 * supervisor without owning it — project logs never touch the filesystem.
 */

/** Lines pushed per frame; batching keeps a busy log cheap. */
const LOG_BATCH = 25;
const LOG_BATCH_MS = 100;

async function tail(
	req: InboundRequest,
	query: LogQuery,
	ctx: NodeModuleContext,
) {
	// Said up front: a quiet log would otherwise look like a handler with no
	// stream at all, and the correlation id would close under it.
	req.stream.open();
	let batch: LogLine[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;

	const flush = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (!batch.length || req.stream.closed) return;
		req.stream.json(batch);
		batch = [];
	};
	const push = (line: LogLine) => {
		batch.push(line);
		if (batch.length >= LOG_BATCH) flush();
		else if (!timer) timer = setTimeout(flush, LOG_BATCH_MS);
	};

	if (query.kind === "project") {
		// target is "<projectId>/<processId>"
		const slash = query.target.indexOf("/");
		if (slash === -1)
			throw new RemoteError(
				"bad_request",
				"project log target must be 'project/process'",
			);
		ctx.supervisor.tail(
			query.target.slice(0, slash),
			query.target.slice(slash + 1),
			query.tail,
			push,
			req.signal,
		);
		flush();
		if (!query.follow) req.stream.end();
		return;
	}

	void (async () => {
		try {
			for await (const line of streamLogs(query, req.signal)) {
				if (req.signal.aborted) break;
				push(line);
			}
			flush();
			req.stream.end();
		} catch (err) {
			flush();
			if (!req.signal.aborted) {
				req.stream.end({
					code: "log_error",
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
	})();
}

export const logsModule: NodeModule = {
	manifest: MODULES.logs,

	actions: {
		"logs.tail": async (req, ctx) => {
			const p = (req.params ?? {}) as unknown as LogsTailParams;
			const query: LogQuery = {
				kind: p.kind ?? "journal",
				target: String(p.target ?? ""),
				tail: Math.min(Math.max(Number(p.tail) || 200, 1), 5000),
				follow: p.follow !== false,
			};
			if (!query.target)
				throw new RemoteError("bad_request", "missing log target");
			await tail(req, query, ctx);
			return { streaming: true, ...query };
		},
	},
};
