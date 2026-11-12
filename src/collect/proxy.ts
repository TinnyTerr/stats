import type { ProxyRoute, ProxySummary } from "../types.ts";

/**
 * The reverse proxy, watched over its own API: `/topology` for the routes with
 * their upstream health and counters, `/routes/:name` and `/reload` to act.
 *
 * The transport is the seam, the same way it is for Pi-hole: the module hands
 * in the host's fetch, tests hand in a fake.
 */

export interface ProxyEndpoint {
	/** e.g. http://127.0.0.1:7778 */
	url: string;
	token: string | null;
}

export type ProxyFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class ProxyUnavailable extends Error {}

const TIMEOUT_MS = 5000;

function headers(ep: ProxyEndpoint): Record<string, string> {
	return ep.token ? { authorization: `Bearer ${ep.token}` } : {};
}

async function call(
	fetchFn: ProxyFetch,
	ep: ProxyEndpoint,
	path: string,
	method = "GET",
): Promise<Response> {
	let res: Response;
	try {
		res = await fetchFn(`${ep.url}${path}`, {
			method,
			headers: headers(ep),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new ProxyUnavailable(
			`proxy at ${ep.url} unreachable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (res.status === 401)
		throw new ProxyUnavailable(`proxy at ${ep.url} refused the token`);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new ProxyUnavailable(
			body?.error ?? `proxy at ${ep.url} answered ${res.status}`,
		);
	}
	return res;
}

/** Whatever `/topology` sent, shaped; a field the proxy didn't send reads as empty. */
export function shapeTopology(raw: unknown): ProxyRoute[] {
	if (!Array.isArray(raw)) return [];
	return raw.map((r: Record<string, any>) => ({
		name: String(r.name ?? ""),
		source: r.source === "file" ? "file" : "api",
		hosts: Array.isArray(r.hosts) ? r.hosts.map(String) : [],
		path: String(r.path ?? "/"),
		to: Array.isArray(r.to)
			? r.to.map((t: Record<string, unknown>) => ({
					url: String(t.url ?? ""),
					down: t.down === true,
				}))
			: [],
		chain: Array.isArray(r.chain) ? r.chain.map(String) : [],
		error: typeof r.error === "string" ? r.error : null,
		requests: Number(r.stats?.requests ?? 0),
		errors: Number(r.stats?.errors ?? 0),
		lastSeen: typeof r.stats?.lastSeen === "number" ? r.stats.lastSeen : null,
	}));
}

export function summarise(url: string, routes: ProxyRoute[]): ProxySummary {
	return {
		available: true,
		url,
		routes: routes.length,
		file: routes.filter((r) => r.source === "file").length,
		api: routes.filter((r) => r.source === "api").length,
		requests: routes.reduce((n, r) => n + r.requests, 0),
		errors: routes.reduce((n, r) => n + r.errors, 0),
		down: routes.reduce((n, r) => n + r.to.filter((t) => t.down).length, 0),
		broken: routes.filter((r) => r.error).length,
	};
}

export async function collectProxy(
	fetchFn: ProxyFetch,
	ep: ProxyEndpoint,
): Promise<{ proxy: ProxySummary; proxyRoutes: ProxyRoute[] }> {
	const res = await call(fetchFn, ep, "/topology");
	const routes = shapeTopology(await res.json().catch(() => null));
	return { proxy: summarise(ep.url, routes), proxyRoutes: routes };
}

export async function reloadProxy(fetchFn: ProxyFetch, ep: ProxyEndpoint) {
	await call(fetchFn, ep, "/reload", "POST");
	return { ok: true };
}

export async function removeProxyRoute(
	fetchFn: ProxyFetch,
	ep: ProxyEndpoint,
	name: string,
) {
	if (!name) throw new ProxyUnavailable("a route name is required");
	await call(fetchFn, ep, `/routes/${encodeURIComponent(name)}`, "DELETE");
	return { ok: true };
}
