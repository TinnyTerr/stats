import type { NotionConfig, ProjectStatus } from "../types.ts";
import type { NodeRecord, NodeRegistry } from "./registry.ts";

/**
 * Mirrors the fleet's projects into a Notion database.
 *
 * The direction is deliberate. A node's `projects.json` is the source of truth
 * — `schema/projects.schema.json` documents it and `src/agent/projects.ts`
 * enforces it — and the hub can only ever narrow what a node reports, never
 * widen it. So Notion is a read-only mirror: one row per (node, project),
 * upserted on a timer. Nothing here can change what a node runs.
 *
 * It is also outbound-only, which is what makes it work over Tailscale at all:
 * the hub dials api.notion.com, and Notion never needs a route back. It has
 * none — a 100.x tailnet address is not reachable from Notion's servers, so
 * any Notion-side automation pointed at the hub would simply time out.
 *
 * Like the collectors, this degrades rather than throwing the sync away: a
 * database missing the `Restarts` property still gets every other column, and
 * the problem is reported once rather than on every tick.
 */

const API = "https://api.notion.com/v1";

/**
 * Pinned rather than tracking latest. Notion's 2025-09-03 version moved
 * querying from databases onto data sources; 2022-06-28 keeps `database_id`
 * addressing, which is what `notion.database` in hub.json is.
 */
const NOTION_VERSION = "2022-06-28";

/** Notion's documented average is 3 requests/second. Stay under it. */
const MIN_REQUEST_GAP_MS = 350;

/** Notion rejects title and rich_text values longer than this. */
const TEXT_LIMIT = 2000;

/** The columns we write, and the Notion property type each one needs. */
const COLUMNS = {
	key: "rich_text",
	node: "rich_text",
	status: "select",
	processes: "rich_text",
	uptime: "rich_text",
	restarts: "number",
	tags: "multi_select",
	url: "url",
	updated: "date",
} as const;

export type Column = keyof typeof COLUMNS;

/** Default Notion property name per column; remappable via `notion.properties`. */
export const DEFAULT_NAMES: Record<Column, string> = {
	key: "Key",
	node: "Node",
	status: "Status",
	processes: "Processes",
	uptime: "Uptime",
	restarts: "Restarts",
	tags: "Tags",
	url: "URL",
	updated: "Updated",
};

interface NotionPage {
	id: string;
	properties?: Record<string, PropertyValue>;
}

interface PropertyValue {
	type?: string;
	rich_text?: { plain_text?: string }[];
}

interface QueryResponse {
	results?: NotionPage[];
	has_more?: boolean;
	next_cursor?: string | null;
}

interface DatabaseResponse {
	properties?: Record<string, { type?: string }>;
}

/** A project as it will appear in Notion, before it becomes properties. */
export interface Row {
	key: string;
	title: string;
	node: string;
	status: string;
	processes: string;
	uptime: string;
	restarts: number;
	tags: string[];
	url: string | null;
}

export class NotionError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** Minimal Notion REST client: auth, versioning, pacing and 429 retries. */
export class NotionClient {
	private nextSlot = 0;

	constructor(
		private token: string,
		private fetchImpl: typeof fetch = fetch,
		private gapMs = MIN_REQUEST_GAP_MS,
	) {}

	/** Serialises requests with a floor on the gap between them. */
	private async pace() {
		const now = Date.now();
		const wait = Math.max(0, this.nextSlot - now);
		this.nextSlot = Math.max(now, this.nextSlot) + this.gapMs;
		if (wait > 0) await Bun.sleep(wait);
	}

	async request<T>(
		method: string,
		path: string,
		body?: unknown,
		attempt = 0,
	): Promise<T> {
		await this.pace();

		const response = await this.fetchImpl(`${API}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Notion-Version": NOTION_VERSION,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});

		// Rate limits and transient upstream failures are worth retrying; a 400
		// from a malformed property never is.
		if ((response.status === 429 || response.status >= 500) && attempt < 3) {
			const header = Number(response.headers.get("retry-after"));
			const delay =
				Number.isFinite(header) && header > 0
					? header * 1000
					: 2 ** attempt * 1000;
			await Bun.sleep(delay);
			return this.request<T>(method, path, body, attempt + 1);
		}

		if (!response.ok) {
			const detail = (await response.json().catch(() => ({}))) as {
				code?: string;
				message?: string;
			};
			throw new NotionError(
				response.status,
				detail.code ?? "unknown",
				detail.message ?? `${method} ${path} failed with ${response.status}`,
			);
		}

		return (await response.json()) as T;
	}
}

/* ---------- shaping ---------- */

function clamp(text: string): string {
	return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;
}

/** "4d 2h", "31m", "—" — the same register as the dashboard's cards. */
export function humanUptime(seconds: number | null): string {
	if (seconds === null || seconds <= 0) return "—";
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d) return `${d}d ${h}h`;
	if (h) return `${h}h ${m}m`;
	if (m) return `${m}m`;
	return `${Math.floor(seconds)}s`;
}

/**
 * One row per (node, project). The key is what makes the upsert idempotent,
 * and it is derived from ids rather than names so renaming a project's display
 * name updates the row instead of orphaning it.
 */
export function toRow(node: NodeRecord, project: ProjectStatus): Row {
	const processes = project.processes;
	const running = processes.filter((p) => p.state === "running").length;
	const uptimes = processes
		.map((p) => p.uptimeSec)
		.filter((s): s is number => typeof s === "number");

	return {
		key: `${node.id}/${project.id}`,
		title: project.name || project.id,
		node: node.name || node.id,
		// A project on a node we've lost contact with isn't "running" any more,
		// whatever the last telemetry said.
		status: node.link && !node.link.closed ? project.summary : "offline",
		processes: processes.length
			? `${running}/${processes.length} running`
			: "—",
		uptime: humanUptime(uptimes.length ? Math.max(...uptimes) : null),
		restarts: processes.reduce((sum, p) => sum + p.restarts, 0),
		tags: project.tags,
		url: project.url,
	};
}

function text(value: string) {
	return { rich_text: [{ text: { content: clamp(value) } }] };
}

/** Builds the Notion property payload, skipping columns the database lacks. */
export function toProperties(
	row: Row,
	titleProperty: string,
	present: Map<Column, string>,
	now = Date.now(),
): Record<string, unknown> {
	const properties: Record<string, unknown> = {
		[titleProperty]: { title: [{ text: { content: clamp(row.title) } }] },
	};

	const values: Record<Column, unknown> = {
		key: text(row.key),
		node: text(row.node),
		status: { select: { name: row.status } },
		processes: text(row.processes),
		uptime: text(row.uptime),
		restarts: { number: row.restarts },
		// Notion rejects multi_select options containing a comma.
		tags: {
			multi_select: row.tags.map((t) => ({ name: t.replace(/,/g, " ") })),
		},
		url: { url: row.url || null },
		updated: { date: { start: new Date(now).toISOString() } },
	};

	for (const [column, name] of present) properties[name] = values[column];
	return properties;
}

/* ---------- sync ---------- */

export interface SyncReport {
	created: number;
	updated: number;
	skipped: number;
	archived: number;
	errors: string[];
}

export class NotionSync {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	/** column -> actual property name, for the columns this database has */
	private present = new Map<Column, string>();
	private titleProperty: string | null = null;
	/** key -> fingerprint of what we last wrote, so unchanged rows cost nothing */
	private lastWritten = new Map<string, string>();
	/** problems already logged, so a misconfigured database isn't a log flood */
	private reported = new Set<string>();

	constructor(
		private config: NotionConfig,
		private registry: NodeRegistry,
		private client: NotionClient,
		private log: (message: string) => void = console.warn,
	) {}

	start() {
		if (this.timer) return;
		// Kick off immediately so a misconfigured token is visible at boot rather
		// than one interval later.
		void this.tick();
		this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
		// Never hold the process open on account of a mirror.
		this.timer.unref?.();
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	private once(key: string, message: string) {
		if (this.reported.has(key)) return;
		this.reported.add(key);
		this.log(message);
	}

	private async tick() {
		// A slow sync must not overlap the next tick and double-write rows.
		if (this.running) return;
		this.running = true;
		try {
			const report = await this.syncOnce();
			for (const error of report.errors) this.once(error, `notion: ${error}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.once(`tick:${message}`, `notion: sync failed — ${message}`);
		} finally {
			this.running = false;
		}
	}

	/**
	 * Reads the database schema once, then upserts a row per project. Exposed so
	 * tests can drive a single pass without a timer.
	 */
	async syncOnce(): Promise<SyncReport> {
		const report: SyncReport = {
			created: 0,
			updated: 0,
			skipped: 0,
			archived: 0,
			errors: [],
		};

		if (!this.titleProperty) await this.loadSchema(report);
		if (!this.titleProperty) return report;

		const rows = this.rows();
		// Re-read the index every pass so rows deleted in Notion come back rather
		// than silently going missing until the hub restarts.
		const index = await this.loadIndex();

		for (const row of rows) {
			const properties = toProperties(row, this.titleProperty, this.present);
			const pageId = index.get(row.key);

			// The timestamp changes every pass, so a row whose real content is
			// unchanged would otherwise cost a write per tick forever.
			const { [this.present.get("updated") ?? ""]: _stamp, ...rest } =
				properties;
			const stable = JSON.stringify(rest);
			if (pageId && this.lastWritten.get(row.key) === stable) {
				report.skipped++;
				continue;
			}

			try {
				if (pageId) {
					await this.client.request("PATCH", `/pages/${pageId}`, {
						properties,
					});
					report.updated++;
				} else {
					await this.client.request("POST", "/pages", {
						parent: { database_id: this.config.database },
						properties,
					});
					report.created++;
				}
				this.lastWritten.set(row.key, stable);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				report.errors.push(`${row.key}: ${message}`);
			}
		}

		if (this.config.archiveStale) {
			const live = new Set(rows.map((r) => r.key));
			for (const [key, pageId] of index) {
				if (live.has(key)) continue;
				try {
					await this.client.request("PATCH", `/pages/${pageId}`, {
						archived: true,
					});
					this.lastWritten.delete(key);
					report.archived++;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					report.errors.push(`archive ${key}: ${message}`);
				}
			}
		}

		return report;
	}

	/** Every project the fleet currently reports, flattened across nodes. */
	private rows(): Row[] {
		return this.registry
			.list()
			.flatMap((node) =>
				(node.telemetry?.projects ?? []).map((project) => toRow(node, project)),
			);
	}

	/**
	 * Learns which of our columns the database actually has. A missing column is
	 * reported and then skipped forever after — writing to a property Notion
	 * doesn't know about is a 400 that would fail the whole page.
	 */
	private async loadSchema(report: SyncReport) {
		const database = await this.client.request<DatabaseResponse>(
			"GET",
			`/databases/${this.config.database}`,
		);
		const properties = database.properties ?? {};

		for (const [name, definition] of Object.entries(properties)) {
			if (definition.type === "title") this.titleProperty = name;
		}
		if (!this.titleProperty) {
			report.errors.push(
				`database ${this.config.database} has no title property`,
			);
			return;
		}

		for (const column of Object.keys(COLUMNS) as Column[]) {
			const name = this.config.properties?.[column] ?? DEFAULT_NAMES[column];
			const definition = properties[name];
			if (!definition) {
				report.errors.push(
					`property '${name}' not in the database — skipping the ${column} column`,
				);
				continue;
			}
			if (definition.type !== COLUMNS[column]) {
				report.errors.push(
					`property '${name}' is ${definition.type}, expected ${COLUMNS[column]} — skipping the ${column} column`,
				);
				continue;
			}
			this.present.set(column, name);
		}

		if (!this.present.has("key")) {
			report.errors.push(
				"without a Key property every sync creates duplicate rows; add a rich_text 'Key' column",
			);
		}
	}

	/** key -> page id for every existing row, following Notion's pagination. */
	private async loadIndex(): Promise<Map<string, string>> {
		const index = new Map<string, string>();
		const keyProperty = this.present.get("key");
		if (!keyProperty) return index;

		let cursor: string | undefined;
		do {
			const page = await this.client.request<QueryResponse>(
				"POST",
				`/databases/${this.config.database}/query`,
				{ page_size: 100, start_cursor: cursor },
			);
			for (const result of page.results ?? []) {
				const value = result.properties?.[keyProperty];
				const key = value?.rich_text?.[0]?.plain_text;
				if (key) index.set(key, result.id);
			}
			cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
		} while (cursor);

		return index;
	}
}

/** Wires a sync onto a running hub, or returns null when it isn't configured. */
export function startNotionSync(
	config: NotionConfig | null,
	registry: NodeRegistry,
): NotionSync | null {
	if (!config?.enabled || !config.token || !config.database) return null;
	const sync = new NotionSync(config, registry, new NotionClient(config.token));
	sync.start();
	return sync;
}
