import { cloneElement, useId, useMemo, useState } from "react";
import { DEFAULTS, parseProjectsDocument } from "../src/agent/projects.ts";
import type { CaIssueResult } from "../src/proto/messages.ts";
import type { HubConnection } from "./link.ts";
import { ActionButton } from "./ui.tsx";

/**
 * Two things a fleet operator wants without touching a shell: a projects.json
 * to drop onto a node, and a cert signed by the fleet's own CA (see
 * src/hub/ca.ts). Neither writes anything — the projects form is local to
 * this tab, dropped the moment it's closed, and a node's real projects file
 * only ever comes from src/agent/projects.ts reading disk. The cert side asks
 * the hub to sign, but the hub hands the leaf key back and keeps no copy —
 * this page is the only place it's ever shown.
 *
 * The builder is a form over schema/projects.schema.json. Every input is a
 * string so "blank" can mean "unset", the document is rebuilt from the fields
 * on every render with defaults left out, and it's checked by the very
 * `parseProjectsDocument` the node runs — so what this page calls valid is what
 * `stats check` calls valid.
 */

/* ---------- projects builder ---------- */

type HealthType = "" | "http" | "tcp" | "command";

interface HealthForm {
	type: HealthType;
	url: string;
	expectStatus: string;
	port: string;
	host: string;
	command: string;
	intervalSec: string;
	timeoutMs: string;
	failures: string;
	startPeriodSec: string;
}

interface ProcessForm {
	key: number;
	id: string;
	name: string;
	command: string;
	shell: boolean;
	cwd: string;
	env: string;
	envFiles: string;
	autostart: boolean;
	restart: "always" | "on-failure" | "never";
	restartDelayMs: string;
	maxRestarts: string;
	restartWindowSec: string;
	user: string;
	group: string;
	stopSignal: string;
	stopTimeoutSec: string;
	logLines: string;
	health: HealthForm;
}

interface ProjectForm {
	key: number;
	id: string;
	name: string;
	description: string;
	cwd: string;
	url: string;
	tags: string;
	env: string;
	envFiles: string;
	enabled: boolean;
	processes: ProcessForm[];
	watch: { systemd: string; containers: string; ports: string; paths: string };
}

let nextKey = 1;

function blankHealth(): HealthForm {
	return {
		type: "",
		url: "",
		expectStatus: "",
		port: "",
		host: "",
		command: "",
		intervalSec: "",
		timeoutMs: "",
		failures: "",
		startPeriodSec: "",
	};
}

export function blankProcess(seed: Partial<ProcessForm> = {}): ProcessForm {
	return {
		key: nextKey++,
		id: "",
		name: "",
		command: "",
		shell: DEFAULTS.shell,
		cwd: "",
		env: "",
		envFiles: "",
		autostart: DEFAULTS.autostart,
		restart: DEFAULTS.restart,
		restartDelayMs: "",
		maxRestarts: "",
		restartWindowSec: "",
		user: "",
		group: "",
		stopSignal: "",
		stopTimeoutSec: "",
		logLines: "",
		health: blankHealth(),
		...seed,
	};
}

export function blankProject(seed: Partial<ProjectForm> = {}): ProjectForm {
	return {
		key: nextKey++,
		id: "",
		name: "",
		description: "",
		cwd: "",
		url: "",
		tags: "",
		env: "",
		envFiles: "",
		enabled: DEFAULTS.enabled,
		processes: [],
		watch: { systemd: "", containers: "", ports: "", paths: "" },
		...seed,
	};
}

/** The same starting point the old template gave: one project, one process. */
export function exampleProjects(): ProjectForm[] {
	return [
		blankProject({
			id: "example",
			name: "Example",
			cwd: "/opt/example",
			processes: [blankProcess({ id: "web", command: "bun run start" })],
		}),
	];
}

/* ---------- field text → document values ---------- */

const list = (value: string) =>
	value
		.split(/[,\n]/)
		.map((s) => s.trim())
		.filter(Boolean);

/** A number field left blank is unset; anything else is passed through so the validator can name it. */
const num = (value: string): number | string | undefined => {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const n = Number(trimmed);
	return Number.isFinite(n) ? n : trimmed;
};

/** Ports and status codes: a list of numbers, with anything odd left for the validator. */
const nums = (value: string): (number | string)[] | undefined => {
	const parts = list(value);
	if (!parts.length) return undefined;
	return parts.map((p) => num(p) as number | string);
};

/** KEY=value lines, the same shape as an env file. */
function envLines(
	value: string,
	where: string,
	errors: string[],
): Record<string, string> | undefined {
	const env: Record<string, string> = {};
	let any = false;
	value.split("\n").forEach((line, i) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) return;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) {
			errors.push(`${where} line ${i + 1}: expected KEY=value`);
			return;
		}
		env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
		any = true;
	});
	return any ? env : undefined;
}

/** Drops undefined values so the document only says what the form set. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
	for (const key of Object.keys(obj)) {
		const v = obj[key];
		if (
			v === undefined ||
			(Array.isArray(v) && v.length === 0) ||
			(v &&
				typeof v === "object" &&
				!Array.isArray(v) &&
				!Object.keys(v).length)
		)
			delete obj[key];
	}
	return obj;
}

function buildHealth(h: HealthForm) {
	if (!h.type) return undefined;
	return compact({
		type: h.type,
		url: h.type === "http" ? h.url.trim() || undefined : undefined,
		expectStatus: h.type === "http" ? nums(h.expectStatus) : undefined,
		port: h.type === "tcp" ? num(h.port) : undefined,
		host: h.type === "tcp" ? h.host.trim() || undefined : undefined,
		command: h.type === "command" ? list(h.command) : undefined,
		intervalSec: num(h.intervalSec),
		timeoutMs: num(h.timeoutMs),
		failures: num(h.failures),
		startPeriodSec: num(h.startPeriodSec),
	});
}

function buildProcess(p: ProcessForm, where: string, errors: string[]) {
	const command = p.command.trim();
	return compact({
		id: p.id.trim(),
		name: p.name.trim() || undefined,
		// With shell the string is the script; without it the file is explicit argv.
		command: p.shell ? command : command.split(/\s+/).filter(Boolean),
		shell: p.shell === DEFAULTS.shell ? undefined : p.shell,
		cwd: p.cwd.trim() || undefined,
		env: envLines(p.env, `${where}.env`, errors),
		envFiles: list(p.envFiles),
		autostart: p.autostart === DEFAULTS.autostart ? undefined : p.autostart,
		restart: p.restart === DEFAULTS.restart ? undefined : p.restart,
		restartDelayMs: num(p.restartDelayMs),
		maxRestarts: num(p.maxRestarts),
		restartWindowSec: num(p.restartWindowSec),
		user: p.user.trim() || undefined,
		group: p.group.trim() || undefined,
		stopSignal: p.stopSignal.trim() || undefined,
		stopTimeoutSec: num(p.stopTimeoutSec),
		logLines: num(p.logLines),
		healthcheck: buildHealth(p.health),
	});
}

function buildProject(p: ProjectForm, where: string, errors: string[]) {
	return compact({
		id: p.id.trim(),
		name: p.name.trim() || undefined,
		description: p.description.trim() || undefined,
		cwd: p.cwd.trim() || undefined,
		env: envLines(p.env, `${where}.env`, errors),
		envFiles: list(p.envFiles),
		tags: list(p.tags),
		url: p.url.trim() || undefined,
		enabled: p.enabled === DEFAULTS.enabled ? undefined : p.enabled,
		processes: p.processes.map((proc, i) =>
			buildProcess(proc, `${where}.processes[${i}]`, errors),
		),
		watch: compact({
			systemd: list(p.watch.systemd),
			containers: list(p.watch.containers),
			ports: nums(p.watch.ports),
			paths: list(p.watch.paths),
		}),
	});
}

/** Exported for the test; the page only ever calls it through the form. */
export function buildDocument(projects: ProjectForm[]) {
	const errors: string[] = [];
	const doc = {
		$schema: "/schema/projects.schema.json",
		version: DEFAULTS.version,
		projects: projects.map((p, i) => buildProject(p, `projects[${i}]`, errors)),
	};
	// Duplicate project ids are caught by the multi-file loader, not the
	// per-document parser, so the form checks that one itself.
	const seen = new Set<string>();
	for (const { id } of doc.projects) {
		if (!id) continue;
		if (seen.has(id)) errors.push(`projects: project '${id}' is defined twice`);
		seen.add(id);
	}
	errors.push(...parseProjectsDocument(doc, "projects.json").errors);
	return { doc, errors };
}

/* ---------- document values → field text (import) ---------- */

const rawStr = (v: unknown): string => (typeof v === "string" ? v : "");
const rawNum = (v: unknown): string => (typeof v === "number" ? String(v) : "");
const rawListStr = (v: unknown): string =>
	Array.isArray(v)
		? v
				.filter((x) => typeof x === "string" || typeof x === "number")
				.map(String)
				.join(", ")
		: "";
const rawEnvStr = (v: unknown): string => {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return "";
	return Object.entries(v as Record<string, unknown>)
		.map(([k, val]) => `${k}=${val}`)
		.join("\n");
};

function fromRawHealth(raw: unknown): HealthForm {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return blankHealth();
	const h = raw as Record<string, unknown>;
	const type =
		h.type === "http" || h.type === "tcp" || h.type === "command"
			? h.type
			: "";
	return {
		type,
		url: rawStr(h.url),
		expectStatus: rawListStr(h.expectStatus),
		port: rawNum(h.port),
		host: rawStr(h.host),
		command: Array.isArray(h.command) ? rawListStr(h.command) : "",
		intervalSec: rawNum(h.intervalSec),
		timeoutMs: rawNum(h.timeoutMs),
		failures: rawNum(h.failures),
		startPeriodSec: rawNum(h.startPeriodSec),
	};
}

function fromRawProcess(raw: unknown): ProcessForm {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return blankProcess();
	const p = raw as Record<string, unknown>;
	const command = Array.isArray(p.command)
		? p.command.filter((c) => typeof c === "string").join(" ")
		: typeof p.command === "string"
			? p.command
			: "";
	const restart =
		p.restart === "always" || p.restart === "never" || p.restart === "on-failure"
			? p.restart
			: DEFAULTS.restart;
	return blankProcess({
		id: rawStr(p.id),
		name: rawStr(p.name),
		command,
		shell: typeof p.shell === "boolean" ? p.shell : DEFAULTS.shell,
		cwd: rawStr(p.cwd),
		env: rawEnvStr(p.env),
		envFiles: rawListStr(p.envFiles),
		autostart:
			typeof p.autostart === "boolean" ? p.autostart : DEFAULTS.autostart,
		restart,
		restartDelayMs: rawNum(p.restartDelayMs),
		maxRestarts: rawNum(p.maxRestarts),
		restartWindowSec: rawNum(p.restartWindowSec),
		user: rawStr(p.user),
		group: rawStr(p.group),
		stopSignal: rawStr(p.stopSignal),
		stopTimeoutSec: rawNum(p.stopTimeoutSec),
		logLines: rawNum(p.logLines),
		health: fromRawHealth(p.healthcheck),
	});
}

function fromRawProject(raw: unknown): ProjectForm {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return blankProject();
	const p = raw as Record<string, unknown>;
	const watch =
		typeof p.watch === "object" && p.watch !== null && !Array.isArray(p.watch)
			? (p.watch as Record<string, unknown>)
			: {};
	return blankProject({
		id: rawStr(p.id),
		name: rawStr(p.name),
		description: rawStr(p.description),
		cwd: rawStr(p.cwd),
		url: rawStr(p.url),
		tags: rawListStr(p.tags),
		env: rawEnvStr(p.env),
		envFiles: rawListStr(p.envFiles),
		enabled: typeof p.enabled === "boolean" ? p.enabled : DEFAULTS.enabled,
		processes: Array.isArray(p.processes)
			? p.processes.map(fromRawProcess)
			: [],
		watch: {
			systemd: rawListStr(watch.systemd),
			containers: rawListStr(watch.containers),
			ports: rawListStr(watch.ports),
			paths: rawListStr(watch.paths),
		},
	});
}

/** Exported for the test. Parses a pasted projects.json into forms, blank staying blank rather than filled with the validator's defaults. */
export function importDocument(
	text: string,
): { projects: ProjectForm[] } | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { error: `invalid JSON — ${err instanceof Error ? err.message : err}` };
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!Array.isArray((parsed as Record<string, unknown>).projects)
	) {
		return { error: "expected an object with a 'projects' array" };
	}
	const projects = (parsed as { projects: unknown[] }).projects.map(
		fromRawProject,
	);
	return { projects };
}

/* ---------- field widgets ---------- */

function Field({
	label,
	hint,
	wide,
	children,
}: {
	label: string;
	hint?: string;
	wide?: boolean;
	/** the one input this labels; it gets the generated id */
	children: React.ReactElement<{ id?: string }>;
}) {
	const id = useId();
	return (
		<div className={`field${wide ? " wide" : ""}`} title={hint}>
			<label className="field-label" htmlFor={id}>
				{label}
			</label>
			{cloneElement(children, { id })}
		</div>
	);
}

function Text({
	id,
	value,
	onChange,
	placeholder,
	mono,
}: {
	id?: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	mono?: boolean;
}) {
	return (
		<input
			id={id}
			type="text"
			className={mono ? "mono" : undefined}
			spellCheck={false}
			value={value}
			placeholder={placeholder}
			onChange={(event) => onChange(event.target.value)}
		/>
	);
}

function Num({
	id,
	value,
	onChange,
	placeholder,
	min,
}: {
	id?: string;
	value: string;
	onChange: (value: string) => void;
	placeholder: number | string;
	min?: number;
}) {
	return (
		<input
			id={id}
			type="number"
			min={min}
			value={value}
			placeholder={String(placeholder)}
			onChange={(event) => onChange(event.target.value)}
		/>
	);
}

function Lines({
	id,
	value,
	onChange,
	placeholder,
	rows = 3,
}: {
	id?: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	rows?: number;
}) {
	return (
		<textarea
			id={id}
			className="mono"
			spellCheck={false}
			rows={rows}
			value={value}
			placeholder={placeholder}
			onChange={(event) => onChange(event.target.value)}
		/>
	);
}

function Check({
	label,
	checked,
	onChange,
	hint,
}: {
	label: string;
	checked: boolean;
	onChange: (value: boolean) => void;
	hint?: string;
}) {
	return (
		<label className="field check" title={hint}>
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
			/>
			<span>{label}</span>
		</label>
	);
}

/* ---------- process and project forms ---------- */

function HealthFields({
	value,
	onChange,
}: {
	value: HealthForm;
	onChange: (value: HealthForm) => void;
}) {
	const set = <K extends keyof HealthForm>(key: K, v: HealthForm[K]) =>
		onChange({ ...value, [key]: v });
	const d = DEFAULTS.health;
	return (
		<div className="fields">
			<Field
				label="type"
				hint="Turns 'running' into 'working'. Failures don't restart the process; they mark it unhealthy."
			>
				<select
					value={value.type}
					onChange={(event) => set("type", event.target.value as HealthType)}
				>
					<option value="">none</option>
					<option value="http">http</option>
					<option value="tcp">tcp</option>
					<option value="command">command</option>
				</select>
			</Field>
			{value.type === "http" && (
				<>
					<Field label="url" hint="Absolute URL to GET." wide>
						<Text
							mono
							value={value.url}
							placeholder="http://127.0.0.1:3000/health"
							onChange={(v) => set("url", v)}
						/>
					</Field>
					<Field
						label="expect status"
						hint="Status codes counted as healthy; comma-separated. Defaults to anything in 200-399."
					>
						<Text
							mono
							value={value.expectStatus}
							placeholder="200, 204"
							onChange={(v) => set("expectStatus", v)}
						/>
					</Field>
				</>
			)}
			{value.type === "tcp" && (
				<>
					<Field label="port">
						<Num
							value={value.port}
							placeholder="3000"
							min={1}
							onChange={(v) => set("port", v)}
						/>
					</Field>
					<Field label="host">
						<Text
							mono
							value={value.host}
							placeholder={d.host}
							onChange={(v) => set("host", v)}
						/>
					</Field>
				</>
			)}
			{value.type === "command" && (
				<Field
					label="command"
					hint="argv run to completion; exit 0 is healthy. Comma-separated."
					wide
				>
					<Text
						mono
						value={value.command}
						placeholder="pg_isready, -q"
						onChange={(v) => set("command", v)}
					/>
				</Field>
			)}
			{value.type && (
				<>
					<Field label="interval (s)">
						<Num
							value={value.intervalSec}
							placeholder={d.intervalSec}
							min={1}
							onChange={(v) => set("intervalSec", v)}
						/>
					</Field>
					<Field label="timeout (ms)">
						<Num
							value={value.timeoutMs}
							placeholder={d.timeoutMs}
							min={100}
							onChange={(v) => set("timeoutMs", v)}
						/>
					</Field>
					<Field
						label="failures"
						hint="Consecutive failures before the process is called unhealthy."
					>
						<Num
							value={value.failures}
							placeholder={d.failures}
							min={1}
							onChange={(v) => set("failures", v)}
						/>
					</Field>
					<Field
						label="start period (s)"
						hint="Grace period after start during which failures don't count."
					>
						<Num
							value={value.startPeriodSec}
							placeholder={d.startPeriodSec}
							min={0}
							onChange={(v) => set("startPeriodSec", v)}
						/>
					</Field>
				</>
			)}
		</div>
	);
}

function ProcessFields({
	value,
	onChange,
	onRemove,
}: {
	value: ProcessForm;
	onChange: (value: ProcessForm) => void;
	onRemove: () => void;
}) {
	const set = <K extends keyof ProcessForm>(key: K, v: ProcessForm[K]) =>
		onChange({ ...value, [key]: v });
	return (
		<div className="subpanel">
			<div className="panel-head">
				<h4>process {value.id.trim() || "(unnamed)"}</h4>
				<button type="button" className="action danger" onClick={onRemove}>
					Remove
				</button>
			</div>
			<div className="fields">
				<Field
					label="id"
					hint="Stable id: letters, digits, dash and underscore. Used in the API, so changing it is a rename."
				>
					<Text
						mono
						value={value.id}
						placeholder="web"
						onChange={(v) => set("id", v)}
					/>
				</Field>
				<Field label="name" hint="Display name. Defaults to the id.">
					<Text
						value={value.name}
						placeholder={value.id || "Web"}
						onChange={(v) => set("name", v)}
					/>
				</Field>
				<Field
					label="command"
					hint="Split on whitespace and exec'd directly — no shell, no quoting rules. Tick shell for pipes, globs and redirection."
					wide
				>
					<Text
						mono
						value={value.command}
						placeholder="bun run start"
						onChange={(v) => set("command", v)}
					/>
				</Field>
				<Check
					label="run through sh -c"
					hint="Needed for pipes, globs and redirection; avoid it otherwise so signals reach the real process."
					checked={value.shell}
					onChange={(v) => set("shell", v)}
				/>
				<Check
					label="autostart"
					hint="Start when the node starts. Off leaves it stopped until someone starts it from the dashboard."
					checked={value.autostart}
					onChange={(v) => set("autostart", v)}
				/>
				<Field label="cwd" hint="Overrides the project's cwd.">
					<Text
						mono
						value={value.cwd}
						placeholder="inherits project"
						onChange={(v) => set("cwd", v)}
					/>
				</Field>
				<Field
					label="restart"
					hint="always: restart on any exit. on-failure: only on a non-zero exit or a signal. never: leave it exited."
				>
					<select
						value={value.restart}
						onChange={(event) =>
							set("restart", event.target.value as ProcessForm["restart"])
						}
					>
						<option value="on-failure">on-failure</option>
						<option value="always">always</option>
						<option value="never">never</option>
					</select>
				</Field>
			</div>

			<details className="fieldset">
				<summary>Restart, stop, user, logs</summary>
				<div className="fields">
					<Field
						label="restart delay (ms)"
						hint="Wait before restarting. Backs off up to 30s while a process keeps failing."
					>
						<Num
							value={value.restartDelayMs}
							placeholder={DEFAULTS.restartDelayMs}
							min={0}
							onChange={(v) => set("restartDelayMs", v)}
						/>
					</Field>
					<Field
						label="max restarts"
						hint="Give up (state: fatal) after this many restarts inside the window. 0 never gives up."
					>
						<Num
							value={value.maxRestarts}
							placeholder={DEFAULTS.maxRestarts}
							min={0}
							onChange={(v) => set("maxRestarts", v)}
						/>
					</Field>
					<Field
						label="restart window (s)"
						hint="The window max restarts is counted over."
					>
						<Num
							value={value.restartWindowSec}
							placeholder={DEFAULTS.restartWindowSec}
							min={1}
							onChange={(v) => set("restartWindowSec", v)}
						/>
					</Field>
					<Field
						label="stop signal"
						hint="Signal sent to stop the process, e.g. SIGTERM, SIGINT, SIGQUIT."
					>
						<Text
							mono
							value={value.stopSignal}
							placeholder={DEFAULTS.stopSignal}
							onChange={(v) => set("stopSignal", v)}
						/>
					</Field>
					<Field
						label="stop timeout (s)"
						hint="How long to wait after the stop signal before SIGKILL."
					>
						<Num
							value={value.stopTimeoutSec}
							placeholder={DEFAULTS.stopTimeoutSec}
							min={1}
							onChange={(v) => set("stopTimeoutSec", v)}
						/>
					</Field>
					<Field
						label="log lines"
						hint="Output lines kept in memory for the log tail."
					>
						<Num
							value={value.logLines}
							placeholder={DEFAULTS.logLines}
							min={10}
							onChange={(v) => set("logLines", v)}
						/>
					</Field>
					<Field
						label="user"
						hint="Run as this user. The node must be root; it uses setpriv/su to drop privileges."
					>
						<Text
							mono
							value={value.user}
							placeholder="same as node"
							onChange={(v) => set("user", v)}
						/>
					</Field>
					<Field label="group" hint="Run as this group. Requires user.">
						<Text
							mono
							value={value.group}
							placeholder="user's default"
							onChange={(v) => set("group", v)}
						/>
					</Field>
				</div>
			</details>

			<details className="fieldset">
				<summary>Environment</summary>
				<div className="fields">
					<Field
						label="env"
						hint="One KEY=value per line. Values are used literally; no shell expansion."
						wide
					>
						<Lines
							value={value.env}
							placeholder={"PORT=3000\nNODE_ENV=production"}
							onChange={(v) => set("env", v)}
						/>
					</Field>
					<Field
						label="env files"
						hint="Files of KEY=value lines loaded before env, which wins. Relative paths resolve against cwd. Comma-separated."
						wide
					>
						<Text
							mono
							value={value.envFiles}
							placeholder=".env, .env.production"
							onChange={(v) => set("envFiles", v)}
						/>
					</Field>
				</div>
			</details>

			<details className="fieldset" open={value.health.type !== ""}>
				<summary>Healthcheck</summary>
				<HealthFields value={value.health} onChange={(v) => set("health", v)} />
			</details>
		</div>
	);
}

function ProjectFields({
	value,
	onChange,
	onRemove,
}: {
	value: ProjectForm;
	onChange: (value: ProjectForm) => void;
	onRemove: () => void;
}) {
	const set = <K extends keyof ProjectForm>(key: K, v: ProjectForm[K]) =>
		onChange({ ...value, [key]: v });
	const setWatch = (key: keyof ProjectForm["watch"], v: string) =>
		set("watch", { ...value.watch, [key]: v });
	const setProcess = (index: number, proc: ProcessForm) =>
		set(
			"processes",
			value.processes.map((p, i) => (i === index ? proc : p)),
		);

	return (
		<section className="panel">
			<header className="panel-head">
				<h4>project {value.id.trim() || "(unnamed)"}</h4>
				<button type="button" className="action danger" onClick={onRemove}>
					Remove project
				</button>
			</header>

			<div className="fields">
				<Field
					label="id"
					hint="Stable id: letters, digits, dash and underscore. Used in the API, so changing it is a rename."
				>
					<Text
						mono
						value={value.id}
						placeholder="example"
						onChange={(v) => set("id", v)}
					/>
				</Field>
				<Field label="name" hint="Display name. Defaults to the id.">
					<Text
						value={value.name}
						placeholder={value.id || "Example"}
						onChange={(v) => set("name", v)}
					/>
				</Field>
				<Field
					label="cwd"
					hint="Absolute working directory inherited by every process in the project."
				>
					<Text
						mono
						value={value.cwd}
						placeholder="/opt/example"
						onChange={(v) => set("cwd", v)}
					/>
				</Field>
				<Field
					label="url"
					hint="Where this project is served, linked from its card."
				>
					<Text
						mono
						value={value.url}
						placeholder="https://example.internal"
						onChange={(v) => set("url", v)}
					/>
				</Field>
				<Field label="description" wide>
					<Text
						value={value.description}
						onChange={(v) => set("description", v)}
					/>
				</Field>
				<Field
					label="tags"
					hint="Free-form labels, shown as chips and usable as a dashboard filter. Comma-separated."
				>
					<Text
						value={value.tags}
						placeholder="web, prod"
						onChange={(v) => set("tags", v)}
					/>
				</Field>
				<Check
					label="enabled"
					hint="Off keeps the project in the file but stops the node acting on it."
					checked={value.enabled}
					onChange={(v) => set("enabled", v)}
				/>
			</div>

			<details className="fieldset">
				<summary>Environment</summary>
				<div className="fields">
					<Field
						label="env"
						hint="One KEY=value per line, inherited by every process. Values are used literally; no shell expansion."
						wide
					>
						<Lines
							value={value.env}
							placeholder={"NODE_ENV=production"}
							onChange={(v) => set("env", v)}
						/>
					</Field>
					<Field
						label="env files"
						hint="Files of KEY=value lines loaded before env, which wins. Relative paths resolve against cwd. Comma-separated."
						wide
					>
						<Text
							mono
							value={value.envFiles}
							placeholder=".env"
							onChange={(v) => set("envFiles", v)}
						/>
					</Field>
				</div>
			</details>

			<details className="fieldset">
				<summary>Watch — things this project owns but doesn't run</summary>
				<div className="fields">
					<Field
						label="systemd units"
						hint="Comma-separated, e.g. nginx.service."
					>
						<Text
							mono
							value={value.watch.systemd}
							placeholder="nginx.service"
							onChange={(v) => setWatch("systemd", v)}
						/>
					</Field>
					<Field label="containers" hint="Container names, comma-separated.">
						<Text
							mono
							value={value.watch.containers}
							placeholder="example-db"
							onChange={(v) => setWatch("containers", v)}
						/>
					</Field>
					<Field
						label="ports"
						hint="Ports this project is expected to be listening on. Comma-separated."
					>
						<Text
							mono
							value={value.watch.ports}
							placeholder="80, 443"
							onChange={(v) => setWatch("ports", v)}
						/>
					</Field>
					<Field
						label="paths"
						hint="Log files or directories to offer in the log picker. Comma-separated."
					>
						<Text
							mono
							value={value.watch.paths}
							placeholder="/var/log/example"
							onChange={(v) => setWatch("paths", v)}
						/>
					</Field>
				</div>
			</details>

			<div className="stack" style={{ marginTop: 12 }}>
				{value.processes.map((proc, i) => (
					<ProcessFields
						key={proc.key}
						value={proc}
						onChange={(p) => setProcess(i, p)}
						onRemove={() =>
							set(
								"processes",
								value.processes.filter((_, j) => j !== i),
							)
						}
					/>
				))}
				<div className="toolbar">
					<button
						type="button"
						onClick={() =>
							set("processes", [...value.processes, blankProcess()])
						}
					>
						Add process
					</button>
				</div>
			</div>
		</section>
	);
}

export function ProjectsBuilder() {
	const [projects, setProjects] = useState<ProjectForm[]>(exampleProjects);
	const { doc, errors } = useMemo(() => buildDocument(projects), [projects]);
	const text = useMemo(() => `${JSON.stringify(doc, null, 2)}\n`, [doc]);

	const [importText, setImportText] = useState("");
	const [importError, setImportError] = useState<string | null>(null);
	const [importOpen, setImportOpen] = useState(false);

	const doImport = () => {
		const result = importDocument(importText);
		if ("error" in result) {
			setImportError(result.error);
			return;
		}
		setProjects(result.projects.length ? result.projects : exampleProjects());
		setImportError(null);
		setImportText("");
		setImportOpen(false);
	};

	const copy = async () => {
		await navigator.clipboard.writeText(text);
	};

	const download = () => {
		const blob = new Blob([text], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "projects.json";
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="stack">
			<section className="panel">
				<header className="panel-head">
					<h4>Projects file</h4>
					<span className="dim">
						Built here only — nothing is sent anywhere. Blank fields take the
						node's defaults and stay out of the file. Drop the result onto a
						node at <span className="mono">/etc/stats/projects.json</span>, or
						as a file under <span className="mono">/etc/stats/projects.d/</span>
						.
					</span>
				</header>
				<details
					className="fieldset"
					open={importOpen}
					onToggle={(event) => setImportOpen(event.currentTarget.open)}
				>
					<summary>Paste a projects.json to fill this out</summary>
					<div className="fields">
						<Field
							label="projects.json"
							hint="Replaces every project below with what's pasted here."
							wide
						>
							<Lines
								value={importText}
								placeholder='{"projects": [...]}'
								rows={8}
								onChange={setImportText}
							/>
						</Field>
					</div>
					{importError && <div className="issues errors">{importError}</div>}
					<div className="toolbar">
						<button type="button" onClick={doImport} disabled={!importText.trim()}>
							Load
						</button>
					</div>
				</details>
			</section>

			{projects.map((project, i) => (
				<ProjectFields
					key={project.key}
					value={project}
					onChange={(p) =>
						setProjects(projects.map((q, j) => (j === i ? p : q)))
					}
					onRemove={() => setProjects(projects.filter((_, j) => j !== i))}
				/>
			))}

			<div className="toolbar">
				<button
					type="button"
					onClick={() => setProjects([...projects, blankProject()])}
				>
					Add project
				</button>
				<button type="button" onClick={() => setProjects(exampleProjects())}>
					Reset
				</button>
			</div>

			<section className="panel">
				<header className="panel-head">
					<h4>projects.json</h4>
					<span className="dim">
						Checked by the same code a node loads it with.
					</span>
					<button
						type="button"
						className="action"
						onClick={copy}
						style={{ marginLeft: "auto" }}
					>
						Copy
					</button>
					<button type="button" className="action" onClick={download}>
						Download
					</button>
				</header>

				{errors.length > 0 && (
					<ul className="issues errors">
						{errors.map((error) => (
							<li key={error}>{error}</li>
						))}
					</ul>
				)}

				<textarea
					className="code-editor mono"
					spellCheck={false}
					rows={Math.min(40, text.split("\n").length)}
					readOnly
					value={text}
				/>
			</section>
		</div>
	);
}

/* ---------- certificate issuer ---------- */

function CertIssuer({ hub }: { hub: HubConnection }) {
	const [commonName, setCommonName] = useState("");
	const [sans, setSans] = useState("");
	const [days, setDays] = useState(825);
	const [issued, setIssued] = useState<CaIssueResult | null>(null);

	const issue = async () => {
		const result = await hub.request<CaIssueResult>("ca.issue", {
			commonName,
			sans: sans
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
			days,
		});
		setIssued(result);
	};

	return (
		<section className="panel">
			<header className="panel-head">
				<h4>Generate a certificate</h4>
				<span className="dim">
					Signed by the fleet's own CA — the same one nodes trust in{" "}
					<span className="mono">src/agent/modules/ca.ts</span>. The key is
					shown once and kept nowhere but here.
				</span>
			</header>

			<div className="toolbar">
				<input
					type="text"
					placeholder="common name, e.g. grafana.internal"
					value={commonName}
					onChange={(event) => setCommonName(event.target.value)}
				/>
				<input
					type="text"
					placeholder="extra SANs, comma-separated"
					value={sans}
					onChange={(event) => setSans(event.target.value)}
				/>
				<input
					type="number"
					min={1}
					max={3650}
					value={days}
					title="days valid"
					onChange={(event) => setDays(Number(event.target.value) || 825)}
					style={{ width: 90 }}
				/>
				<ActionButton
					disabled={!commonName.trim()}
					onAction={issue}
					title="ask the hub to sign a new leaf cert"
				>
					Generate
				</ActionButton>
			</div>

			{issued && (
				<div className="stack" style={{ marginTop: 12 }}>
					<div>
						<div className="panel-head">
							<h4>Certificate</h4>
							<button
								type="button"
								onClick={() => navigator.clipboard.writeText(issued.cert)}
							>
								Copy
							</button>
						</div>
						<textarea
							className="code-editor mono"
							spellCheck={false}
							rows={10}
							readOnly
							value={issued.cert}
						/>
					</div>
					<div>
						<div className="panel-head">
							<h4>Private key</h4>
							<button
								type="button"
								onClick={() => navigator.clipboard.writeText(issued.key)}
							>
								Copy
							</button>
						</div>
						<textarea
							className="code-editor mono"
							spellCheck={false}
							rows={8}
							readOnly
							value={issued.key}
						/>
					</div>
					<div>
						<div className="panel-head">
							<h4>Fleet CA cert</h4>
							<span className="dim">
								Append this if the service needs the whole chain.
							</span>
							<button
								type="button"
								onClick={() => navigator.clipboard.writeText(issued.caCert)}
							>
								Copy
							</button>
						</div>
						<textarea
							className="code-editor mono"
							spellCheck={false}
							rows={8}
							readOnly
							value={issued.caCert}
						/>
					</div>
				</div>
			)}
		</section>
	);
}

export function ToolsPage({ hub }: { hub: HubConnection }) {
	return (
		<div className="modules-page">
			<header className="page-head">
				<h2>Tools</h2>
				<span className="dim">
					Local scratch space — nothing on this page touches a node's real
					files.
				</span>
			</header>

			<ProjectsBuilder />
			<CertIssuer hub={hub} />
		</div>
	);
}
