import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import schema from "../../schema/projects.schema.json" with { type: "json" };
import {
	DEFAULTS,
	loadEnvFiles,
	loadProjects,
	parseProjectsDocument,
} from "./projects.ts";
import { Supervisor } from "./supervisor.ts";

const dirs: string[] = [];

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "stats-projects-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

const minimal = (overrides: Record<string, unknown> = {}) => ({
	projects: [
		{
			id: "demo",
			processes: [{ id: "web", command: ["sleep", "1"], ...overrides }],
		},
	],
});

describe("projects schema", () => {
	/**
	 * The schema is what people read; the loader is what enforces it. If a
	 * default moves in one, this fails until it moves in the other.
	 */
	test("the loader's defaults match the schema's", () => {
		const process = schema.$defs.process.properties;
		expect(process.shell.default).toBe(DEFAULTS.shell);
		expect(process.autostart.default).toBe(DEFAULTS.autostart);
		expect(process.restart.default).toBe(DEFAULTS.restart);
		expect(process.restartDelayMs.default).toBe(DEFAULTS.restartDelayMs);
		expect(process.maxRestarts.default).toBe(DEFAULTS.maxRestarts);
		expect(process.restartWindowSec.default).toBe(DEFAULTS.restartWindowSec);
		expect(process.stopSignal.default).toBe(DEFAULTS.stopSignal);
		expect(process.stopTimeoutSec.default).toBe(DEFAULTS.stopTimeoutSec);
		expect(process.logLines.default).toBe(DEFAULTS.logLines);
		expect(schema.$defs.project.properties.enabled.default).toBe(
			DEFAULTS.enabled,
		);

		const health = schema.$defs.healthcheck.properties;
		expect(health.intervalSec.default).toBe(DEFAULTS.health.intervalSec);
		expect(health.timeoutMs.default).toBe(DEFAULTS.health.timeoutMs);
		expect(health.failures.default).toBe(DEFAULTS.health.failures);
		expect(health.startPeriodSec.default).toBe(DEFAULTS.health.startPeriodSec);
		expect(health.host.default).toBe(DEFAULTS.health.host);
	});

	test("the shipped example parses with no errors", async () => {
		const file = Bun.file(`${import.meta.dir}/../../projects.example.json`);
		const { projects, errors } = parseProjectsDocument(
			await file.json(),
			"example",
		);

		expect(errors).toEqual([]);
		expect(projects.map((p) => p.id)).toEqual([
			"billing-api",
			"backups",
			"scratch",
		]);

		const api = projects[0]!;
		expect(api.processes).toHaveLength(2);
		expect(api.processes[0]!.healthcheck?.type).toBe("http");
		expect(api.watch.systemd).toEqual(["nginx.service"]);
		// A project with nothing to run is legitimate — it just watches units.
		expect(projects[1]!.processes).toEqual([]);
		// shell:true keeps the pipeline intact instead of splitting it into argv.
		expect(projects[2]!.processes[0]!.command).toEqual([
			"tail -F /var/log/syslog | grep -v CRON",
		]);
	});
});

describe("projects loader", () => {
	test("applies every documented default", () => {
		const { projects, errors } = parseProjectsDocument(minimal(), "test");
		expect(errors).toEqual([]);

		const proc = projects[0]!.processes[0]!;
		expect(proc.name).toBe("web"); // defaults to the id
		expect(proc.autostart).toBe(DEFAULTS.autostart);
		expect(proc.restart).toBe(DEFAULTS.restart);
		expect(proc.stopSignal).toBe(DEFAULTS.stopSignal);
		expect(proc.logLines).toBe(DEFAULTS.logLines);
		expect(proc.healthcheck).toBeNull();
		expect(projects[0]!.enabled).toBe(true);
	});

	test("inherits cwd from the project and lets a process override it", () => {
		const { projects } = parseProjectsDocument(
			{
				projects: [
					{
						id: "p",
						cwd: "/srv/app",
						processes: [
							{ id: "a", command: "true" },
							{ id: "b", command: "true", cwd: "/srv/other" },
						],
					},
				],
			},
			"test",
		);
		expect(projects[0]!.processes[0]!.cwd).toBe("/srv/app");
		expect(projects[0]!.processes[1]!.cwd).toBe("/srv/other");
	});

	test("rejects a bad id rather than guessing", () => {
		const { projects, errors } = parseProjectsDocument(
			{ projects: [{ id: "has spaces", processes: [] }] },
			"test",
		);
		expect(projects).toEqual([]);
		expect(errors[0]).toMatch(/letters, digits, dash or underscore/);
	});

	test("reports a missing command without dropping the rest of the file", () => {
		const { projects, errors } = parseProjectsDocument(
			{
				projects: [
					{ id: "broken", processes: [{ id: "x" }] },
					{ id: "fine", processes: [{ id: "y", command: "true" }] },
				],
			},
			"test",
		);
		expect(errors.some((e) => /command.*required/.test(e))).toBe(true);
		expect(projects.map((p) => p.id)).toEqual(["broken", "fine"]);
		expect(projects[0]!.processes).toEqual([]);
		expect(projects[1]!.processes).toHaveLength(1);
	});

	test("rejects an unknown restart policy and falls back to the default", () => {
		const { projects, errors } = parseProjectsDocument(
			minimal({ restart: "sometimes" }),
			"test",
		);
		expect(errors.some((e) => /must be one of/.test(e))).toBe(true);
		expect(projects[0]!.processes[0]!.restart).toBe(DEFAULTS.restart);
	});

	test("requires the fields each healthcheck type needs", () => {
		const http = parseProjectsDocument(
			minimal({ healthcheck: { type: "http" } }),
			"test",
		);
		expect(http.errors.some((e) => /url.*required/.test(e))).toBe(true);

		const tcp = parseProjectsDocument(
			minimal({ healthcheck: { type: "tcp", port: 8080 } }),
			"test",
		);
		expect(tcp.errors).toEqual([]);
		expect(tcp.projects[0]!.processes[0]!.healthcheck).toMatchObject({
			type: "tcp",
			port: 8080,
			host: "127.0.0.1",
		});
	});

	test("rejects duplicate process ids inside a project", () => {
		const { errors, projects } = parseProjectsDocument(
			{
				projects: [
					{
						id: "p",
						processes: [
							{ id: "a", command: "true" },
							{ id: "a", command: "false" },
						],
					},
				],
			},
			"test",
		);
		expect(errors.some((e) => /duplicate process id/.test(e))).toBe(true);
		expect(projects[0]!.processes).toHaveLength(1);
	});

	test("refuses a version it doesn't speak", () => {
		const { errors } = parseProjectsDocument(
			{ version: 99, projects: [] },
			"test",
		);
		expect(errors[0]).toMatch(/unsupported version/);
	});

	test("merges a projects.d directory and flags duplicate project ids", async () => {
		const dir = await workdir();
		await Bun.write(
			join(dir, "10-a.json"),
			JSON.stringify({ projects: [{ id: "a", processes: [] }] }),
		);
		await Bun.write(
			join(dir, "20-b.json"),
			JSON.stringify({ projects: [{ id: "b", processes: [] }] }),
		);
		await Bun.write(
			join(dir, "30-dupe.json"),
			JSON.stringify({ projects: [{ id: "a", processes: [] }] }),
		);

		const loaded = await loadProjects([dir]);
		expect(loaded.projects.map((p) => p.id)).toEqual(["a", "b"]);
		expect(loaded.sources).toHaveLength(3);
		expect(loaded.errors[0]).toMatch(/already defined in/);
	});

	test("resolves envFiles relative to the file that declared them", async () => {
		const dir = await workdir();
		await Bun.write(
			join(dir, "projects.json"),
			JSON.stringify({
				projects: [{ id: "p", envFiles: ["shared.env"], processes: [] }],
			}),
		);
		const loaded = await loadProjects([join(dir, "projects.json")]);
		expect(loaded.projects[0]!.envFiles[0]).toBe(join(dir, "shared.env"));
	});

	test("explains malformed JSON instead of throwing", async () => {
		const dir = await workdir();
		await Bun.write(join(dir, "projects.json"), "{ nope");
		const loaded = await loadProjects([join(dir, "projects.json")]);
		expect(loaded.projects).toEqual([]);
		expect(loaded.errors[0]).toMatch(/not valid JSON/);
	});

	test("a missing file is simply no projects", async () => {
		const loaded = await loadProjects([join(await workdir(), "absent.json")]);
		expect(loaded).toEqual({ projects: [], sources: [], errors: [] });
	});
});

describe("env files", () => {
	test("reads KEY=value, skipping comments and honouring quotes", async () => {
		const dir = await workdir();
		const path = join(dir, "a.env");
		await Bun.write(
			path,
			[
				"# a comment",
				"FOO=bar",
				'export QUOTED="two words"',
				"EMPTY=",
				"junk",
			].join("\n"),
		);

		expect(await loadEnvFiles([path])).toEqual({
			FOO: "bar",
			QUOTED: "two words",
			EMPTY: "",
		});
	});

	test("later files win", async () => {
		const dir = await workdir();
		await Bun.write(join(dir, "1.env"), "A=one\nB=one");
		await Bun.write(join(dir, "2.env"), "B=two");
		expect(
			await loadEnvFiles([join(dir, "1.env"), join(dir, "2.env")]),
		).toEqual({
			A: "one",
			B: "two",
		});
	});
});

describe("supervisor", () => {
	/** Waits for a predicate, so tests don't race the process state machine. */
	async function eventually(
		check: () => boolean | Promise<boolean>,
		timeoutMs = 5000,
	) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await check()) return;
			await Bun.sleep(25);
		}
		throw new Error("condition was never met");
	}

	async function withProjects(
		doc: unknown,
	): Promise<{ dir: string; supervisor: Supervisor }> {
		const dir = await workdir();
		await Bun.write(join(dir, "projects.json"), JSON.stringify(doc));
		return { dir, supervisor: new Supervisor([join(dir, "projects.json")]) };
	}

	test("autostarts a process, captures its output and reports it running", async () => {
		const { supervisor } = await withProjects({
			projects: [
				{
					id: "demo",
					processes: [
						{
							id: "talker",
							command: ["sh", "-c", "echo hello; sleep 30"],
							restart: "never",
						},
					],
				},
			],
		});

		try {
			await supervisor.load();
			await eventually(
				async () =>
					(await supervisor.status())[0]!.processes[0]!.state === "running",
			);

			const [project] = await supervisor.status();
			const proc = project!.processes[0]!;
			expect(proc.state).toBe("running");
			expect(proc.pid).toBeGreaterThan(0);
			expect(project!.summary).toBe("running");

			const lines: string[] = [];
			supervisor.tail("demo", "talker", 100, (line) =>
				lines.push(line.message),
			);
			await eventually(() => lines.includes("hello"));
			// The supervisor's own annotations are tagged so the UI can dim them.
			expect(lines.some((l) => l.startsWith("started:"))).toBe(true);
		} finally {
			await supervisor.shutdown();
		}
	});

	test("honours autostart:false and starts on request", async () => {
		const { supervisor } = await withProjects({
			projects: [
				{
					id: "demo",
					processes: [
						{
							id: "idle",
							command: ["sleep", "30"],
							autostart: false,
							restart: "never",
						},
					],
				},
			],
		});

		try {
			await supervisor.load();
			expect((await supervisor.status())[0]!.processes[0]!.state).toBe(
				"stopped",
			);

			await supervisor.start("demo", "idle");
			await eventually(
				async () =>
					(await supervisor.status())[0]!.processes[0]!.state === "running",
			);

			await supervisor.stop("demo", "idle");
			const proc = (await supervisor.status())[0]!.processes[0]!;
			expect(proc.state).toBe("stopped");
			expect(proc.pid).toBeNull();
		} finally {
			await supervisor.shutdown();
		}
	});

	test("restarts a crashing process and gives up at maxRestarts", async () => {
		const { supervisor } = await withProjects({
			projects: [
				{
					id: "demo",
					processes: [
						{
							id: "flaky",
							command: ["sh", "-c", "exit 3"],
							restart: "on-failure",
							restartDelayMs: 10,
							maxRestarts: 2,
							restartWindowSec: 60,
						},
					],
				},
			],
		});

		try {
			await supervisor.load();
			await eventually(
				async () =>
					(await supervisor.status())[0]!.processes[0]!.state === "fatal",
			);

			const proc = (await supervisor.status())[0]!.processes[0]!;
			expect(proc.restarts).toBe(2);
			expect(proc.lastExitCode).toBe(3);
			expect(proc.error).toMatch(/gave up after 2 restarts/);
			expect((await supervisor.status())[0]!.summary).toBe("degraded");
		} finally {
			await supervisor.shutdown();
		}
	});

	test("leaves a clean exit alone under restart:on-failure", async () => {
		const { supervisor } = await withProjects({
			projects: [
				{
					id: "demo",
					processes: [{ id: "once", command: ["true"], restart: "on-failure" }],
				},
			],
		});

		try {
			await supervisor.load();
			await eventually(
				async () =>
					(await supervisor.status())[0]!.processes[0]!.state === "exited",
			);
			const proc = (await supervisor.status())[0]!.processes[0]!;
			expect(proc.restarts).toBe(0);
			expect(proc.lastExitCode).toBe(0);
		} finally {
			await supervisor.shutdown();
		}
	});

	test("a tcp healthcheck turns running into healthy", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const { supervisor } = await withProjects({
			projects: [
				{
					id: "demo",
					processes: [
						{
							id: "web",
							command: ["sleep", "30"],
							restart: "never",
							healthcheck: {
								type: "tcp",
								port: server.port,
								intervalSec: 1,
								startPeriodSec: 0,
								failures: 1,
							},
						},
					],
				},
			],
		});

		try {
			await supervisor.load();
			// Health starts as "starting" and only becomes healthy once a probe lands.
			expect((await supervisor.status())[0]!.processes[0]!.health).toBe(
				"starting",
			);
			await eventually(
				async () =>
					(await supervisor.status())[0]!.processes[0]!.health === "healthy",
				8000,
			);
		} finally {
			await supervisor.shutdown();
			await server.stop(true);
		}
	});

	test("an http healthcheck against a dead port reports unhealthy", async () => {
		const { supervisor } = await withProjects({
			projects: [
				{
					id: "demo",
					processes: [
						{
							id: "web",
							command: ["sleep", "30"],
							restart: "never",
							healthcheck: {
								type: "http",
								// Port 1 is never listening, and connecting fails immediately.
								url: "http://127.0.0.1:1/health",
								intervalSec: 1,
								startPeriodSec: 0,
								failures: 1,
								timeoutMs: 500,
							},
						},
					],
				},
			],
		});

		try {
			await supervisor.load();
			await eventually(
				async () =>
					(await supervisor.status())[0]!.processes[0]!.health === "unhealthy",
				8000,
			);
			expect((await supervisor.status())[0]!.summary).toBe("degraded");
		} finally {
			await supervisor.shutdown();
		}
	});

	test("reload stops processes that were removed from the file", async () => {
		const dir = await workdir();
		const path = join(dir, "projects.json");
		await Bun.write(
			path,
			JSON.stringify({
				projects: [
					{
						id: "demo",
						processes: [
							{ id: "a", command: ["sleep", "30"], restart: "never" },
							{ id: "b", command: ["sleep", "30"], restart: "never" },
						],
					},
				],
			}),
		);
		const supervisor = new Supervisor([path]);

		try {
			await supervisor.load();
			await eventually(
				async () => (await supervisor.status())[0]!.processes.length === 2,
			);

			await Bun.write(
				path,
				JSON.stringify({
					projects: [
						{
							id: "demo",
							processes: [
								{ id: "a", command: ["sleep", "30"], restart: "never" },
							],
						},
					],
				}),
			);
			await supervisor.load();

			const [project] = await supervisor.status();
			expect(project!.processes.map((p) => p.id)).toEqual(["a"]);
			// 'a' kept running across the reload rather than being restarted.
			expect(project!.processes[0]!.state).toBe("running");
		} finally {
			await supervisor.shutdown();
		}
	});

	test("shellContext hands a terminal the project's cwd and env", async () => {
		const { dir, supervisor } = await withProjects({
			projects: [
				{ id: "demo", cwd: "/tmp", env: { GREETING: "hi" }, processes: [] },
			],
		});
		void dir;

		try {
			await supervisor.load();
			const context = await supervisor.shellContext("demo");
			expect(context.cwd).toBe("/tmp");
			expect(context.env).toMatchObject({
				GREETING: "hi",
				STATS_PROJECT: "demo",
			});
			expect(() => supervisor.shellContext("nope")).toThrow;
		} finally {
			await supervisor.shutdown();
		}
	});
});
