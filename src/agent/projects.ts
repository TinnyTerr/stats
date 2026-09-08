import { dirname, isAbsolute, resolve } from "node:path";
import type {
	HealthCheck,
	ProcessSpec,
	ProjectSpec,
	ProjectWatch,
	RestartPolicy,
} from "../types.ts";

/**
 * Loads and validates the projects file — the contract by which an agent is
 * told what to run. The JSON Schema in schema/projects.schema.json is the
 * document; this is the enforcement, and `DEFAULTS` below is asserted against
 * the schema's own `default` keywords in the tests so the two can't drift.
 */

/**
 * Where the loader looks when no path is given, in order. `process` is reached
 * for defensively because the dashboard's projects builder imports this file
 * for `parseProjectsDocument`, and a browser has no such global.
 */
export const DEFAULT_SOURCES = [
	globalThis.process?.env?.STATS_PROJECTS,
	"/etc/stats/projects.json",
	"/etc/stats/projects.d",
	"./projects.json",
].filter((p): p is string => Boolean(p));

export const DEFAULTS = {
	version: 1,
	enabled: true,
	shell: false,
	autostart: true,
	restart: "on-failure" as RestartPolicy,
	restartDelayMs: 2000,
	maxRestarts: 10,
	restartWindowSec: 300,
	stopSignal: "SIGTERM",
	stopTimeoutSec: 10,
	logLines: 1000,
	health: {
		intervalSec: 30,
		timeoutMs: 3000,
		failures: 3,
		startPeriodSec: 10,
		host: "127.0.0.1",
	},
} as const;

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const RESTART_POLICIES: RestartPolicy[] = ["always", "on-failure", "never"];

export interface LoadedProjects {
	projects: ProjectSpec[];
	/** files actually read, in load order */
	sources: string[];
	/** validation failures; the offending project is skipped, the rest still load */
	errors: string[];
}

class Validator {
	readonly errors: string[] = [];

	constructor(private where: string) {}

	fail(path: string, message: string) {
		this.errors.push(`${this.where}${path ? ` ${path}` : ""}: ${message}`);
	}

	string(
		value: unknown,
		path: string,
		fallback: string | null = null,
	): string | null {
		if (value === undefined || value === null) return fallback;
		if (typeof value !== "string") {
			this.fail(path, `expected a string, got ${typeof value}`);
			return fallback;
		}
		return value;
	}

	bool(value: unknown, path: string, fallback: boolean): boolean {
		if (value === undefined || value === null) return fallback;
		if (typeof value !== "boolean") {
			this.fail(path, `expected true or false, got ${JSON.stringify(value)}`);
			return fallback;
		}
		return value;
	}

	int(
		value: unknown,
		path: string,
		fallback: number,
		min = 0,
		max = Number.MAX_SAFE_INTEGER,
	) {
		if (value === undefined || value === null) return fallback;
		if (typeof value !== "number" || !Number.isInteger(value)) {
			this.fail(path, `expected a whole number, got ${JSON.stringify(value)}`);
			return fallback;
		}
		if (value < min || value > max) {
			this.fail(path, `must be between ${min} and ${max}, got ${value}`);
			return Math.min(Math.max(value, min), max);
		}
		return value;
	}

	strings(value: unknown, path: string): string[] {
		if (value === undefined || value === null) return [];
		if (!Array.isArray(value)) {
			this.fail(path, "expected an array of strings");
			return [];
		}
		const out: string[] = [];
		value.forEach((entry, i) => {
			if (typeof entry === "string") out.push(entry);
			else this.fail(`${path}[${i}]`, "expected a string");
		});
		return out;
	}

	env(value: unknown, path: string): Record<string, string> {
		if (value === undefined || value === null) return {};
		if (typeof value !== "object" || Array.isArray(value)) {
			this.fail(path, "expected an object of KEY: value pairs");
			return {};
		}
		const out: Record<string, string> = {};
		for (const [key, entry] of Object.entries(
			value as Record<string, unknown>,
		)) {
			if (typeof entry === "string") out[key] = entry;
			else if (typeof entry === "number" || typeof entry === "boolean")
				out[key] = String(entry);
			else this.fail(`${path}.${key}`, "environment values must be strings");
		}
		return out;
	}

	id(value: unknown, path: string): string | null {
		const raw = this.string(value, path);
		if (raw === null) {
			this.fail(path, "is required");
			return null;
		}
		if (!ID_PATTERN.test(raw)) {
			this.fail(
				path,
				`'${raw}' must be letters, digits, dash or underscore (max 64 chars)`,
			);
			return null;
		}
		return raw;
	}
}

function parseCommand(
	value: unknown,
	shell: boolean,
	v: Validator,
	path: string,
): string[] | null {
	if (Array.isArray(value)) {
		const parts = v.strings(value, path);
		if (!parts.length) {
			v.fail(path, "is empty");
			return null;
		}
		return parts;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) {
			v.fail(path, "is empty");
			return null;
		}
		// With shell:true the string is the script; otherwise it's naive argv.
		return shell ? [trimmed] : trimmed.split(/\s+/);
	}
	v.fail(path, "is required — a command string or an argv array");
	return null;
}

function parseHealthcheck(
	raw: unknown,
	v: Validator,
	path: string,
): HealthCheck | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		v.fail(path, "expected an object");
		return null;
	}
	const obj = raw as Record<string, unknown>;
	const type = v.string(obj.type, `${path}.type`);
	if (type !== "http" && type !== "tcp" && type !== "command") {
		v.fail(
			`${path}.type`,
			`must be http, tcp or command (got ${JSON.stringify(obj.type)})`,
		);
		return null;
	}

	const check: HealthCheck = {
		type,
		intervalSec: v.int(
			obj.intervalSec,
			`${path}.intervalSec`,
			DEFAULTS.health.intervalSec,
			1,
		),
		timeoutMs: v.int(
			obj.timeoutMs,
			`${path}.timeoutMs`,
			DEFAULTS.health.timeoutMs,
			100,
		),
		failures: v.int(
			obj.failures,
			`${path}.failures`,
			DEFAULTS.health.failures,
			1,
		),
		startPeriodSec: v.int(
			obj.startPeriodSec,
			`${path}.startPeriodSec`,
			DEFAULTS.health.startPeriodSec,
			0,
		),
	};

	if (type === "http") {
		const url = v.string(obj.url, `${path}.url`);
		if (!url) {
			v.fail(`${path}.url`, "is required for an http healthcheck");
			return null;
		}
		try {
			new URL(url);
		} catch {
			v.fail(`${path}.url`, `'${url}' is not a valid URL`);
			return null;
		}
		check.url = url;
		if (obj.expectStatus !== undefined) {
			const codes = Array.isArray(obj.expectStatus) ? obj.expectStatus : [];
			check.expectStatus = codes.filter(
				(c): c is number => typeof c === "number",
			);
		}
	} else if (type === "tcp") {
		const port = v.int(obj.port, `${path}.port`, 0, 0, 65535);
		if (!port) {
			v.fail(`${path}.port`, "is required for a tcp healthcheck");
			return null;
		}
		check.port = port;
		check.host =
			v.string(obj.host, `${path}.host`, DEFAULTS.health.host) ??
			DEFAULTS.health.host;
	} else {
		const command = v.strings(obj.command, `${path}.command`);
		if (!command.length) {
			v.fail(`${path}.command`, "is required for a command healthcheck");
			return null;
		}
		check.command = command;
	}

	return check;
}

function parseWatch(raw: unknown, v: Validator, path: string): ProjectWatch {
	const empty: ProjectWatch = {
		systemd: [],
		containers: [],
		ports: [],
		paths: [],
	};
	if (raw === undefined || raw === null) return empty;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		v.fail(path, "expected an object");
		return empty;
	}
	const obj = raw as Record<string, unknown>;
	const ports: number[] = [];
	if (Array.isArray(obj.ports)) {
		obj.ports.forEach((p, i) => {
			if (typeof p === "number" && Number.isInteger(p) && p > 0 && p <= 65535)
				ports.push(p);
			else v.fail(`${path}.ports[${i}]`, "expected a port number");
		});
	}
	return {
		systemd: v.strings(obj.systemd, `${path}.systemd`),
		containers: v.strings(obj.containers, `${path}.containers`),
		ports,
		paths: v.strings(obj.paths, `${path}.paths`),
	};
}

function parseProcess(
	raw: unknown,
	v: Validator,
	path: string,
	project: { cwd: string | null },
): ProcessSpec | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		v.fail(path, "expected an object");
		return null;
	}
	const obj = raw as Record<string, unknown>;

	const id = v.id(obj.id, `${path}.id`);
	if (!id) return null;

	const shell = v.bool(obj.shell, `${path}.shell`, DEFAULTS.shell);
	const command = parseCommand(obj.command, shell, v, `${path}.command`);
	if (!command) return null;

	const restartRaw = v.string(
		obj.restart,
		`${path}.restart`,
		DEFAULTS.restart,
	)!;
	const restart = RESTART_POLICIES.includes(restartRaw as RestartPolicy)
		? (restartRaw as RestartPolicy)
		: (v.fail(
				`${path}.restart`,
				`must be one of ${RESTART_POLICIES.join(", ")}`,
			),
			DEFAULTS.restart);

	const user = v.string(obj.user, `${path}.user`);
	const group = v.string(obj.group, `${path}.group`);
	if (group && !user) v.fail(`${path}.group`, "needs 'user' as well");

	const stopSignal = v.string(
		obj.stopSignal,
		`${path}.stopSignal`,
		DEFAULTS.stopSignal,
	)!;
	if (!/^SIG[A-Z0-9]+$/.test(stopSignal)) {
		v.fail(`${path}.stopSignal`, `'${stopSignal}' should look like SIGTERM`);
	}

	return {
		id,
		name: v.string(obj.name, `${path}.name`) ?? id,
		command,
		shell,
		cwd: v.string(obj.cwd, `${path}.cwd`) ?? project.cwd,
		env: v.env(obj.env, `${path}.env`),
		envFiles: v.strings(obj.envFiles, `${path}.envFiles`),
		autostart: v.bool(obj.autostart, `${path}.autostart`, DEFAULTS.autostart),
		restart,
		restartDelayMs: v.int(
			obj.restartDelayMs,
			`${path}.restartDelayMs`,
			DEFAULTS.restartDelayMs,
			0,
		),
		maxRestarts: v.int(
			obj.maxRestarts,
			`${path}.maxRestarts`,
			DEFAULTS.maxRestarts,
			0,
		),
		restartWindowSec: v.int(
			obj.restartWindowSec,
			`${path}.restartWindowSec`,
			DEFAULTS.restartWindowSec,
			1,
		),
		user,
		group,
		stopSignal,
		stopTimeoutSec: v.int(
			obj.stopTimeoutSec,
			`${path}.stopTimeoutSec`,
			DEFAULTS.stopTimeoutSec,
			1,
		),
		logLines: v.int(
			obj.logLines,
			`${path}.logLines`,
			DEFAULTS.logLines,
			10,
			100_000,
		),
		healthcheck: parseHealthcheck(obj.healthcheck, v, `${path}.healthcheck`),
	};
}

/** Validates one parsed projects document. Exported for tests and `stats check`. */
export function parseProjectsDocument(
	raw: unknown,
	where: string,
): { projects: ProjectSpec[]; errors: string[] } {
	const v = new Validator(where);

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {
			projects: [],
			errors: [`${where}: expected a JSON object at the top level`],
		};
	}
	const doc = raw as Record<string, unknown>;

	if (doc.version !== undefined && doc.version !== DEFAULTS.version) {
		v.fail(
			"version",
			`unsupported version ${JSON.stringify(doc.version)}; this node speaks 1`,
		);
	}
	if (!Array.isArray(doc.projects)) {
		return { projects: [], errors: [`${where}: 'projects' must be an array`] };
	}

	const projects: ProjectSpec[] = [];
	doc.projects.forEach((entry, index) => {
		const path = `projects[${index}]`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			v.fail(path, "expected an object");
			return;
		}
		const obj = entry as Record<string, unknown>;
		const id = v.id(obj.id, `${path}.id`);
		if (!id) return;

		const cwd = v.string(obj.cwd, `${path}.cwd`);
		if (cwd && !isAbsolute(cwd))
			v.fail(`${path}.cwd`, `'${cwd}' must be an absolute path`);

		const rawProcesses = obj.processes;
		if (rawProcesses !== undefined && !Array.isArray(rawProcesses)) {
			v.fail(`${path}.processes`, "expected an array");
			return;
		}

		const processes: ProcessSpec[] = [];
		const seen = new Set<string>();
		for (const [i, procRaw] of ((rawProcesses ?? []) as unknown[]).entries()) {
			const proc = parseProcess(procRaw, v, `${path}.processes[${i}]`, { cwd });
			if (!proc) continue;
			if (seen.has(proc.id)) {
				v.fail(
					`${path}.processes[${i}].id`,
					`duplicate process id '${proc.id}'`,
				);
				continue;
			}
			seen.add(proc.id);
			processes.push(proc);
		}

		projects.push({
			id,
			name: v.string(obj.name, `${path}.name`) ?? id,
			description: v.string(obj.description, `${path}.description`),
			cwd,
			env: v.env(obj.env, `${path}.env`),
			envFiles: v.strings(obj.envFiles, `${path}.envFiles`),
			tags: v.strings(obj.tags, `${path}.tags`),
			url: v.string(obj.url, `${path}.url`),
			enabled: v.bool(obj.enabled, `${path}.enabled`, DEFAULTS.enabled),
			processes,
			watch: parseWatch(obj.watch, v, `${path}.watch`),
		});
	});

	return { projects, errors: v.errors };
}

async function readJson(
	path: string,
): Promise<{ value?: unknown; error?: string }> {
	const file = Bun.file(path);
	if (!(await file.exists())) return {};
	try {
		return { value: await file.json() };
	} catch (err) {
		return {
			error: `${path}: not valid JSON — ${err instanceof Error ? err.message : err}`,
		};
	}
}

/** Expands a directory source into the *.json files inside it, sorted. */
async function expand(source: string): Promise<string[]> {
	const stat = await Bun.file(source)
		.stat()
		.catch(() => null);
	if (stat?.isDirectory()) {
		const names = [
			...new Bun.Glob("*.json").scanSync({ cwd: source, onlyFiles: true }),
		];
		return names.sort().map((name) => resolve(source, name));
	}
	return [source];
}

/**
 * Reads every source, merging them into one project list. Later files can't
 * silently shadow earlier ones — a duplicate id is an error, since two files
 * both claiming to own "api" is a mistake worth surfacing.
 */
export async function loadProjects(
	paths: string[] = DEFAULT_SOURCES,
): Promise<LoadedProjects> {
	const projects: ProjectSpec[] = [];
	const sources: string[] = [];
	const errors: string[] = [];
	const byId = new Map<string, string>();

	for (const candidate of paths) {
		for (const path of await expand(candidate)) {
			const { value, error } = await readJson(path);
			if (error) {
				errors.push(error);
				continue;
			}
			if (value === undefined) continue;

			sources.push(path);
			const parsed = parseProjectsDocument(value, path);
			errors.push(...parsed.errors);

			for (const project of parsed.projects) {
				const existing = byId.get(project.id);
				if (existing) {
					errors.push(
						`${path}: project '${project.id}' is already defined in ${existing}`,
					);
					continue;
				}
				byId.set(project.id, path);
				// Relative paths in a project file resolve against that file.
				projects.push(resolveRelativePaths(project, dirname(path)));
			}
		}
	}

	return { projects, sources, errors };
}

function resolveRelativePaths(project: ProjectSpec, base: string): ProjectSpec {
	const fix = (path: string, cwd: string | null) =>
		isAbsolute(path) ? path : resolve(cwd ?? base, path);
	return {
		...project,
		envFiles: project.envFiles.map((f) => fix(f, project.cwd)),
		processes: project.processes.map((proc) => ({
			...proc,
			envFiles: proc.envFiles.map((f) => fix(f, proc.cwd ?? project.cwd)),
		})),
	};
}

/** Loads KEY=value files, ignoring blanks and comments. Later files win. */
export async function loadEnvFiles(
	paths: string[],
): Promise<Record<string, string>> {
	const env: Record<string, string> = {};
	for (const path of paths) {
		const text = await Bun.file(path)
			.text()
			.catch(() => null);
		if (text === null) continue;
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq === -1) continue;
			const key = trimmed
				.slice(0, eq)
				.trim()
				.replace(/^export\s+/, "");
			let value = trimmed.slice(eq + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			env[key] = value;
		}
	}
	return env;
}
