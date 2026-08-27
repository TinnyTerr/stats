import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNode } from "../agent/agent.ts";
import {
	BUILTIN_MODULE_IDS,
	moduleOn,
	resolveModules,
} from "../modules/manifest.ts";
import { COMPRESS_THRESHOLD, Flags, MessageType } from "../proto/frame.ts";
import { PeerLink } from "../proto/link.ts";
import { HubAction, NodeAction } from "../proto/messages.ts";
import type { HubConfig, NodeSummary, Telemetry } from "../types.ts";
import { loadConfig } from "./config.ts";
import { MetricStore } from "./db.ts";
import { diffAlerts } from "./registry.ts";
import { startHub } from "./server.ts";

const paths: string[] = [];

const tmp = (name: string) => {
	const path = join(import.meta.dir, "../..", `.test-${name}`);
	paths.push(path);
	return path;
};

afterEach(async () => {
	await Promise.all(
		paths.splice(0).map((p) => rm(p, { recursive: true, force: true })),
	);
});

async function writeConfig(name: string, body: unknown): Promise<string> {
	const path = tmp(`${name}.json`);
	await Bun.write(path, JSON.stringify(body));
	return path;
}

describe("hub config", () => {
	test("applies defaults to an empty file", async () => {
		const config = await loadConfig(await writeConfig("empty", {}));
		expect(config.port).toBe(3000);
		expect(config.host).toBe("127.0.0.1");
		expect(config.telemetryIntervalMs).toBe(3000);
		expect(config.allowUnknownNodes).toBe(true);
		expect(config.nodes).toEqual([]);
	});

	test("derives the node timeout from the telemetry interval", async () => {
		const path = await writeConfig("interval", { telemetryIntervalMs: 10_000 });
		expect((await loadConfig(path)).nodeTimeoutMs).toBe(30_000);

		const fast = await writeConfig("fast", { telemetryIntervalMs: 1000 });
		// Never so tight that a slow host is called dead: 15s floor.
		expect((await loadConfig(fast)).nodeTimeoutMs).toBe(15_000);
	});

	test("resolves env: token indirection", async () => {
		process.env.TEST_HUB_NODE_TOKEN = "s3cret";
		const path = await writeConfig("env", {
			nodeToken: "env:TEST_HUB_NODE_TOKEN",
		});
		expect((await loadConfig(path)).nodeToken).toBe("s3cret");
		delete process.env.TEST_HUB_NODE_TOKEN;
	});

	test("rejects duplicate node overrides", async () => {
		const path = await writeConfig("dupe", {
			nodes: [{ id: "a" }, { id: "a" }],
		});
		expect(loadConfig(path)).rejects.toThrow(/duplicate node id/);
	});

	test("rejects an explicit config path that isn't there", () => {
		expect(loadConfig(tmp("nope.json"))).rejects.toThrow(/config not found/);
	});

	test("leaves notion off when the file says nothing about it", async () => {
		const config = await loadConfig(await writeConfig("no-notion", {}));
		expect(config.notion).toBeNull();
	});

	test("resolves the notion token and floors the interval", async () => {
		process.env.TEST_NOTION_TOKEN = "ntn_x";
		const path = await writeConfig("notion", {
			notion: {
				token: "env:TEST_NOTION_TOKEN",
				database: "abc123",
				intervalMs: 1000,
			},
		});
		const config = await loadConfig(path);
		expect(config.notion?.token).toBe("ntn_x");
		expect(config.notion?.database).toBe("abc123");
		// Notion rate-limits per integration, so a typo can't become a hot loop.
		expect(config.notion?.intervalMs).toBe(15_000);
		delete process.env.TEST_NOTION_TOKEN;
	});

	test("an enabled notion block without credentials fails the boot", async () => {
		const noDb = await writeConfig("notion-nodb", {
			notion: { token: "ntn_x" },
		});
		expect(loadConfig(noDb)).rejects.toThrow(/notion.database/);

		const noToken = await writeConfig("notion-notoken", {
			notion: { database: "abc123" },
		});
		expect(loadConfig(noToken)).rejects.toThrow(/notion.token/);
	});

	test("an unset env var is a clearer error than a missing token", async () => {
		delete process.env.TEST_NOTION_ABSENT;
		const path = await writeConfig("notion-unset", {
			notion: { token: "env:TEST_NOTION_ABSENT", database: "abc123" },
		});
		expect(loadConfig(path)).rejects.toThrow(/is the env var set/);
	});

	test("notion can be present but switched off without being valid", async () => {
		const path = await writeConfig("notion-off", {
			notion: { enabled: false },
		});
		expect((await loadConfig(path)).notion?.enabled).toBe(false);
	});
});

function fakeStats(ts: number, cpu: number) {
	return {
		hostname: "test",
		platform: "Linux",
		kernel: "test",
		uptimeSec: 100,
		loadavg: [0.5, 0.4, 0.3] as [number, number, number],
		cpu: { usage: cpu, cores: 4, perCore: [], model: null },
		mem: {
			total: 1000,
			used: 400,
			free: 600,
			available: 600,
			buffers: 0,
			cached: 0,
			swapTotal: 0,
			swapUsed: 0,
		},
		disks: [
			{
				filesystem: "/dev/sda1",
				mount: "/",
				total: 500,
				used: 250,
				available: 250,
				usage: 0.5,
			},
		],
		net: [{ name: "eth0", rxBytes: 10, txBytes: 20, rxRate: 5, txRate: 6 }],
		temps: [],
		timestamp: ts,
	};
}

describe("MetricStore", () => {
	test("records, reads back, and prunes", () => {
		const store = new MetricStore(":memory:");
		const now = Date.now();

		store.record("srv", fakeStats(now - 1000, 0.25));
		store.record("srv", fakeStats(now, 0.5));
		store.record("other", fakeStats(now, 0.9));

		const rows = store.history("srv", now - 60_000);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.cpu).toBe(0.25);
		expect(rows[1]!.ts).toBeGreaterThan(rows[0]!.ts);
		expect(rows[1]!.rxRate).toBe(5);
		expect(rows[1]!.diskTotal).toBe(500);
		expect(store.history("other", now - 60_000)).toHaveLength(1);

		store.record("srv", fakeStats(now - 48 * 3600_000, 0.1));
		expect(store.history("srv", 0)).toHaveLength(3);
		store.prune(24);
		expect(store.history("srv", 0)).toHaveLength(2);

		store.close();
	});

	test("remembers nodes so they survive a hub restart", () => {
		const store = new MetricStore(":memory:");
		store.seen({
			id: "web-1",
			name: "Web 1",
			version: "0.2.0",
			hostname: "web1.lan",
		});
		store.seen({
			id: "web-1",
			name: "Web 1",
			version: "0.2.1",
			hostname: "web1.lan",
		});

		const known = store.knownNodes();
		expect(known).toHaveLength(1);
		expect(known[0]).toMatchObject({ id: "web-1", version: "0.2.1" });

		store.record("web-1", fakeStats(Date.now(), 0.2));
		store.forget("web-1");
		expect(store.knownNodes()).toEqual([]);
		expect(store.history("web-1", 0)).toEqual([]);

		store.close();
	});

	test("events round-trip newest first and filter by node", () => {
		const store = new MetricStore(":memory:");
		store.recordEvent("a", "offline", "went away");
		store.recordEvent("a", "online", "came back");
		store.recordEvent("b", "online", "hello");

		const events = store.events(0);
		expect(events).toHaveLength(3);
		expect(events[0]!.nodeId).toBe("b");
		expect(store.events(0, 200, "a")).toHaveLength(2);

		store.close();
	});
});

describe("alerts", () => {
	const telemetry = (overrides: Partial<Telemetry>): Telemetry =>
		({
			node: { id: "n", name: "n", version: "0", protocol: 2 },
			seq: 1,
			stats: fakeStats(Date.now(), 0.1),
			facts: {} as never,
			systemd: {
				available: true,
				version: null,
				state: "running",
				total: 1,
				active: 1,
				failed: [],
			},
			containers: [],
			processes: [],
			units: [],
			ports: [],
			projects: [],
			errors: {},
			...overrides,
		}) as Telemetry;

	const project = (state: string, health = "healthy") => ({
		id: "p",
		name: "Proj",
		description: null,
		tags: [],
		url: null,
		enabled: true,
		watch: { systemd: [], containers: [], ports: [], paths: [] },
		summary: "running" as const,
		processes: [
			{
				id: "web",
				name: "web",
				projectId: "p",
				state,
				health,
				healthDetail: null,
				pid: 1,
				startedAt: 1,
				uptimeSec: 1,
				restarts: 0,
				lastExitCode: 1,
				lastExitSignal: null,
				lastExitAt: null,
				error: null,
				cpu: 0,
				rssBytes: 0,
				command: "x",
				autostart: true,
				restartPolicy: "always" as const,
			},
		],
	});

	test("the first frame never alerts", () => {
		expect(diffAlerts(null, telemetry({}))).toEqual([]);
	});

	test("a newly failed unit alerts once", () => {
		const before = telemetry({});
		const after = telemetry({
			systemd: {
				available: true,
				version: null,
				state: "degraded",
				total: 1,
				active: 0,
				failed: ["nginx.service"],
			},
		});

		expect(diffAlerts(before, after)).toEqual([
			{ kind: "unit-failed", message: "nginx.service failed" },
		]);
		// Still failed on the next frame — no second alert.
		expect(diffAlerts(after, after)).toEqual([]);
	});

	test("a process crashing, going unhealthy and recovering each alert", () => {
		const running = telemetry({ projects: [project("running")] as never });
		const crashed = telemetry({ projects: [project("crashed")] as never });
		const unhealthy = telemetry({
			projects: [project("running", "unhealthy")] as never,
		});

		expect(diffAlerts(running, crashed)[0]).toMatchObject({
			kind: "process-down",
		});
		expect(diffAlerts(running, unhealthy)[0]).toMatchObject({
			kind: "process-unhealthy",
		});
		expect(diffAlerts(crashed, running)[0]).toMatchObject({
			kind: "process-recovered",
		});
	});
});

/* ---------- end to end: a real node against a real hub ---------- */

interface Harness {
	hub: ReturnType<typeof startHub>;
	port: number;
	dir: string;
	stop: () => Promise<void>;
}

async function harness(
	overrides: Partial<HubConfig> = {},
	projects?: unknown,
): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "stats-hub-"));
	paths.push(dir);
	if (projects)
		await Bun.write(join(dir, "projects.json"), JSON.stringify(projects));

	const config: HubConfig = {
		port: 0,
		host: "127.0.0.1",
		token: null,
		nodeToken: null,
		allowUnknownNodes: true,
		dbPath: ":memory:",
		retentionHours: 24,
		telemetryIntervalMs: 1000,
		nodeTimeoutMs: 15_000,
		modules: resolveModules({}),
		embeddedNode: false,
		nodes: [],
		notion: null,
		...overrides,
	};

	const hub = startHub(config);
	return {
		hub,
		port: hub.server.port!,
		dir,
		stop: async () => {
			hub.registry.stop();
			await Bun.sleep(50);
			hub.store.close();
			// Bun 1.3: once the server has closed a WebSocket itself — which
			// registry.stop() just did — `stop(true)` never resolves. The port is
			// released regardless, and each harness binds port 0, so don't wait
			// forever on it.
			await Promise.race([hub.server.stop(true), Bun.sleep(250)]);
		},
	};
}

/** A browser link, over a real WebSocket, exactly like the dashboard's. */
async function browser(port: number, token?: string): Promise<PeerLink> {
	const qs = token ? `?token=${token}` : "";
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${qs}`);
	ws.binaryType = "arraybuffer";
	const link = new PeerLink(
		{
			send: (data) => ws.send(data),
			close: (code, reason) => ws.close(code, reason),
		},
		{ parity: "even", name: "test-browser", onError: () => {} },
	);
	ws.onmessage = (event) => link.receive(event.data as ArrayBuffer);
	ws.onclose = () => link.dispose("closed");
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("browser socket failed"));
	});
	return link;
}

async function eventually<T>(
	get: () => Promise<T> | T,
	ok: (value: T) => boolean,
	ms = 8000,
) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = await get();
		if (ok(value)) return value;
		await Bun.sleep(50);
	}
	throw new Error("condition was never met");
}

describe("hub and node over a websocket", () => {
	test("a node registers, streams telemetry and answers relayed control", async () => {
		const h = await harness(
			{},
			{
				projects: [
					{
						id: "demo",
						processes: [
							{ id: "sleeper", command: ["sleep", "60"], restart: "never" },
						],
					},
				],
			},
		);
		const node = startNode({
			hubUrl: `ws://127.0.0.1:${h.port}/node`,
			token: null,
			id: "test-node",
			name: "Test Node",
			tags: [],
			telemetryIntervalMs: 1000,
			modules: resolveModules({ terminal: true }),
			trustedModules: [...BUILTIN_MODULE_IDS],
			control: true,
			projectPaths: [join(h.dir, "projects.json")],
		});

		let ui: PeerLink | null = null;
		try {
			await node.connected;
			ui = await browser(h.port);

			// The node shows up online with its host facts filled in.
			const nodes = await eventually(
				() => ui!.request<NodeSummary[]>(HubAction.Nodes),
				(list) =>
					list.length === 1 &&
					list[0]!.status === "online" &&
					list[0]!.cpu !== null,
			);
			const summary = nodes[0]!;
			expect(summary.id).toBe("test-node");
			expect(summary.name).toBe("Test Node");
			expect(summary.facts?.osPretty ?? summary.facts?.osName).toBeTruthy();
			expect(moduleOn(summary.capabilities?.modules, "terminal")).toBe(true);
			expect(summary.mem!.total).toBeGreaterThan(0);

			// A relayed request reaches the node and its answer comes back.
			const snapshot = await ui.request<{
				stats: { hostname: string };
				projects: unknown[];
			}>(NodeAction.Snapshot, { nodeId: "test-node" });
			expect(snapshot.stats.hostname).toBeTruthy();
			expect(snapshot.projects).toHaveLength(1);

			// History accumulated from the telemetry the hub has been storing.
			const history = await eventually(
				() =>
					ui!.request<unknown[]>(HubAction.History, {
						nodeId: "test-node",
						minutes: 5,
					}),
				(rows) => rows.length > 0,
			);
			expect(history.length).toBeGreaterThan(0);

			// Project control travels hub → node and takes effect.
			const stopped = await ui.request<{
				ok: boolean;
				projects: { processes: { state: string }[] }[];
			}>(NodeAction.ProjectAction, {
				nodeId: "test-node",
				projectId: "demo",
				processId: "sleeper",
				verb: "stop",
			});
			expect(stopped.ok).toBe(true);
			expect(stopped.projects[0]!.processes[0]!.state).toBe("stopped");
		} finally {
			ui?.close();
			await node.stop();
			await h.stop();
		}
	}, 30_000);

	test("browsers are pushed telemetry and status as it happens", async () => {
		const h = await harness();
		const ui = await browser(h.port);

		const pushes: { event: string; nodeId?: string }[] = [];
		ui.on(MessageType.Telemetry, (frame) => {
			pushes.push(JSON.parse(new TextDecoder().decode(frame.payload)));
		});

		const node = startNode({
			hubUrl: `ws://127.0.0.1:${h.port}/node`,
			token: null,
			id: "pushy",
			name: "Pushy",
			tags: [],
			telemetryIntervalMs: 1000,
			modules: resolveModules({ terminal: false }),
			trustedModules: [...BUILTIN_MODULE_IDS],
			control: false,
			projectPaths: [join(h.dir, "nothing.json")],
		});

		try {
			await node.connected;
			await eventually(
				() => pushes,
				(list) =>
					list.some((p) => p.event === "status" && p.nodeId === "pushy") &&
					list.some((p) => p.event === "telemetry" && p.nodeId === "pushy"),
			);

			await node.stop();
			// Losing the socket flips the node offline for every watching browser.
			await eventually(
				() => ui.request<NodeSummary[]>(HubAction.Nodes),
				(list) => list[0]?.status === "offline",
			);
		} finally {
			ui.close();
			await node.stop();
			await h.stop();
		}
	}, 30_000);

	test("nothing pushed to a browser is gzipped", async () => {
		// The dashboard runs in a browser, which has no sync gunzip: a compressed
		// frame is one it drops on the floor. PeerLink would inflate it here and
		// hide that, so this reads the header off the raw socket instead.
		const h = await harness();
		const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
		ws.binaryType = "arraybuffer";
		const frames: { type: number; compressed: boolean; bytes: number }[] = [];
		ws.onmessage = (event) => {
			const raw = new Uint8Array(event.data as ArrayBuffer);
			const view = new DataView(raw.buffer);
			frames.push({
				type: view.getUint8(1),
				compressed: (view.getUint16(2, false) & Flags.COMPRESSED) !== 0,
				bytes: raw.length,
			});
		};
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error("browser socket failed"));
		});

		const node = startNode({
			hubUrl: `ws://127.0.0.1:${h.port}/node`,
			token: null,
			id: "plain",
			name: "Plain",
			tags: [],
			telemetryIntervalMs: 1000,
			modules: resolveModules({ terminal: false }),
			trustedModules: [...BUILTIN_MODULE_IDS],
			control: false,
			projectPaths: [join(h.dir, "nothing.json")],
		});

		try {
			await node.connected;
			// A whole-host telemetry push is tens of kilobytes — comfortably past
			// COMPRESS_THRESHOLD, so this only passes if the hub opted out.
			await eventually(
				() => frames,
				(list) =>
					list.some(
						(f) =>
							f.type === MessageType.Telemetry && f.bytes > COMPRESS_THRESHOLD,
					),
			);
			expect(frames.every((f) => !f.compressed)).toBe(true);
		} finally {
			ws.close();
			await node.stop();
			await h.stop();
		}
	}, 30_000);

	test("a terminal opens on the node and echoes what it is typed", async () => {
		const h = await harness();
		const node = startNode({
			hubUrl: `ws://127.0.0.1:${h.port}/node`,
			token: null,
			id: "shell-node",
			name: "Shell",
			tags: [],
			telemetryIntervalMs: 2000,
			modules: resolveModules({ terminal: true }),
			trustedModules: [...BUILTIN_MODULE_IDS],
			control: true,
			projectPaths: [join(h.dir, "nothing.json")],
		});

		let ui: PeerLink | null = null;
		try {
			await node.connected;
			ui = await browser(h.port);

			let output = "";
			const session = ui.openStream<{ sessionId: string; pid: number }>(
				NodeAction.TerminalOpen,
				{ nodeId: "shell-node", cols: 100, rows: 30, shell: "/bin/sh" },
				{
					onData: (payload, binary) => {
						if (binary) output += new TextDecoder().decode(payload);
					},
				},
			);

			const opened = await session.ready;
			expect(opened.sessionId).toBeTruthy();
			expect(opened.pid).toBeGreaterThan(0);

			// A real pty: the shell prints its marker and `tty` names a pts device.
			session.bytes(new TextEncoder().encode("echo READY-$((6*7)); tty\n"));
			await eventually(
				() => output,
				(text) => text.includes("READY-42") && text.includes("/dev/pts/"),
			);

			// Resizing reaches the pty, so curses apps lay out correctly.
			await ui.request(NodeAction.TerminalResize, {
				nodeId: "shell-node",
				sessionId: opened.sessionId,
				cols: 132,
				rows: 43,
			});
			output = "";
			// `stty size` reads the pty's ioctl rather than $COLUMNS, so it tells the
			// truth about whether the resize actually reached the kernel.
			session.bytes(new TextEncoder().encode("stty size\n"));
			await eventually(
				() => output,
				(text) => text.includes("43 132"),
			);

			session.end();
		} finally {
			ui?.close();
			await node.stop();
			await h.stop();
		}
	}, 30_000);

	test("a project's log tail streams through the hub to the browser", async () => {
		const h = await harness(
			{},
			{
				projects: [
					{
						id: "chatty",
						processes: [
							{
								id: "talker",
								command: [
									"sh",
									"-c",
									"for i in 1 2 3 4 5; do echo line-$i; sleep 0.2; done; sleep 30",
								],
								restart: "never",
							},
						],
					},
				],
			},
		);
		const node = startNode({
			hubUrl: `ws://127.0.0.1:${h.port}/node`,
			token: null,
			id: "log-node",
			name: "Logs",
			tags: [],
			telemetryIntervalMs: 2000,
			modules: resolveModules({ terminal: false }),
			trustedModules: [...BUILTIN_MODULE_IDS],
			control: true,
			projectPaths: [join(h.dir, "projects.json")],
		});

		let ui: PeerLink | null = null;
		try {
			await node.connected;
			ui = await browser(h.port);

			const lines: { message: string }[] = [];
			const stream = ui.openStream(
				NodeAction.LogsTail,
				{
					nodeId: "log-node",
					kind: "project",
					target: "chatty/talker",
					tail: 100,
					follow: true,
				},
				{
					onData: (payload, binary) => {
						if (!binary)
							lines.push(
								...(JSON.parse(new TextDecoder().decode(payload)) as {
									message: string;
								}[]),
							);
					},
				},
			);
			await stream.ready;

			// Both the buffered history and the lines that arrive while we watch.
			await eventually(
				() => lines,
				(all) =>
					all.some((l) => l.message === "line-1") &&
					all.some((l) => l.message === "line-5"),
			);
			// The supervisor annotates its own actions on the same stream.
			expect(lines.some((l) => l.message.startsWith("started:"))).toBe(true);
			stream.end();
		} finally {
			ui?.close();
			await node.stop();
			await h.stop();
		}
	}, 30_000);

	test("a node with terminals disabled refuses to open one", async () => {
		const h = await harness();
		const node = startNode({
			hubUrl: `ws://127.0.0.1:${h.port}/node`,
			token: null,
			id: "locked",
			name: "Locked",
			tags: [],
			telemetryIntervalMs: 2000,
			modules: resolveModules({ terminal: false }),
			trustedModules: [...BUILTIN_MODULE_IDS],
			control: false,
			projectPaths: [join(h.dir, "nothing.json")],
		});

		let ui: PeerLink | null = null;
		try {
			await node.connected;
			ui = await browser(h.port);

			expect(
				ui.request(NodeAction.TerminalOpen, {
					nodeId: "locked",
					cols: 80,
					rows: 24,
				}),
			).rejects.toThrow(/'terminal' module is not enabled/);

			expect(
				ui.request(NodeAction.ProjectAction, {
					nodeId: "locked",
					projectId: "x",
					verb: "start",
				}),
			).rejects.toThrow(/control actions are disabled/);
		} finally {
			ui?.close();
			await node.stop();
			await h.stop();
		}
	}, 30_000);

	test("a node refuses a hub-driven update unless it opted in", async () => {
		const h = await harness();
		const node = startNode({
			hubUrl: `ws://127.0.0.1:${h.port}/node`,
			token: null,
			id: "unwilling",
			name: "Unwilling",
			tags: [],
			telemetryIntervalMs: 2000,
			modules: resolveModules({ terminal: false }),
			trustedModules: [...BUILTIN_MODULE_IDS],
			control: true,
			// allowRemoteUpdate not set: the default has to be "no".
			projectPaths: [join(h.dir, "nothing.json")],
		});

		let ui: PeerLink | null = null;
		try {
			await node.connected;
			ui = await browser(h.port);

			// Control being on is not enough — replacing the binary is its own
			// decision, and one the node makes rather than the hub.
			expect(
				ui.request(NodeAction.UpdateApply, { nodeId: "unwilling" }),
			).rejects.toThrow(/does not accept remote updates/);
		} finally {
			ui?.close();
			await node.stop();
			await h.stop();
		}
	}, 30_000);

	test("the hub rejects a node with the wrong token", async () => {
		const h = await harness({ nodeToken: "correct-horse" });
		const rejections: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => rejections.push(args.join(" "));

		const node = startNode({
			hubUrl: `ws://127.0.0.1:${h.port}/node`,
			token: "wrong",
			id: "intruder",
			name: "Intruder",
			tags: [],
			telemetryIntervalMs: 1000,
			modules: resolveModules({ terminal: false }),
			trustedModules: [...BUILTIN_MODULE_IDS],
			control: false,
			projectPaths: [join(h.dir, "nothing.json")],
		});

		try {
			await eventually(
				() => rejections,
				(list) => list.some((line) => /unauthorized/.test(line)),
			);
			expect(h.hub.registry.list()).toHaveLength(0);
		} finally {
			console.error = originalError;
			await node.stop();
			await h.stop();
		}
	}, 30_000);

	test("browsers need the hub token when one is configured", async () => {
		const h = await harness({ token: "let-me-in" });
		try {
			const res = await fetch(`http://127.0.0.1:${h.port}/api/nodes`);
			expect(res.status).toBe(401);

			const authed = await fetch(`http://127.0.0.1:${h.port}/api/nodes`, {
				headers: { authorization: "Bearer let-me-in" },
			});
			expect(authed.status).toBe(200);

			// health stays open so a monitor can check the hub without a secret
			expect(
				(await fetch(`http://127.0.0.1:${h.port}/api/health`)).status,
			).toBe(200);

			const link = await browser(h.port, "let-me-in");
			expect(await link.request(HubAction.Info)).toMatchObject({
				modules: { terminal: true },
				nodes: 0,
			});
			link.close();
		} finally {
			await h.stop();
		}
	}, 20_000);

	test("a node running no modules at all is still a node", async () => {
		// The claim the module split rests on: hostname and addresses are the
		// core's, everything else is a module's, so a host whose platform has no
		// probe yet — or an operator who switched the lot off — still gets a node
		// in the fleet that the hub can see, name and manage.
		const h = await harness();
		const node = startNode({
			hubUrl: `ws://127.0.0.1:${h.port}/node`,
			token: null,
			id: "bare",
			name: "Bare",
			tags: [],
			telemetryIntervalMs: 1000,
			// Every builtin off, system included.
			modules: resolveModules(
				Object.fromEntries(BUILTIN_MODULE_IDS.map((id) => [id, false])),
			),
			trustedModules: [...BUILTIN_MODULE_IDS],
			control: true,
			projectPaths: [],
		});

		let ui: PeerLink | null = null;
		try {
			await node.connected;
			ui = await browser(h.port);

			const nodes = await eventually(
				() => ui!.request<NodeSummary[]>(HubAction.Nodes),
				(list) => list.length === 1 && list[0]!.status === "online",
			);
			const summary = nodes[0]!;

			// Present, online, named and located.
			expect(summary.id).toBe("bare");
			expect(summary.hostname).toBeTruthy();
			expect(summary.platform).toBe(process.platform);

			// And empty everywhere a module would have filled in, rather than zeroed.
			expect(summary.cpu).toBeNull();
			expect(summary.mem).toBeNull();
			expect(summary.facts).toBeNull();
			expect(summary.disks).toEqual([]);

			// A snapshot still answers; it just has a host and nothing else.
			const snapshot = await ui.request<{
				host: { hostname: string };
				stats?: unknown;
			}>(NodeAction.Snapshot, { nodeId: "bare" });
			expect(snapshot.host.hostname).toBeTruthy();
			expect(snapshot.stats).toBeUndefined();
		} finally {
			ui?.close();
			await node.stop();
			await h.stop();
		}
	}, 20_000);

	test("the hub records module intent and a node applies it on reconnect", async () => {
		const h = await harness();
		const node = startNode({
			hubUrl: `ws://127.0.0.1:${h.port}/node`,
			token: null,
			id: "managed",
			name: "Managed",
			tags: [],
			telemetryIntervalMs: 1000,
			modules: resolveModules({ terminal: true }),
			trustedModules: [...BUILTIN_MODULE_IDS],
			control: true,
			projectPaths: [],
			// The opt-in that lets the hub turn a module *on*. Narrowing works
			// without it; see src/hub/modules.ts for why the two differ.
			allowHubModules: true,
		});

		let ui: PeerLink | null = null;
		try {
			await node.connected;
			ui = await browser(h.port);
			await eventually(
				() => ui!.request<NodeSummary[]>(HubAction.Nodes),
				(list) => list.length === 1 && list[0]!.status === "online",
			);

			// The page's read: a row per module, reality and intent side by side.
			const fleet = await ui.request<{
				nodes: {
					nodeId: string;
					acceptsHubModules: boolean;
					modules: { id: string; state: string; desired: boolean | null }[];
				}[];
			}>(HubAction.Modules);
			expect(fleet.nodes).toHaveLength(1);
			expect(fleet.nodes[0]!.acceptsHubModules).toBe(true);
			const terminal = fleet.nodes[0]!.modules.find((m) => m.id === "terminal");
			expect(terminal?.state).toBe("on");
			expect(terminal?.desired).toBeNull();

			// Switching one off is recorded and pushed.
			const off = await ui.request<{
				applied: boolean;
				modules: { id: string; state: string }[];
			}>(HubAction.ModulesSet, {
				nodeId: "managed",
				modules: { terminal: false },
			});
			expect(off.applied).toBe(true);

			// The node reloads and reconnects, and announces the narrowed set.
			const after = await eventually(
				() => ui!.request<NodeSummary[]>(HubAction.Nodes),
				(list) =>
					moduleOn(list[0]?.capabilities?.modules, "terminal") === false,
			);
			expect(moduleOn(after[0]!.capabilities?.modules, "terminal")).toBe(false);

			// And the intent outlives the reconnect that applied it.
			const again = await ui.request<{
				nodes: {
					modules: { id: string; state: string; desired: boolean | null }[];
				}[];
			}>(HubAction.Modules);
			const row = again.nodes[0]!.modules.find((m) => m.id === "terminal");
			expect(row?.desired).toBe(false);
			expect(row?.state).toBe("off");
		} finally {
			ui?.close();
			await node.stop();
			await h.stop();
		}
	}, 30_000);

	test("a node that hasn't opted in refuses to have a module switched on", async () => {
		const h = await harness();
		const node = startNode({
			hubUrl: `ws://127.0.0.1:${h.port}/node`,
			token: null,
			id: "narrow",
			name: "Narrow",
			tags: [],
			telemetryIntervalMs: 1000,
			modules: resolveModules({ terminal: false }),
			trustedModules: [...BUILTIN_MODULE_IDS],
			control: true,
			projectPaths: [],
			// allowHubModules left off: the old rule, still in force.
		});

		let ui: PeerLink | null = null;
		try {
			await node.connected;
			ui = await browser(h.port);
			await eventually(
				() => ui!.request<NodeSummary[]>(HubAction.Nodes),
				(list) => list.length === 1 && list[0]!.status === "online",
			);

			const result = await ui.request<{
				applied: boolean;
				refused?: string;
				modules: { id: string; state: string }[];
			}>(HubAction.ModulesSet, {
				nodeId: "narrow",
				modules: { terminal: true },
			});

			expect(result.applied).toBe(false);
			expect(result.refused).toContain("--allow-hub-modules");
			// The ask is recorded and visible, but it is not a lie about what runs.
			expect(result.modules.find((m) => m.id === "terminal")?.state).toBe(
				"refused",
			);
		} finally {
			ui?.close();
			await node.stop();
			await h.stop();
		}
	}, 20_000);

	test("the hub serves the projects schema so a node's file can point at it", async () => {
		const h = await harness();
		try {
			const res = await fetch(
				`http://127.0.0.1:${h.port}/schema/projects.schema.json`,
			);
			expect(res.status).toBe(200);
			const schema = (await res.json()) as { $defs: Record<string, unknown> };
			expect(Object.keys(schema.$defs)).toContain("process");
		} finally {
			await h.stop();
		}
	});
});
