import { connect } from "node:net";
import type { Subprocess } from "bun";
import { forgetProcess, sampleProcess } from "../collect/processes.ts";
import type {
	HealthCheck,
	HealthState,
	LogLine,
	ProcessSpec,
	ProcessState,
	ProcessStatus,
	ProjectSpec,
	ProjectStatus,
} from "../types.ts";
import { type LoadedProjects, loadEnvFiles, loadProjects } from "./projects.ts";

/**
 * Runs and watches the processes declared in the projects file.
 *
 * Deliberately not a general init system: no dependency ordering, no sockets,
 * no cgroups. It starts what the file says to start, restarts it under a
 * policy, keeps the last N lines of output in memory, samples CPU and memory
 * per pid, and reports all of it in telemetry. Anything more structured than
 * that belongs in a systemd unit, which this also knows how to display.
 */

/** Restart backoff is capped here, however badly a process is flapping. */
const MAX_RESTART_DELAY_MS = 30_000;

type LogListener = (line: LogLine) => void;

class LogBuffer {
	private lines: LogLine[] = [];
	private listeners = new Set<LogListener>();

	constructor(private capacity: number) {}

	push(line: LogLine) {
		this.lines.push(line);
		if (this.lines.length > this.capacity) {
			this.lines.splice(0, this.lines.length - this.capacity);
		}
		for (const listener of this.listeners) {
			try {
				listener(line);
			} catch {
				// a broken subscriber must not stop the process's output being kept
			}
		}
	}

	tail(count: number): LogLine[] {
		return count >= this.lines.length
			? [...this.lines]
			: this.lines.slice(-count);
	}

	subscribe(listener: LogListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	resize(capacity: number) {
		this.capacity = capacity;
		if (this.lines.length > capacity)
			this.lines.splice(0, this.lines.length - capacity);
	}
}

/** One supervised process: its spec, its child, and everything we know about it. */
class ManagedProcess {
	state: ProcessState = "stopped";
	health: HealthState = "unknown";
	healthDetail: string | null = null;
	proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
	startedAt: number | null = null;
	lastExitCode: number | null = null;
	lastExitSignal: string | null = null;
	lastExitAt: number | null = null;
	error: string | null = null;
	cpu: number | null = null;
	rssBytes: number | null = null;
	logs: LogBuffer;

	/** Timestamps of recent restarts, for the maxRestarts window. */
	private restartTimes: number[] = [];
	restarts = 0;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private stopTimer: ReturnType<typeof setTimeout> | null = null;
	private healthTimer: ReturnType<typeof setInterval> | null = null;
	/** Set while a deliberate stop is in flight, so onExit doesn't restart it. */
	private stopping = false;
	private consecutiveFailures = 0;
	/**
	 * Resolved by handleExit. `proc.exited` resolves a tick earlier than the
	 * onExit callback runs, so stop() waits on this instead — otherwise it can
	 * return while the state still says "stopping".
	 */
	private reaped: { promise: Promise<void>; resolve: () => void } | null = null;

	constructor(
		public spec: ProcessSpec,
		readonly projectId: string,
		private project: ProjectSpec,
		private onChange: () => void,
	) {
		this.logs = new LogBuffer(spec.logLines);
	}

	get running(): boolean {
		return (
			this.proc !== null &&
			this.proc.exitCode === null &&
			this.proc.signalCode === null
		);
	}

	private log(stream: string, message: string) {
		this.logs.push({ ts: Date.now(), stream, message });
	}

	/**
	 * Builds the argv actually handed to the kernel: the command, wrapped in
	 * `sh -c` when the spec asks for a shell, wrapped again in a privilege-dropper
	 * when it names a user.
	 */
	private async buildCommand(): Promise<string[]> {
		const base = this.spec.shell
			? ["sh", "-c", this.spec.command.join(" ")]
			: [...this.spec.command];
		if (!this.spec.user) return base;

		if (process.getuid?.() !== 0) {
			throw new Error(
				`process '${this.spec.id}' asks to run as '${this.spec.user}', but the node is not root`,
			);
		}
		// setpriv is the clean one (no shell, no pty, keeps argv intact); runuser is
		// the fallback on hosts without util-linux's setpriv.
		if (await which("setpriv")) {
			const group = this.spec.group ? [`--regid=${this.spec.group}`] : [];
			return [
				"setpriv",
				`--reuid=${this.spec.user}`,
				...group,
				"--init-groups",
				"--inh-caps=-all",
				"--",
				...base,
			];
		}
		if (await which("runuser")) {
			return ["runuser", "-u", this.spec.user, "--", ...base];
		}
		throw new Error(
			`process '${this.spec.id}' needs setpriv or runuser to drop to '${this.spec.user}'; neither is installed`,
		);
	}

	private async buildEnv(): Promise<Record<string, string>> {
		const fromFiles = await loadEnvFiles([
			...this.project.envFiles,
			...this.spec.envFiles,
		]);
		return {
			...(process.env as Record<string, string>),
			...fromFiles,
			...this.project.env,
			...this.spec.env,
			// Tells a supervised process where it is, the way systemd sets INVOCATION_ID.
			STATS_PROJECT: this.projectId,
			STATS_PROCESS: this.spec.id,
		};
	}

	async start(manual = false): Promise<void> {
		if (this.running || this.state === "starting") return;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		// A manual start is also a pardon: it clears a fatal state and the counter.
		if (manual) {
			this.restartTimes = [];
			this.error = null;
		}

		this.state = "starting";
		this.stopping = false;
		this.onChange();

		let cmd: string[];
		let env: Record<string, string>;
		try {
			cmd = await this.buildCommand();
			env = await this.buildEnv();
		} catch (err) {
			this.fail(err instanceof Error ? err.message : String(err));
			return;
		}

		let markReaped!: () => void;
		this.reaped = {
			promise: new Promise<void>((resolvePromise) => {
				markReaped = resolvePromise;
			}),
			resolve: markReaped,
		};

		try {
			const proc = Bun.spawn(cmd, {
				cwd: this.spec.cwd ?? this.project.cwd ?? undefined,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				onExit: (_proc, exitCode, signalCode, error) => {
					this.handleExit(exitCode, signalCode, error);
				},
			});

			this.proc = proc;
			this.startedAt = Date.now();
			this.state = "running";
			this.error = null;
			this.cpu = null;
			this.rssBytes = null;
			this.consecutiveFailures = 0;
			this.health = this.spec.healthcheck ? "starting" : "unknown";
			this.healthDetail = null;
			this.log("system", `started: ${cmd.join(" ")} (pid ${proc.pid})`);

			void this.pump(proc.stdout, "stdout");
			void this.pump(proc.stderr, "stderr");
			this.startHealthchecks();
			this.onChange();
		} catch (err) {
			this.reaped?.resolve();
			this.reaped = null;
			this.fail(
				`spawn failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/** Streams a child's output into the ring buffer, line by line. */
	private async pump(stream: ReadableStream<Uint8Array>, name: string) {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split("\n");
				buffer = parts.pop() ?? "";
				for (const line of parts) this.log(name, line.replace(/\r$/, ""));
			}
			if (buffer) this.log(name, buffer);
		} catch {
			// the process went away mid-read; handleExit does the reporting
		}
	}

	private handleExit(
		exitCode: number | null,
		signalCode: number | string | null,
		error?: unknown,
	) {
		if (this.proc) forgetProcess(this.proc.pid);
		this.stopHealthchecks();
		this.lastExitCode = exitCode;
		this.lastExitSignal = typeof signalCode === "string" ? signalCode : null;
		this.lastExitAt = Date.now();
		this.startedAt = null;
		this.cpu = null;
		this.rssBytes = null;
		this.health = "unknown";
		this.healthDetail = null;
		this.proc = null;

		if (this.stopTimer) {
			clearTimeout(this.stopTimer);
			this.stopTimer = null;
		}

		const how = this.lastExitSignal
			? `killed by ${this.lastExitSignal}`
			: `exited with code ${exitCode ?? "?"}`;
		if (error)
			this.log(
				"system",
				`${how}: ${error instanceof Error ? error.message : String(error)}`,
			);
		else this.log("system", how);

		const reaped = this.reaped;
		this.reaped = null;

		if (this.stopping) {
			this.stopping = false;
			this.state = "stopped";
			this.onChange();
			reaped?.resolve();
			return;
		}
		reaped?.resolve();

		const failed = exitCode !== 0 || this.lastExitSignal !== null;
		this.state = failed ? "crashed" : "exited";

		const policy = this.spec.restart;
		const shouldRestart =
			policy === "always" || (policy === "on-failure" && failed);
		if (!shouldRestart) {
			// Nothing is going to retry this. A failure the supervisor has given up
			// on is "fatal" whether it ran out of restarts or never had any — the
			// project summary keys off that, so "crashed" stays a transient state
			// between an exit and the restart that follows it.
			if (failed) this.fail(`${how}, restart policy: ${policy}`);
			else this.onChange();
			return;
		}

		// Count restarts inside the window; too many means something is broken in a
		// way retrying won't fix, so stop burning CPU on it.
		const now = Date.now();
		const windowStart = now - this.spec.restartWindowSec * 1000;
		this.restartTimes = this.restartTimes.filter((t) => t >= windowStart);
		if (
			this.spec.maxRestarts > 0 &&
			this.restartTimes.length >= this.spec.maxRestarts
		) {
			this.fail(
				`gave up after ${this.restartTimes.length} restarts in ${this.spec.restartWindowSec}s`,
			);
			return;
		}
		this.restartTimes.push(now);
		this.restarts++;

		// Linear backoff on repeated failures within the window, capped.
		const delay = Math.min(
			this.spec.restartDelayMs * Math.max(1, this.restartTimes.length),
			MAX_RESTART_DELAY_MS,
		);
		this.state = "restarting";
		this.log("system", `restarting in ${Math.round(delay / 1000)}s`);
		this.onChange();
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			void this.start();
		}, delay);
		this.restartTimer.unref?.();
	}

	private fail(message: string) {
		this.state = "fatal";
		this.error = message;
		this.log("system", message);
		this.onChange();
	}

	async stop(): Promise<void> {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		this.stopHealthchecks();

		const proc = this.proc;
		if (!proc || !this.running) {
			this.state = "stopped";
			this.error = null;
			this.onChange();
			return;
		}

		this.stopping = true;
		this.state = "stopping";
		this.onChange();
		this.log("system", `stopping with ${this.spec.stopSignal}`);

		try {
			proc.kill(this.spec.stopSignal as NodeJS.Signals);
		} catch {
			// already gone between the check and the signal
		}

		this.stopTimer = setTimeout(() => {
			if (this.running) {
				this.log(
					"system",
					`did not exit within ${this.spec.stopTimeoutSec}s — SIGKILL`,
				);
				try {
					proc.kill("SIGKILL");
				} catch {
					// ditto
				}
			}
		}, this.spec.stopTimeoutSec * 1000);
		this.stopTimer.unref?.();

		await proc.exited;
		// ...and then for our own bookkeeping to catch up with the kernel.
		await this.reaped?.promise;
	}

	async restart(): Promise<void> {
		await this.stop();
		await this.start(true);
	}

	/* ---------- health ---------- */

	private startHealthchecks() {
		const check = this.spec.healthcheck;
		if (!check) return;
		this.stopHealthchecks();
		const startedAt = Date.now();
		this.healthTimer = setInterval(() => {
			void this.runHealthcheck(check, startedAt);
		}, check.intervalSec * 1000);
		this.healthTimer.unref?.();
	}

	private stopHealthchecks() {
		if (this.healthTimer) clearInterval(this.healthTimer);
		this.healthTimer = null;
		this.consecutiveFailures = 0;
	}

	private async runHealthcheck(check: HealthCheck, startedAt: number) {
		if (!this.running) return;
		const result = await probe(check);
		const inGracePeriod = Date.now() - startedAt < check.startPeriodSec * 1000;

		if (result.ok) {
			this.consecutiveFailures = 0;
			if (this.health !== "healthy") {
				this.health = "healthy";
				this.healthDetail = null;
				this.onChange();
			}
			return;
		}

		this.consecutiveFailures++;
		if (inGracePeriod) {
			this.health = "starting";
			this.healthDetail = result.detail;
			return;
		}
		if (
			this.consecutiveFailures >= check.failures &&
			this.health !== "unhealthy"
		) {
			this.health = "unhealthy";
			this.healthDetail = result.detail;
			this.log("system", `healthcheck failing: ${result.detail}`);
			this.onChange();
		} else {
			this.healthDetail = result.detail;
		}
	}

	/* ---------- reporting ---------- */

	async sample() {
		if (!this.proc || !this.running) return;
		const sample = await sampleProcess(this.proc.pid);
		if (!sample) return;
		this.cpu = sample.cpu;
		this.rssBytes = sample.rssBytes;
	}

	status(): ProcessStatus {
		return {
			id: this.spec.id,
			name: this.spec.name,
			projectId: this.projectId,
			state: this.state,
			health: this.health,
			healthDetail: this.healthDetail,
			pid: this.running ? (this.proc?.pid ?? null) : null,
			startedAt: this.startedAt,
			uptimeSec: this.startedAt
				? Math.round((Date.now() - this.startedAt) / 1000)
				: null,
			restarts: this.restarts,
			lastExitCode: this.lastExitCode,
			lastExitSignal: this.lastExitSignal,
			lastExitAt: this.lastExitAt,
			error: this.error,
			cpu: this.cpu,
			rssBytes: this.rssBytes,
			command: this.spec.shell
				? this.spec.command.join(" ")
				: this.spec.command.join(" "),
			autostart: this.spec.autostart,
			restartPolicy: this.spec.restart,
		};
	}

	/** Applies an edited spec without losing the running child, when it can. */
	adopt(spec: ProcessSpec, project: ProjectSpec) {
		const commandChanged =
			spec.command.join(" ") !== this.spec.command.join(" ") ||
			spec.shell !== this.spec.shell ||
			spec.cwd !== this.spec.cwd ||
			spec.user !== this.spec.user;
		this.spec = spec;
		this.project = project;
		this.logs.resize(spec.logLines);
		if (commandChanged && this.running) {
			this.log("system", "definition changed — restart to pick it up");
		}
		if (this.running) this.startHealthchecks();
	}

	dispose() {
		if (this.restartTimer) clearTimeout(this.restartTimer);
		if (this.stopTimer) clearTimeout(this.stopTimer);
		this.stopHealthchecks();
	}
}

/** Runs one healthcheck. Never throws: a failed probe is data, not an error. */
async function probe(
	check: HealthCheck,
): Promise<{ ok: boolean; detail: string }> {
	try {
		if (check.type === "http") {
			const res = await fetch(check.url!, {
				signal: AbortSignal.timeout(check.timeoutMs),
				redirect: "manual",
			});
			const ok = check.expectStatus?.length
				? check.expectStatus.includes(res.status)
				: res.status >= 200 && res.status < 400;
			return { ok, detail: `HTTP ${res.status}` };
		}

		if (check.type === "tcp") {
			const host = check.host ?? "127.0.0.1";
			await new Promise<void>((resolvePromise, reject) => {
				const socket = connect({ host, port: check.port! });
				const timer = setTimeout(() => {
					socket.destroy();
					reject(new Error(`timed out after ${check.timeoutMs}ms`));
				}, check.timeoutMs);
				socket.once("connect", () => {
					clearTimeout(timer);
					socket.end();
					resolvePromise();
				});
				socket.once("error", (err) => {
					clearTimeout(timer);
					reject(err);
				});
			});
			return { ok: true, detail: `connected to ${host}:${check.port}` };
		}

		const proc = Bun.spawn(check.command!, { stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill("SIGKILL"), check.timeoutMs);
		const code = await proc.exited;
		clearTimeout(timer);
		return { ok: code === 0, detail: `exit ${code}` };
	} catch (err) {
		return {
			ok: false,
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

const whichCache = new Map<string, boolean>();

async function which(binary: string): Promise<boolean> {
	const cached = whichCache.get(binary);
	if (cached !== undefined) return cached;
	const proc = Bun.spawn(["sh", "-c", `command -v ${binary}`], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const found = (await proc.exited) === 0;
	whichCache.set(binary, found);
	return found;
}

export class Supervisor {
	private projects: ProjectSpec[] = [];
	private managed = new Map<string, ManagedProcess>();
	private sources: string[] = [];
	private loadErrors: string[] = [];
	private listeners = new Set<() => void>();

	constructor(private paths?: string[]) {}

	/** Fires whenever a process changes state, so telemetry can be sent early. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed = () => {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// a listener must not break the state machine
			}
		}
	};

	private key(projectId: string, processId: string) {
		return `${projectId}/${processId}`;
	}

	/**
	 * Reads the projects file(s) and reconciles: new processes are created (and
	 * autostarted), edited ones adopt their new spec, removed ones are stopped.
	 */
	async load(): Promise<LoadedProjects> {
		const loaded = await loadProjects(this.paths);
		this.projects = loaded.projects;
		this.sources = loaded.sources;
		this.loadErrors = loaded.errors;

		const wanted = new Set<string>();
		const started: Promise<void>[] = [];

		for (const project of loaded.projects) {
			for (const spec of project.processes) {
				const key = this.key(project.id, spec.id);
				wanted.add(key);
				const existing = this.managed.get(key);

				if (existing) {
					existing.adopt(spec, project);
					if (!project.enabled && existing.running)
						started.push(existing.stop());
					continue;
				}

				const managed = new ManagedProcess(
					spec,
					project.id,
					project,
					this.changed,
				);
				this.managed.set(key, managed);
				if (project.enabled && spec.autostart) started.push(managed.start());
			}
		}

		for (const [key, managed] of this.managed) {
			if (wanted.has(key)) continue;
			this.managed.delete(key);
			started.push(managed.stop().finally(() => managed.dispose()));
		}

		await Promise.all(started);
		this.changed();
		return loaded;
	}

	get definitions(): LoadedProjects {
		return {
			projects: this.projects,
			sources: this.sources,
			errors: this.loadErrors,
		};
	}

	private find(projectId: string, processId: string): ManagedProcess {
		const managed = this.managed.get(this.key(projectId, processId));
		if (!managed)
			throw new Error(`unknown process '${projectId}/${processId}'`);
		return managed;
	}

	private processesOf(projectId: string): ManagedProcess[] {
		const project = this.projects.find((p) => p.id === projectId);
		if (!project) throw new Error(`unknown project '${projectId}'`);
		return project.processes
			.map((spec) => this.managed.get(this.key(projectId, spec.id)))
			.filter((m): m is ManagedProcess => Boolean(m));
	}

	async start(projectId: string, processId?: string) {
		const targets = processId
			? [this.find(projectId, processId)]
			: this.processesOf(projectId);
		await Promise.all(targets.map((m) => m.start(true)));
	}

	async stop(projectId: string, processId?: string) {
		const targets = processId
			? [this.find(projectId, processId)]
			: this.processesOf(projectId);
		await Promise.all(targets.map((m) => m.stop()));
	}

	async restart(projectId: string, processId?: string) {
		const targets = processId
			? [this.find(projectId, processId)]
			: this.processesOf(projectId);
		await Promise.all(targets.map((m) => m.restart()));
	}

	/** Last N lines, then live ones until the signal aborts. */
	tail(
		projectId: string,
		processId: string,
		count: number,
		onLine: (line: LogLine) => void,
		signal?: AbortSignal,
	): () => void {
		const managed = this.find(projectId, processId);
		for (const line of managed.logs.tail(count)) onLine(line);
		const unsubscribe = managed.logs.subscribe(onLine);
		signal?.addEventListener("abort", unsubscribe, { once: true });
		return unsubscribe;
	}

	/** Working directory and environment for a terminal opened "in" a project. */
	async shellContext(
		projectId: string,
	): Promise<{ cwd: string | null; env: Record<string, string> }> {
		const project = this.projects.find((p) => p.id === projectId);
		if (!project) throw new Error(`unknown project '${projectId}'`);
		const fromFiles = await loadEnvFiles(project.envFiles);
		return {
			cwd: project.cwd,
			env: { ...fromFiles, ...project.env, STATS_PROJECT: project.id },
		};
	}

	async status(): Promise<ProjectStatus[]> {
		await Promise.all([...this.managed.values()].map((m) => m.sample()));

		return this.projects.map((project) => {
			const processes = project.processes
				.map((spec) =>
					this.managed.get(this.key(project.id, spec.id))?.status(),
				)
				.filter((s): s is ProcessStatus => Boolean(s));

			const running = processes.filter((p) => p.state === "running").length;
			const unhealthy = processes.some((p) => p.health === "unhealthy");
			// Only a failure nothing will retry counts. A process that is merely not
			// running is not a fault: one-shots exit, and a project may deliberately
			// run some of its processes some of the time.
			const broken = processes.some((p) => p.state === "fatal");

			let summary: ProjectStatus["summary"];
			if (!processes.length) summary = "empty";
			else if (broken || unhealthy) summary = "degraded";
			else if (running > 0) summary = "running";
			else summary = "stopped";

			return {
				id: project.id,
				name: project.name,
				description: project.description,
				tags: project.tags,
				url: project.url,
				enabled: project.enabled,
				processes,
				watch: project.watch,
				summary,
			};
		});
	}

	/** Stops everything. Called on shutdown so a node restart doesn't orphan children. */
	async shutdown() {
		await Promise.all(
			[...this.managed.values()].map((m) =>
				m.stop().finally(() => m.dispose()),
			),
		);
		this.managed.clear();
		this.listeners.clear();
	}
}
