import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type { Bytes } from "../proto/frame.ts";
import type {
	TerminalOpenParams,
	TerminalOpenResult,
} from "../proto/messages.ts";

/**
 * Interactive shells, over the same link as everything else.
 *
 * Bun spawns the child on a real PTY, so the shell believes it is on a
 * terminal: job control, colour, curses apps and Ctrl-C all behave. Output goes
 * back as raw bytes in StreamData frames and keystrokes arrive the same way,
 * which means the browser can hand them straight to xterm.js without either end
 * interpreting the escape sequences.
 */

export interface TerminalSession {
	id: string;
	proc: Subprocess;
	startedAt: number;
	cols: number;
	rows: number;
	/** what the session is attached to, for the UI's title bar */
	label: string;
}

export interface OpenOptions extends TerminalOpenParams {
	/** resolved from the project, when the request named one */
	cwd?: string;
	env?: Record<string, string>;
	onData: (data: Bytes) => void;
	onExit: (code: number | null, signal: string | null) => void;
}

/** Shells to try when the caller doesn't name one, best first. */
const SHELL_CANDIDATES = ["/bin/bash", "/bin/sh"];

const MAX_SESSIONS = 8;

async function pickShell(requested?: string): Promise<string> {
	if (requested) {
		// Only ever an absolute path to a real file — never a string the shell parses.
		if (!requested.startsWith("/"))
			throw new Error(`shell must be an absolute path`);
		if (!(await Bun.file(requested).exists()))
			throw new Error(`no such shell: ${requested}`);
		return requested;
	}
	const fromEnv = process.env.SHELL;
	if (fromEnv && (await Bun.file(fromEnv).exists())) return fromEnv;
	for (const candidate of SHELL_CANDIDATES) {
		if (await Bun.file(candidate).exists()) return candidate;
	}
	throw new Error("no shell found on this host");
}

function clamp(
	value: number | undefined,
	fallback: number,
	max: number,
): number {
	if (!Number.isFinite(value) || !value || value < 1) return fallback;
	return Math.min(Math.round(value), max);
}

export class TerminalManager {
	private sessions = new Map<string, TerminalSession>();

	constructor(private enabled: boolean) {}

	get count(): number {
		return this.sessions.size;
	}

	async open(opts: OpenOptions): Promise<TerminalOpenResult> {
		if (!this.enabled) throw new Error("terminals are disabled on this node");
		if (this.sessions.size >= MAX_SESSIONS) {
			throw new Error(`too many open terminals on this node (${MAX_SESSIONS})`);
		}

		const cols = clamp(opts.cols, 80, 500);
		const rows = clamp(opts.rows, 24, 200);

		let cmd: string[];
		let label: string;
		let shell: string;

		if (opts.container) {
			if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(opts.container)) {
				throw new Error(`invalid container name '${opts.container}'`);
			}
			// `docker exec` needs the CLI; the engine socket alone can't hijack a TTY
			// without reimplementing the attach protocol.
			shell = "/bin/sh";
			cmd = [
				"docker",
				"exec",
				"-it",
				opts.container,
				"sh",
				"-c",
				"exec $(command -v bash || command -v sh)",
			];
			label = `container ${opts.container}`;
		} else {
			shell = await pickShell(opts.shell);
			// A login shell so the user gets their normal profile and prompt.
			cmd = [shell, "-l"];
			label = opts.projectId ? `project ${opts.projectId}` : "shell";
		}

		const id = randomUUID();
		const proc = Bun.spawn(cmd, {
			cwd: opts.cwd ?? process.env.HOME ?? "/",
			env: {
				...(process.env as Record<string, string>),
				...opts.env,
				TERM: "xterm-256color",
				// Tells a shell's prompt logic it is inside the dashboard.
				STATS_TERMINAL: "1",
				// Deliberately no COLUMNS/LINES: tput and friends prefer those over the
				// pty's real size, so setting them makes every later resize look
				// ignored. The kernel already knows the window size.
				COLUMNS: undefined as unknown as string,
				LINES: undefined as unknown as string,
			},
			terminal: {
				cols,
				rows,
				name: "xterm-256color",
				data: (_terminal, data) => opts.onData(data),
			},
			onExit: (_proc, exitCode, signalCode) => {
				this.sessions.delete(id);
				opts.onExit(
					exitCode,
					typeof signalCode === "string" ? signalCode : null,
				);
			},
		});

		this.sessions.set(id, {
			id,
			proc,
			startedAt: Date.now(),
			cols,
			rows,
			label,
		});
		return {
			sessionId: id,
			pid: proc.pid,
			shell: opts.container ? `docker exec ${opts.container}` : shell,
		};
	}

	write(sessionId: string, data: Bytes) {
		this.sessions.get(sessionId)?.proc.terminal?.write(data);
	}

	resize(sessionId: string, cols: number, rows: number) {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`unknown terminal session '${sessionId}'`);
		session.cols = clamp(cols, session.cols, 500);
		session.rows = clamp(rows, session.rows, 200);
		session.proc.terminal?.resize(session.cols, session.rows);
	}

	close(sessionId: string) {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.sessions.delete(sessionId);
		try {
			// SIGHUP is what a closed terminal sends; the shell tears down its jobs.
			session.proc.kill("SIGHUP");
		} catch {
			// already exited
		}
		session.proc.terminal?.close();
	}

	closeAll() {
		for (const id of [...this.sessions.keys()]) this.close(id);
	}
}
