import { expect, test } from "bun:test";
import type { PeerLink } from "../proto/link.ts";
import type { NotionConfig, ProjectStatus } from "../types.ts";
import {
	humanUptime,
	NotionClient,
	NotionSync,
	toProperties,
	toRow,
} from "./notion.ts";
import type { NodeRecord, NodeRegistry } from "./registry.ts";

/* ---------- fixtures ---------- */

function project(over: Partial<ProjectStatus> = {}): ProjectStatus {
	return {
		id: "api",
		name: "API",
		description: null,
		tags: ["prod"],
		url: "https://example.com",
		enabled: true,
		watch: { systemd: [], containers: [], ports: [], paths: [] },
		summary: "running",
		processes: [
			{
				id: "web",
				name: "web",
				projectId: "api",
				state: "running",
				health: "healthy",
				healthDetail: null,
				pid: 10,
				startedAt: 0,
				uptimeSec: 90_000,
				restarts: 2,
				lastExitCode: null,
				lastExitSignal: null,
				lastExitAt: null,
				error: null,
				cpu: null,
			},
		] as ProjectStatus["processes"],
		...over,
	};
}

function node(over: Partial<NodeRecord> = {}): NodeRecord {
	return {
		id: "web-1",
		name: "Web 1",
		tags: [],
		notes: null,
		link: { closed: false } as unknown as PeerLink,
		capabilities: null,
		telemetry: { projects: [project()] } as NodeRecord["telemetry"],
		version: "0.2.2",
		protocol: 1,
		connectedAt: 0,
		lastSeen: 0,
		remoteAddress: null,
		...over,
	};
}

function registryOf(...nodes: NodeRecord[]): NodeRegistry {
	return { list: () => nodes } as unknown as NodeRegistry;
}

function config(over: Partial<NotionConfig> = {}): NotionConfig {
	return {
		enabled: true,
		token: "secret",
		database: "db-1",
		intervalMs: 60_000,
		archiveStale: false,
		...over,
	};
}

/** A fake Notion that records calls and answers from a scripted schema. */
function fakeNotion(
	options: { properties?: Record<string, { type: string }> } = {},
) {
	const calls: { method: string; path: string; body: unknown }[] = [];
	const pages = new Map<string, Record<string, unknown>>();
	let next = 0;

	const properties = options.properties ?? {
		Name: { type: "title" },
		Key: { type: "rich_text" },
		Node: { type: "rich_text" },
		Status: { type: "select" },
		Processes: { type: "rich_text" },
		Uptime: { type: "rich_text" },
		Restarts: { type: "number" },
		Tags: { type: "multi_select" },
		URL: { type: "url" },
		Updated: { type: "date" },
	};

	const impl = (async (url: string, init: RequestInit) => {
		const path = String(url).replace("https://api.notion.com/v1", "");
		const method = init.method ?? "GET";
		const body = init.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, path, body });

		const reply = (data: unknown) =>
			new Response(JSON.stringify(data), { status: 200 });

		if (method === "GET" && path.startsWith("/databases/"))
			return reply({ properties });

		if (method === "POST" && path.endsWith("/query")) {
			return reply({
				results: [...pages].map(([id, props]) => ({ id, properties: props })),
				has_more: false,
				next_cursor: null,
			});
		}

		if (method === "POST" && path === "/pages") {
			const id = `page-${next++}`;
			pages.set(id, storable(body.properties));
			return reply({ id });
		}

		if (method === "PATCH" && path.startsWith("/pages/")) {
			const id = path.slice("/pages/".length);
			if (body.archived) pages.delete(id);
			else pages.set(id, storable(body.properties));
			return reply({ id });
		}

		return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
	}) as unknown as typeof fetch;

	/** Turn a write payload back into the read shape the query endpoint returns. */
	function storable(
		props: Record<string, { rich_text?: { text: { content: string } }[] }>,
	) {
		const out: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(props ?? {})) {
			out[name] = value.rich_text
				? {
						rich_text: value.rich_text.map((t) => ({
							plain_text: t.text.content,
						})),
					}
				: value;
		}
		return out;
	}

	return { impl, calls, pages };
}

const client = (impl: typeof fetch) => new NotionClient("secret", impl, 0);

/* ---------- shaping ---------- */

test("humanUptime reads like the dashboard's cards", () => {
	expect(humanUptime(null)).toBe("—");
	expect(humanUptime(0)).toBe("—");
	expect(humanUptime(45)).toBe("45s");
	expect(humanUptime(90 * 60)).toBe("1h 30m");
	expect(humanUptime(4 * 86400 + 2 * 3600)).toBe("4d 2h");
});

test("a row keys on ids, not display names", () => {
	const row = toRow(node(), project({ name: "Renamed" }));
	expect(row.key).toBe("web-1/api");
	expect(row.title).toBe("Renamed");
	expect(row.processes).toBe("1/1 running");
	expect(row.restarts).toBe(2);
	expect(row.uptime).toBe("1d 1h");
});

test("projects on a disconnected node report offline, not their last state", () => {
	const offline = node({ link: null });
	expect(toRow(offline, project()).status).toBe("offline");

	const closed = node({ link: { closed: true } as unknown as PeerLink });
	expect(toRow(closed, project()).status).toBe("offline");
});

test("restarts sum across a project's processes", () => {
	const multi = project({
		processes: [
			{ ...project().processes[0]!, id: "a", restarts: 3, state: "running" },
			{ ...project().processes[0]!, id: "b", restarts: 4, state: "crashed" },
		],
	});
	const row = toRow(node(), multi);
	expect(row.restarts).toBe(7);
	expect(row.processes).toBe("1/2 running");
});

test("properties are only emitted for columns the database has", () => {
	const present = new Map([
		["key", "Key"],
		["status", "Status"],
	] as const);
	const props = toProperties(
		toRow(node(), project()),
		"Name",
		present as never,
	);

	expect(Object.keys(props).sort()).toEqual(["Key", "Name", "Status"]);
	expect(props.Restarts).toBeUndefined();
});

test("commas are stripped from multi_select tags", () => {
	const row = toRow(node(), project({ tags: ["a,b"] }));
	const props = toProperties(row, "Name", new Map([["tags", "Tags"]] as never));
	expect(props.Tags).toEqual({ multi_select: [{ name: "a b" }] });
});

/* ---------- sync ---------- */

test("first pass creates a page, second pass changes nothing", async () => {
	const notion = fakeNotion();
	const sync = new NotionSync(
		config(),
		registryOf(node()),
		client(notion.impl),
	);

	const first = await sync.syncOnce();
	expect(first.created).toBe(1);
	expect(first.errors).toEqual([]);
	expect(notion.pages.size).toBe(1);

	const second = await sync.syncOnce();
	expect(second.created).toBe(0);
	expect(second.updated).toBe(0);
	// The timestamp column alone must not count as a change.
	expect(second.skipped).toBe(1);
});

test("a changed project updates its existing row rather than duplicating it", async () => {
	const notion = fakeNotion();
	const nodes = [node()];
	const sync = new NotionSync(
		config(),
		registryOf(...nodes),
		client(notion.impl),
	);

	await sync.syncOnce();
	nodes[0]!.telemetry = {
		projects: [project({ summary: "degraded" })],
	} as NodeRecord["telemetry"];

	const report = await sync.syncOnce();
	expect(report.updated).toBe(1);
	expect(report.created).toBe(0);
	expect(notion.pages.size).toBe(1);
});

test("the schema is read once, not on every pass", async () => {
	const notion = fakeNotion();
	const sync = new NotionSync(
		config(),
		registryOf(node()),
		client(notion.impl),
	);

	await sync.syncOnce();
	await sync.syncOnce();

	const schemaReads = notion.calls.filter(
		(c) => c.method === "GET" && c.path.startsWith("/databases/"),
	);
	expect(schemaReads).toHaveLength(1);
});

test("a missing column is reported but the rest still syncs", async () => {
	const notion = fakeNotion({
		properties: {
			Name: { type: "title" },
			Key: { type: "rich_text" },
			Status: { type: "select" },
		},
	});
	const sync = new NotionSync(
		config(),
		registryOf(node()),
		client(notion.impl),
	);

	const report = await sync.syncOnce();
	expect(report.created).toBe(1);
	expect(report.errors.some((e) => e.includes("'Restarts'"))).toBe(true);

	const created = notion.calls.find((c) => c.path === "/pages")!;
	const props = (created.body as { properties: Record<string, unknown> })
		.properties;
	expect(Object.keys(props).sort()).toEqual(["Key", "Name", "Status"]);
});

test("a column of the wrong type is skipped, not written as garbage", async () => {
	const notion = fakeNotion({
		properties: {
			Name: { type: "title" },
			Key: { type: "rich_text" },
			Restarts: { type: "rich_text" }, // should be number
		},
	});
	const sync = new NotionSync(
		config(),
		registryOf(node()),
		client(notion.impl),
	);

	const report = await sync.syncOnce();
	expect(
		report.errors.some(
			(e) => e.includes("'Restarts'") && e.includes("expected number"),
		),
	).toBe(true);
});

test("without a Key column the sync says so rather than duplicating rows", async () => {
	const notion = fakeNotion({
		properties: { Name: { type: "title" }, Status: { type: "select" } },
	});
	const sync = new NotionSync(
		config(),
		registryOf(node()),
		client(notion.impl),
	);

	const report = await sync.syncOnce();
	expect(report.errors.some((e) => e.includes("duplicate rows"))).toBe(true);
});

test("archiveStale removes rows whose project is gone, and only then", async () => {
	const notion = fakeNotion();
	const nodes = [node()];

	const keep = new NotionSync(
		config(),
		registryOf(...nodes),
		client(notion.impl),
	);
	await keep.syncOnce();
	nodes[0]!.telemetry = { projects: [] } as unknown as NodeRecord["telemetry"];

	// Default: the row is left alone.
	expect((await keep.syncOnce()).archived).toBe(0);
	expect(notion.pages.size).toBe(1);

	const prune = new NotionSync(
		config({ archiveStale: true }),
		registryOf(...nodes),
		client(notion.impl),
	);
	expect((await prune.syncOnce()).archived).toBe(1);
	expect(notion.pages.size).toBe(0);
});

test("a page that fails does not stop the others", async () => {
	const notion = fakeNotion();
	let calls = 0;
	const flaky = (async (url: string, init: RequestInit) => {
		if (
			String(url).endsWith("/pages") &&
			init.method === "POST" &&
			calls++ === 0
		)
			return new Response(JSON.stringify({ code: "validation_error" }), {
				status: 400,
			});
		return notion.impl(url as never, init as never);
	}) as unknown as typeof fetch;

	const two = registryOf(node(), node({ id: "web-2", name: "Web 2" }));
	const sync = new NotionSync(config(), two, client(flaky));

	const report = await sync.syncOnce();
	expect(report.created).toBe(1);
	expect(report.errors).toHaveLength(1);
	expect(report.errors[0]).toContain("web-1/api");
});

test("rows from every node land in one database", async () => {
	const notion = fakeNotion();
	const sync = new NotionSync(
		config(),
		registryOf(node(), node({ id: "db-1", name: "Database" })),
		client(notion.impl),
	);

	expect((await sync.syncOnce()).created).toBe(2);
	expect(notion.pages.size).toBe(2);
});

/* ---------- client ---------- */

test("429 is retried after the interval Notion asks for", async () => {
	let attempts = 0;
	const impl = (async () => {
		attempts++;
		if (attempts === 1)
			return new Response("{}", {
				status: 429,
				headers: { "retry-after": "0" },
			});
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await client(impl).request<{ ok: boolean }>("GET", "/x");
	expect(result.ok).toBe(true);
	expect(attempts).toBe(2);
});

test("a 400 is surfaced with Notion's own message, not retried", async () => {
	let attempts = 0;
	const impl = (async () => {
		attempts++;
		return new Response(
			JSON.stringify({ code: "validation_error", message: "Tags is expected" }),
			{ status: 400 },
		);
	}) as unknown as typeof fetch;

	expect(client(impl).request("POST", "/pages", {})).rejects.toThrow(
		"Tags is expected",
	);
	await Bun.sleep(10);
	expect(attempts).toBe(1);
});

test("the token never appears in a thrown error", async () => {
	const impl = (async () =>
		new Response(
			JSON.stringify({ code: "unauthorized", message: "bad token" }),
			{
				status: 401,
			},
		)) as unknown as typeof fetch;

	try {
		await client(impl).request("GET", "/databases/x");
		throw new Error("should have thrown");
	} catch (err) {
		expect(String(err)).not.toContain("secret");
	}
});
