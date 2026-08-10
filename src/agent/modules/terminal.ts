import { MODULES } from "../../modules/manifest.ts";
import { RemoteError } from "../../proto/link.ts";
import type {
	TerminalCloseParams,
	TerminalOpenParams,
	TerminalResizeParams,
} from "../../proto/messages.ts";
import type { NodeModule } from "./mod.ts";

/**
 * An interactive shell over the same socket everything else rides on.
 *
 * This is the module with the sharpest edge, so it is also the easiest to
 * remove: drop `terminal` from a node's modules and the three actions below
 * stop existing — the hub refuses them before they ever reach the host.
 */
export const terminalModule: NodeModule = {
	manifest: MODULES.terminal,

	actions: {
		"terminal.open": async (req, ctx) => {
			const p = (req.params ?? {}) as unknown as TerminalOpenParams;
			const context = p.projectId
				? await ctx.supervisor.shellContext(p.projectId)
				: null;
			// Output starts whenever the shell feels like it, which is usually
			// after this handler has already returned.
			req.stream.open();

			const result = await ctx.terminals.open({
				...p,
				cwd: p.cwd ?? context?.cwd ?? undefined,
				env: context?.env,
				onData: (data) => req.stream.bytes(data),
				onExit: (code, signal) => {
					if (req.stream.closed) return;
					// A last line so the pane says why it went away rather than freezing.
					req.stream.json({
						event: "exit",
						code,
						signal,
						message: `\r\n[session ended: ${signal ?? `exit ${code ?? 0}`}]\r\n`,
					});
					req.stream.end();
				},
			});

			// Keystrokes arrive as binary frames on this same correlation id.
			req.onData((payload, binary) => {
				if (binary) ctx.terminals.write(result.sessionId, payload);
			});
			req.signal.addEventListener(
				"abort",
				() => ctx.terminals.close(result.sessionId),
				{ once: true },
			);
			return result;
		},

		"terminal.resize": async (req, ctx) => {
			const p = (req.params ?? {}) as unknown as TerminalResizeParams;
			if (!p.sessionId)
				throw new RemoteError("bad_request", "missing sessionId");
			ctx.terminals.resize(p.sessionId, p.cols, p.rows);
			return { ok: true };
		},

		"terminal.close": async (req, ctx) => {
			const p = (req.params ?? {}) as unknown as TerminalCloseParams;
			ctx.terminals.close(p.sessionId);
			return { ok: true };
		},
	},
};
