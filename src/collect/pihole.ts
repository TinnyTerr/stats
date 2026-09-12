import { isRoot } from "../modules/host.ts";
import type { CommandResult } from "../proto/messages.ts";
import type { PiholeDetail, PiholeEntry, PiholeSummary } from "../types.ts";

/**
 * Pi-hole, over whichever of its two APIs the install actually has.
 *
 * v6 replaced `admin/api.php` with a session-authenticated REST API and both
 * are still in the field, so the version is detected once per node and
 * everything below is written against the shaped result rather than against
 * either API.
 *
 * v6 also brought the local shortcut Proxmox has in `pvesh`: `pihole api
 * <endpoint>` is the same REST API, reached over the loopback and authenticated
 * out of a file only root can read. A root node on the Pi-hole itself therefore
 * needs no URL and no password — see {@link piholeCli} — and everywhere else
 * this is still made of HTTP calls, which is why the module stays portable.
 *
 * Nothing here is on by accident — the CLI or PIHOLE_URL is what turns the
 * module on, and a host with neither drops the module rather than reporting an
 * empty Pi-hole.
 */

/** Where the Pi-hole is. A bare host is assumed to be plain HTTP, as it is. */
export function piholeUrl(): string | null {
	const raw = process.env.PIHOLE_URL?.trim();
	if (!raw) return null;
	const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
	return url.replace(/\/+$/, "");
}

/** v6's app password, from Settings → Web interface & API. */
export function piholePassword(): string | null {
	return process.env.PIHOLE_PASSWORD?.trim() || null;
}

/** v5's API token — the `WEBPASSWORD` hash from setupVars.conf. */
export function piholeToken(): string | null {
	return process.env.PIHOLE_TOKEN?.trim() || null;
}

/**
 * Whether this node can drive the Pi-hole it is running on.
 *
 * `pihole api <endpoint>` authenticates out of /etc/pihole/cli_pw, which FTL
 * writes for root and the pihole group, so the shortcut is exactly as available
 * as that file is readable: root on a machine with the command installed asks
 * for nothing and gets everything, and anyone else is back to HTTP. Asking
 * about the uid rather than trying it is what keeps a non-root node off a code
 * path whose failure mode is the CLI prompting for a password it will never be
 * given.
 *
 * It wins over PIHOLE_URL when both are there, the way `pvesh` does: the host
 * is the better authority on itself. PIHOLE_CLI=0 is for the Pi-hole that is
 * meant to be watching a *different* Pi-hole.
 */
export function piholeCli(): boolean {
	if (/^(0|false|no|off)$/i.test(process.env.PIHOLE_CLI ?? "")) return false;
	return isRoot() && Bun.which("pihole") !== null;
}

export class PiholeUnavailable extends Error {}

/**
 * A Pi-hole is one small machine answering a DNS query every few milliseconds;
 * a dashboard that hangs waiting for it would cost the node its whole tick, so
 * every request here gives up rather than blocking the frame.
 */
const TIMEOUT_MS = 5_000;

/**
 * The CLI's own budget, which is a looser thing: one `pihole api` is a dig for
 * the API's port, a login, the request and a logout, each its own curl. It is
 * still bounded, because the process is killed at the end of it — a Pi-hole
 * that has stopped answering must cost this node a collection error rather than
 * a tick that never finishes.
 */
export const CLI_TIMEOUT_MS = 10_000;

/**
 * The leaderboards cost one request each and change on the scale of minutes,
 * not of a telemetry tick. Only the summary and the blocking state are asked
 * for every frame; everything else is served from here in between.
 */
const DETAIL_INTERVAL_MS = 30_000;

export interface ExecLike {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * The two things this collector reaches for. The module hands in the gated
 * versions from its {@link ModuleHost}; passing null restores the direct ones,
 * which is what the tests use.
 */
export interface PiholeTransport {
	fetch(url: string, init?: RequestInit): Promise<Response>;
	exec(argv: string[]): Promise<ExecLike>;
}

const directTransport: PiholeTransport = {
	fetch: (url, init) => fetch(url, init),
	async exec(argv) {
		const proc = Bun.spawn(argv, {
			stdout: "pipe",
			stderr: "pipe",
			timeout: CLI_TIMEOUT_MS,
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	},
};

let transport = directTransport;

/**
 * A caller replaces as much of the transport as it has an opinion about: a test
 * with a fake Pi-hole over HTTP has nothing to say about `exec`, and gets the
 * direct one it will never reach.
 */
export function usePiholeTransport(next: Partial<PiholeTransport> | null) {
	transport = next ? { ...directTransport, ...next } : directTransport;
}

/** The two HTTP APIs a Pi-hole might be answering with. */
export type PiholeApi = "v6" | "v5";

/**
 * Where and how to reach one Pi-hole, once both have been worked out. `cli` is
 * v6's API too — it just has nowhere to point, because it is this machine.
 */
export type PiholeEndpoint = { api: "cli" } | { api: PiholeApi; base: string };

/** What the caches key on: two endpoints are the same Pi-hole, or they aren't. */
function endpointKey(endpoint: PiholeEndpoint): string {
	return endpoint.api === "cli" ? "cli" : endpoint.base;
}

function reason(err: unknown): string {
	if (err instanceof Error)
		return err.name === "TimeoutError"
			? `no answer in ${TIMEOUT_MS}ms`
			: err.message;
	return String(err);
}

/** Every HTTP call in this file, with the timeout and the failure wording. */
async function request(url: string, init?: RequestInit): Promise<Response> {
	try {
		return await transport.fetch(url, {
			...init,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new PiholeUnavailable(`${url} unreachable: ${reason(err)}`);
	}
}

/* ---------- which API is this ---------- */

/**
 * v6 answers `/api/info/version` whether or not the caller has a session — a
 * 401 is still a v6 saying hello — and v5 has no `/api` at all. v5 is then
 * confirmed rather than assumed, so pointing the module at some other web
 * server says "not a Pi-hole" instead of failing later with a parse error.
 */
export async function detectApi(base: string): Promise<PiholeApi | null> {
	const six = await request(`${base}/api/info/version`);
	if (six.status === 401) {
		// Drain it: an undrained body keeps the connection out of the pool.
		await six.text().catch(() => "");
		return "v6";
	}
	// A 200 is only v6 if it answers like v6. Plenty of web servers answer 200
	// to anything, and one of them being mistaken for a Pi-hole would surface a
	// page later as a parse error rather than as "that isn't a Pi-hole".
	const body = six.ok ? await six.json().catch(() => null) : null;
	if (body && typeof body === "object" && "version" in body) return "v6";
	if (!six.ok) await six.text().catch(() => "");

	const five = await request(`${base}/admin/api.php?status`);
	if (!five.ok) return null;
	const status = await five.json().catch(() => null);
	return status && typeof status === "object" && "status" in status
		? "v5"
		: null;
}

let endpointCache: PiholeEndpoint | null = null;

/**
 * How this node will talk to its Pi-hole, or null when it has none to talk to.
 * The detection is done once and then held, but only for as long as the answer
 * to it hasn't changed: a PIHOLE_URL edited under a running node is a different
 * Pi-hole rather than a stale cache.
 */
export async function piholeEndpoint(): Promise<PiholeEndpoint | null> {
	const cli = piholeCli();
	if (endpointCache) {
		const stale =
			endpointCache.api === "cli"
				? !cli
				: cli || endpointCache.base !== piholeUrl();
		if (!stale) return endpointCache;
		resetPiholeCache();
	}
	if (cli) {
		endpointCache = { api: "cli" };
		return endpointCache;
	}

	const base = piholeUrl();
	if (!base) return null;

	const api = await detectApi(base);
	if (!api) {
		throw new PiholeUnavailable(
			`${base} answered, but not like a Pi-hole — check PIHOLE_URL points at the web interface`,
		);
	}
	endpointCache = { base, api };
	return endpointCache;
}

/** Whether the node has a Pi-hole to report on at all. The load-time gate. */
export function piholeConfigured(): boolean {
	return piholeCli() || piholeUrl() !== null;
}

/** Tests and a changed PIHOLE_URL both want the detection done again. */
export function resetPiholeCache() {
	endpointCache = null;
	session = null;
	loggingIn = null;
	detailCache = null;
}

/* ---------- the local CLI: one process, one GET ---------- */

/** `pihole api` colours its status line when it thinks it has a terminal. */
function plain(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI is control characters.
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * The CLI prints its own lines around the body when something went wrong — a
 * status line ahead of it, a logout complaint after it — and still exits 0. The
 * body is the one JSON object in there, so it is taken as the span between the
 * outermost braces rather than trusted to be the whole of stdout.
 */
function jsonSpan(text: string): string | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/**
 * One v6 GET, run as `pihole api <endpoint>`. The CLI does the session — it
 * logs in with the password it can read, asks, and logs out again — so there is
 * nothing here about credentials, which is the whole point of the path.
 */
async function cliGet<T>(path: string): Promise<T> {
	const endpoint = path.replace(/^\//, "");
	const out = await transport.exec(["pihole", "api", endpoint]);
	const text = plain(out.stdout).trim();
	if (out.code !== 0) {
		throw new PiholeUnavailable(
			plain(out.stderr).trim() ||
				text ||
				`pihole api ${endpoint} exited ${out.code}`,
		);
	}
	// Anything but a 200 is announced on its own line and then answered with an
	// error body; the exit code stays 0 either way.
	const status = /^Status:\s*(\d{3})/m.exec(text);
	if (status) {
		throw new PiholeUnavailable(`pihole api ${endpoint} returned ${status[1]}`);
	}
	const body = jsonSpan(text);
	if (!body) {
		throw new PiholeUnavailable(
			`pihole api ${endpoint} did not return JSON: ${text.slice(0, 200) || "(nothing)"}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new PiholeUnavailable(`pihole api ${endpoint} did not return JSON`);
	}
	// The status line above is the CLI's way of saying so, but it is the CLI's
	// formatting and not a contract. FTL's own refusal is, and none of the
	// endpoints asked for here answer with one, so an `error` is a failure
	// whatever the lines around it said — otherwise it would shape into a
	// Pi-hole reporting zeroes, which is the one wrong answer worse than none.
	const failed = (parsed as { error?: { key?: string; message?: string } })
		?.error;
	if (failed) {
		throw new PiholeUnavailable(
			`pihole api ${endpoint}: ${failed.message ?? failed.key ?? "refused"}`,
		);
	}
	return parsed as T;
}

/* ---------- v6: a session, then JSON ---------- */

let session: { base: string; sid: string } | null = null;

/**
 * A tick asks for several things at once, so a Pi-hole that has just restarted
 * answers 401 to all of them at the same moment. Logging in once and handing
 * the same promise to everyone who noticed is what keeps that from opening a
 * session per request — FTL keeps only a handful and evicts the rest.
 */
let loggingIn: { base: string; sid: Promise<string> } | null = null;

async function login(base: string): Promise<string> {
	if (loggingIn?.base === base) return await loggingIn.sid;
	const sid = authenticate(base).finally(() => {
		loggingIn = null;
	});
	loggingIn = { base, sid };
	return await sid;
}

async function authenticate(base: string): Promise<string> {
	const password = piholePassword();
	if (!password) {
		throw new PiholeUnavailable(
			`${base} wants a session — set PIHOLE_PASSWORD to the app password from Settings → Web interface & API`,
		);
	}

	const res = await request(`${base}/api/auth`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password }),
	});
	const body = (await res.json().catch(() => null)) as {
		session?: { valid?: boolean; sid?: string | null; message?: string | null };
	} | null;
	const sid = body?.session?.sid ?? null;
	if (!res.ok || !sid) {
		const said = body?.session?.message;
		throw new PiholeUnavailable(
			`${base} refused the app password${said ? ` — ${said}` : ` (${res.status} ${res.statusText})`}`,
		);
	}
	session = { base, sid };
	return sid;
}

/**
 * One v6 call, with the session attached and renewed once if it had expired.
 * FTL hands out sessions with a validity window and forgets them on restart, so
 * a 401 is the ordinary case rather than a failure — but only the first time,
 * or a wrong password would loop.
 */
async function v6Fetch(
	base: string,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	const send = (sid: string | null) =>
		request(`${base}/api${path}`, {
			...init,
			headers: {
				...(init?.body ? { "Content-Type": "application/json" } : {}),
				...(sid ? { "X-FTL-SID": sid } : {}),
				...(init?.headers ?? {}),
			},
		});

	const held = session?.base === base ? session.sid : null;
	const res = await send(held);
	if (res.status !== 401) return res;
	await res.text().catch(() => "");
	return await send(await login(base));
}

async function v6Get<T>(base: string, path: string): Promise<T> {
	const res = await v6Fetch(base, path);
	if (!res.ok) {
		throw new PiholeUnavailable(
			`GET ${path} returned ${res.status} ${res.statusText}`,
		);
	}
	return (await res.json()) as T;
}

/**
 * One v6 path, answered. Everything below is written against this rather than
 * against a transport, which is what lets the CLI be a *transport* for v6 and
 * not a third API to shape separately.
 */
type V6Get = <T>(path: string) => Promise<T>;

function v6Getter(endpoint: PiholeEndpoint): V6Get {
	if (endpoint.api === "cli") return <T>(path: string) => cliGet<T>(path);
	const base = endpoint.base;
	return <T>(path: string) => v6Get<T>(base, path);
}

/* ---------- v5: one query string, one answer ---------- */

/**
 * api.php takes any number of its queries at once and answers with all of them
 * merged into one object, which is the whole reason the v5 path is cheap: a
 * tick is a single request no matter how much of it is wanted.
 */
async function v5Get<T>(base: string, params: string[]): Promise<T> {
	const token = piholeToken();
	const query = [
		...params,
		...(token ? [`auth=${encodeURIComponent(token)}`] : []),
	];
	const res = await request(`${base}/admin/api.php?${query.join("&")}`);
	if (!res.ok) {
		throw new PiholeUnavailable(
			`GET admin/api.php returned ${res.status} ${res.statusText}`,
		);
	}
	const body = await res.json().catch(() => null);
	// Unauthenticated api.php answers `[]` rather than an error, which is the
	// single most confusing thing about the v5 API and worth naming outright.
	if (Array.isArray(body) || body === null) {
		throw new PiholeUnavailable(
			token
				? "api.php rejected PIHOLE_TOKEN — it is the WEBPASSWORD hash from /etc/pihole/setupVars.conf"
				: "api.php needs a token for anything but the blocking state — set PIHOLE_TOKEN",
		);
	}
	return body as T;
}

/* ---------- shaping ---------- */

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ratio(blocked: number, total: number): number | null {
	return total > 0 ? blocked / total : null;
}

/** A share of the whole, normalised to 0..1 from counts. */
function shares(counts: Record<string, number>): Record<string, number> {
	const total = Object.values(counts).reduce((sum, n) => sum + count(n), 0);
	if (total <= 0) return {};
	return Object.fromEntries(
		Object.entries(counts).map(([name, n]) => [name, count(n) / total]),
	);
}

function byCount(entries: PiholeEntry[]): PiholeEntry[] {
	return entries.sort((a, b) => b.count - a.count);
}

export function emptyPiholeSummary(): PiholeSummary {
	return {
		available: false,
		via: null,
		url: null,
		version: null,
		blocking: "unknown",
		blockingTimerSec: null,
		queries: 0,
		blocked: 0,
		blockedRatio: null,
		cached: 0,
		forwarded: 0,
		uniqueDomains: 0,
		activeClients: 0,
		gravityDomains: 0,
		gravityUpdated: null,
	};
}

export function emptyPiholeDetail(): PiholeDetail {
	return {
		topQueries: [],
		topBlocked: [],
		topClients: [],
		upstreams: [],
		queryTypes: {},
	};
}

/* ---------- v6 shapes ---------- */

interface V6Summary {
	queries?: {
		total?: number;
		blocked?: number;
		percent_blocked?: number;
		unique_domains?: number;
		forwarded?: number;
		cached?: number;
		types?: Record<string, number>;
	};
	clients?: { active?: number; total?: number };
	gravity?: { domains_being_blocked?: number; last_update?: number };
}

interface V6Blocking {
	blocking?: string;
	timer?: number | null;
}

interface V6Version {
	version?: Record<string, { local?: { version?: string | null } }>;
}

interface V6Top {
	domains?: { domain?: string; count?: number }[];
	clients?: { ip?: string; name?: string | null; count?: number }[];
}

interface V6Upstreams {
	upstreams?: {
		ip?: string;
		name?: string | null;
		port?: number;
		count?: number;
	}[];
}

function v6BlockingState(raw: string | undefined): PiholeSummary["blocking"] {
	if (raw === "enabled") return "enabled";
	if (raw === "disabled") return "disabled";
	// "failed" and "unknown" are both FTL saying it can't answer, and neither is
	// a state the dashboard should draw as if it were off.
	return "unknown";
}

/** The upstream as the operator wrote it: an address, and a port when unusual. */
function upstreamName(ip: string, port: number | undefined): string {
	return port && port !== 53 ? `${ip}#${port}` : ip;
}

async function collectV6(endpoint: PiholeEndpoint): Promise<{
	pihole: PiholeSummary;
	piholeDetail: PiholeDetail;
}> {
	const get = v6Getter(endpoint);
	const [summary, blocking] = await Promise.all([
		get<V6Summary>("/stats/summary"),
		get<V6Blocking>("/dns/blocking"),
	]);

	const queries = summary.queries ?? {};
	const total = count(queries.total);
	const blocked = count(queries.blocked);

	const slow = await v6Detail(endpointKey(endpoint), get);

	return {
		pihole: {
			available: true,
			via: endpoint.api === "cli" ? "cli" : "v6",
			// There is no URL to show for the CLI: it found the API itself, by
			// asking FTL where it was.
			url: endpoint.api === "cli" ? null : endpoint.base,
			version: slow.version,
			blocking: v6BlockingState(blocking.blocking),
			blockingTimerSec:
				typeof blocking.timer === "number" ? Math.round(blocking.timer) : null,
			queries: total,
			blocked,
			blockedRatio: ratio(blocked, total),
			cached: count(queries.cached),
			forwarded: count(queries.forwarded),
			uniqueDomains: count(queries.unique_domains),
			activeClients: count(summary.clients?.active),
			gravityDomains: count(summary.gravity?.domains_being_blocked),
			// FTL reports it in seconds; 0 means "never", not 1970.
			gravityUpdated: count(summary.gravity?.last_update)
				? count(summary.gravity?.last_update) * 1000
				: null,
		},
		piholeDetail: {
			...slow.detail,
			queryTypes: shares(queries.types ?? {}),
		},
	};
}

let detailCache: {
	key: string;
	at: number;
	version: string | null;
	detail: PiholeDetail;
} | null = null;

/** The leaderboards and the version, at {@link DETAIL_INTERVAL_MS} at most. */
async function v6Detail(
	key: string,
	get: V6Get,
): Promise<{ version: string | null; detail: PiholeDetail }> {
	if (
		detailCache?.key === key &&
		Date.now() - detailCache.at < DETAIL_INTERVAL_MS
	)
		return { version: detailCache.version, detail: detailCache.detail };

	const [top, ads, clients, upstreams, version] = await Promise.all([
		get<V6Top>("/stats/top_domains?count=10"),
		get<V6Top>("/stats/top_domains?blocked=true&count=10"),
		get<V6Top>("/stats/top_clients?count=10"),
		get<V6Upstreams>("/stats/upstreams"),
		get<V6Version>("/info/version"),
	]);

	const domains = (raw: V6Top): PiholeEntry[] =>
		byCount(
			(raw.domains ?? []).map((row) => ({
				name: row.domain ?? "",
				label: null,
				count: count(row.count),
			})),
		);

	const detail: PiholeDetail = {
		topQueries: domains(top),
		topBlocked: domains(ads),
		topClients: byCount(
			(clients.clients ?? []).map((row) => ({
				name: row.ip ?? "",
				label: row.name || null,
				count: count(row.count),
			})),
		),
		upstreams: byCount(
			(upstreams.upstreams ?? []).map((row) => ({
				name: upstreamName(row.ip ?? "", row.port),
				label: row.name || null,
				count: count(row.count),
			})),
		),
		queryTypes: {},
	};

	const local = version.version ?? {};
	detailCache = {
		key,
		at: Date.now(),
		version: local.core?.local?.version ?? local.ftl?.local?.version ?? null,
		detail,
	};
	return { version: detailCache.version, detail };
}

/* ---------- v5 shapes ---------- */

interface V5Body {
	domains_being_blocked?: number;
	dns_queries_today?: number;
	ads_blocked_today?: number;
	unique_domains?: number;
	queries_forwarded?: number;
	queries_cached?: number;
	unique_clients?: number;
	status?: string;
	gravity_last_updated?: { absolute?: number };
	top_queries?: Record<string, number>;
	top_ads?: Record<string, number>;
	top_sources?: Record<string, number>;
	forward_destinations?: Record<string, number>;
	querytypes?: Record<string, number>;
	core_current?: string;
	FTL_current?: string;
}

/**
 * v5 keys a client or an upstream as `name|address`, with the name left out
 * when it has none. The address is the identity and the name is decoration,
 * which is the way round this splits them.
 */
function v5Entries(raw: Record<string, number> | undefined): PiholeEntry[] {
	return byCount(
		Object.entries(raw ?? {}).map(([key, value]) => {
			const bar = key.indexOf("|");
			const label = bar > 0 ? key.slice(0, bar) : null;
			return {
				name: bar >= 0 ? key.slice(bar + 1) : key,
				label,
				count: count(value),
			};
		}),
	);
}

/**
 * `forward_destinations` and `querytypes` come back as percentages of the day's
 * queries rather than as counts — the one place the two APIs disagree about
 * units. Turning the percentage back into a count is what the v5 admin UI does
 * with the same numbers, and it keeps {@link PiholeEntry} meaning one thing.
 */
function v5Counts(
	raw: Record<string, number> | undefined,
	total: number,
): PiholeEntry[] {
	return byCount(
		v5Entries(raw).map((entry) => ({
			...entry,
			count: Math.round((entry.count / 100) * total),
		})),
	);
}

async function collectV5(base: string): Promise<{
	pihole: PiholeSummary;
	piholeDetail: PiholeDetail;
}> {
	const fresh =
		!detailCache ||
		detailCache.key !== base ||
		Date.now() - detailCache.at >= DETAIL_INTERVAL_MS;

	const body = await v5Get<V5Body>(base, [
		"summaryRaw",
		...(fresh
			? [
					"topItems=10",
					"getQuerySources=10",
					"getForwardDestinations",
					"getQueryTypes",
					"versions",
				]
			: []),
	]);

	const total = count(body.dns_queries_today);
	const blocked = count(body.ads_blocked_today);

	if (fresh) {
		detailCache = {
			key: base,
			at: Date.now(),
			version: body.core_current ?? body.FTL_current ?? null,
			detail: {
				topQueries: v5Entries(body.top_queries),
				topBlocked: v5Entries(body.top_ads),
				topClients: v5Entries(body.top_sources),
				upstreams: v5Counts(body.forward_destinations, total),
				queryTypes: Object.fromEntries(
					Object.entries(body.querytypes ?? {}).map(([name, share]) => [
						name,
						count(share) / 100,
					]),
				),
			},
		};
	}

	return {
		pihole: {
			available: true,
			via: "v5",
			url: base,
			version: detailCache?.version ?? null,
			blocking:
				body.status === "enabled"
					? "enabled"
					: body.status === "disabled"
						? "disabled"
						: "unknown",
			// v5 knows when blocking comes back but never says so over the API.
			blockingTimerSec: null,
			queries: total,
			blocked,
			blockedRatio: ratio(blocked, total),
			cached: count(body.queries_cached),
			forwarded: count(body.queries_forwarded),
			uniqueDomains: count(body.unique_domains),
			activeClients: count(body.unique_clients),
			gravityDomains: count(body.domains_being_blocked),
			gravityUpdated: count(body.gravity_last_updated?.absolute)
				? count(body.gravity_last_updated?.absolute) * 1000
				: null,
		},
		piholeDetail: detailCache?.detail ?? emptyPiholeDetail(),
	};
}

/* ---------- what the module calls ---------- */

export async function collectPihole(): Promise<{
	pihole: PiholeSummary;
	piholeDetail: PiholeDetail;
}> {
	const endpoint = await piholeEndpoint();
	if (!endpoint)
		return { pihole: emptyPiholeSummary(), piholeDetail: emptyPiholeDetail() };
	return await collectPiholeVia(endpoint);
}

/** The collection itself, with the API choice already made. */
export async function collectPiholeVia(endpoint: PiholeEndpoint): Promise<{
	pihole: PiholeSummary;
	piholeDetail: PiholeDetail;
}> {
	return endpoint.api === "v5"
		? await collectV5(endpoint.base)
		: await collectV6(endpoint);
}

/* ---------- local DNS ---------- */

/**
 * A CLI request that changes state rather than reading it. Adding or removing
 * a host entry is a PUT or DELETE against a URL that already names the whole
 * value, so — unlike {@link cliGet} — there is no body to parse back: FTL
 * either did it or it didn't, and says so with its exit code and status line.
 */
async function cliRequest(path: string, method: string): Promise<void> {
	const endpoint = path.replace(/^\//, "");
	const out = await transport.exec(["pihole", "api", "-X", method, endpoint]);
	const text = plain(out.stdout).trim();
	if (out.code !== 0) {
		throw new PiholeUnavailable(
			plain(out.stderr).trim() ||
				text ||
				`pihole api -X ${method} ${endpoint} exited ${out.code}`,
		);
	}
	const status = /^Status:\s*(\d{3})/m.exec(text);
	if (status && !status[1]!.startsWith("2")) {
		throw new PiholeUnavailable(
			`pihole api -X ${method} ${endpoint} returned ${status[1]}`,
		);
	}
}

/** The HTTP twin of {@link cliRequest} — same URL, same verbs, a session instead of a uid. */
async function v6Request(
	base: string,
	path: string,
	method: string,
): Promise<void> {
	const res = await v6Fetch(base, path, { method });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new PiholeUnavailable(
			`${method} ${path} returned ${res.status} ${res.statusText}${
				body ? `: ${body}` : ""
			}`,
		);
	}
	await res.text().catch(() => "");
}

/**
 * A domain FTL will answer for locally, the same shape as an `/etc/hosts`
 * line. v6 keys its config array on the value itself — `PUT
 * /api/config/dns/hosts/<ip domain>` adds that exact entry, `DELETE` removes
 * it — which is also the CLI's own `-X` verbs, so one code path below serves
 * both. v5 has no such array; `admin/api.php?customdns` is its own small API
 * for the same thing, add and delete both keyed on domain *and* ip together.
 */
export async function setLocalDns(
	params: { domain: string; ip: string; present: boolean },
	/** the endpoint to use; resolved from the environment when not given */
	forced?: PiholeEndpoint,
): Promise<CommandResult> {
	const domain = params.domain.trim();
	const ip = params.ip.trim();
	const present = params.present;
	if (!domain) throw new Error("domain is required");
	if (present && !ip) throw new Error("ip is required to add a record");

	const endpoint = forced ?? (await piholeEndpoint());
	if (!endpoint) throw new PiholeUnavailable("this node has no Pi-hole to ask");

	const said = present ? `${domain} -> ${ip} added` : `${domain} removed`;

	if (endpoint.api === "v5") {
		const body = await v5Get<{ message?: string }>(endpoint.base, [
			"customdns",
			`action=${present ? "add" : "delete"}`,
			`domain=${encodeURIComponent(domain)}`,
			`ip=${encodeURIComponent(ip)}`,
		]);
		return { ok: true, output: body.message ?? said };
	}

	const path = `/config/dns/hosts/${encodeURIComponent(`${ip} ${domain}`)}`;
	try {
		if (endpoint.api === "cli") {
			await cliRequest(path, present ? "PUT" : "DELETE");
		} else {
			await v6Request(endpoint.base, path, present ? "PUT" : "DELETE");
		}
		return { ok: true, output: said };
	} catch (err) {
		return { ok: false, output: err instanceof Error ? err.message : String(err) };
	}
}

/* ---------- control ---------- */

/** A day is as long as either API will hold blocking off for. */
const MAX_TIMER_SEC = 24 * 60 * 60;

/**
 * Blocking on or off, with an optional timer — the one thing anybody wants to
 * do to a Pi-hole from somewhere else, usually because something is broken and
 * DNS is the suspect. The timer is why it's worth having: blocking that comes
 * back by itself can't be left off by accident.
 */
export async function setBlocking(
	params: { blocking: boolean; seconds?: number | null },
	/** the endpoint to use; resolved from the environment when not given */
	forced?: PiholeEndpoint,
): Promise<CommandResult> {
	const { blocking } = params;
	const seconds =
		params.seconds == null || params.seconds === 0 ? null : params.seconds;
	if (seconds !== null) {
		if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_TIMER_SEC)
			throw new Error(`timer must be 1..${MAX_TIMER_SEC} seconds`);
		if (blocking)
			throw new Error("a timer only makes sense when disabling blocking");
	}

	const endpoint = forced ?? (await piholeEndpoint());
	if (!endpoint) throw new PiholeUnavailable("this node has no Pi-hole to ask");

	const said = `blocking ${blocking ? "enabled" : "disabled"}${
		seconds ? ` for ${seconds}s` : ""
	}`;

	// `pihole api` is a GET and nothing else, so the CLI's own verbs are how
	// blocking is changed from here. They exit 0 whatever FTL made of it, which
	// is why the state is read back rather than assumed.
	if (endpoint.api === "cli") {
		const out = await transport.exec([
			"pihole",
			blocking ? "enable" : "disable",
			...(seconds ? [`${seconds}s`] : []),
		]);
		if (out.code !== 0) {
			return {
				ok: false,
				output:
					plain(out.stderr).trim() ||
					plain(out.stdout).trim() ||
					`pihole ${blocking ? "enable" : "disable"} exited ${out.code}`,
			};
		}
		const after = await cliGet<V6Blocking>("/dns/blocking").catch(() => null);
		const ended = v6BlockingState(after?.blocking);
		return ended === (blocking ? "enabled" : "disabled")
			? { ok: true, output: said }
			: { ok: false, output: `the CLI ran, but blocking is ${ended}` };
	}

	if (endpoint.api === "v6") {
		const res = await v6Fetch(endpoint.base, "/dns/blocking", {
			method: "POST",
			body: JSON.stringify({ blocking, timer: seconds }),
		});
		const body = (await res.text()).trim();
		return {
			ok: res.ok,
			output: res.ok ? said : body || `${res.status} ${res.statusText}`,
		};
	}

	const body = await v5Get<{ status?: string }>(endpoint.base, [
		blocking ? "enable" : `disable=${seconds ?? 0}`,
	]);
	// api.php answers with the state it ended up in, which is the only
	// confirmation v5 offers.
	return {
		ok: body.status === (blocking ? "enabled" : "disabled"),
		output: body.status ? said : "api.php did not say what happened",
	};
}
