/**
 * The node half of an installed module, and a complete example of the shape.
 *
 * Three optional things, all of them plain functions:
 *
 *   available(ctx)  can this host serve the module at all? Say no and the
 *                   module is simply absent — no tab, no card face, no empty
 *                   section in the dashboard.
 *   collect(ctx)    one tick of data. `values` are scalars the card face reads
 *                   by name; `rows` are the table the tab draws. Both are
 *                   described by stats.module.json, which is the only thing the
 *                   browser sees — there is no browser-side code in a module.
 *   actions         control actions, named `<module id>.<verb>` and answered
 *                   request/response. They run only when the node allows
 *                   control.
 *
 * `ctx.host` is the gated surface from src/modules/host.ts: this module
 * declared the `http` grant and so has `fetch`, and nothing else. Asking for
 * something it didn't declare throws rather than working.
 */

interface Endpoint {
	name: string;
	url: string;
}

interface Checked {
	name: string;
	url: string;
	state: "up" | "down";
	status: number | null;
	ms: number;
	error: string | null;
}

interface Context {
	host: { fetch(url: string, init?: RequestInit): Promise<Response> };
	control: boolean;
	settings: Record<string, unknown>;
	dir: string;
}

/** `moduleSettings.endpoints.urls` in the node's config, in either shorthand. */
function endpointsFrom(settings: Record<string, unknown>): Endpoint[] {
	const raw = settings.urls;
	if (!Array.isArray(raw)) return [];
	const endpoints: Endpoint[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			endpoints.push({ name: new URL(entry).host, url: entry });
		} else if (entry && typeof entry === "object") {
			const { name, url } = entry as { name?: string; url?: string };
			if (url) endpoints.push({ name: name ?? new URL(url).host, url });
		}
	}
	return endpoints;
}

const TIMEOUT_MS = 5000;

async function check(ctx: Context, endpoint: Endpoint): Promise<Checked> {
	const started = Date.now();
	try {
		const response = await ctx.host.fetch(endpoint.url, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
			redirect: "follow",
		});
		return {
			name: endpoint.name,
			url: endpoint.url,
			state: response.ok ? "up" : "down",
			status: response.status,
			ms: Date.now() - started,
			error: null,
		};
	} catch (err) {
		return {
			name: endpoint.name,
			url: endpoint.url,
			state: "down",
			status: null,
			ms: Date.now() - started,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export default {
	// Nothing to do on a node that wasn't given any URLs, and a tab full of
	// nothing is worse than no tab.
	available(ctx: Context) {
		return endpointsFrom(ctx.settings).length > 0;
	},

	async collect(ctx: Context) {
		const endpoints = endpointsFrom(ctx.settings);
		const results = await Promise.all(
			endpoints.map((endpoint) => check(ctx, endpoint)),
		);

		const up = results.filter((result) => result.state === "up");
		const down = results.filter((result) => result.state === "down");
		const slowest = results.reduce<Checked | null>(
			(worst, result) => (!worst || result.ms > worst.ms ? result : worst),
			null,
		);
		const checkedAt = Date.now();

		return {
			values: {
				total: results.length,
				up: up.length,
				down: down.length,
				slowest: slowest ? `${slowest.name} ${slowest.ms}ms` : null,
				checkedAt,
			},
			rows: results.map((result) => ({
				name: result.name,
				url: result.url,
				state: result.state,
				status: result.status,
				ms: result.ms,
				error: result.error,
				checkedAt,
			})),
			// The dashboard paints the meter and the tab's badge from this, so it's
			// the module's own verdict rather than a guess made from the numbers.
			status: down.length ? ("crit" as const) : ("ok" as const),
			detail: down.length
				? `${down.map((result) => result.name).join(", ")} unreachable`
				: null,
		};
	},

	actions: {
		/** Re-checks one endpoint now, rather than waiting for the next tick. */
		async "endpoints.check"(params: Record<string, unknown>, ctx: Context) {
			const endpoints = endpointsFrom(ctx.settings);
			const wanted = String(params.name ?? "");
			const endpoint = endpoints.find((entry) => entry.name === wanted);
			if (!endpoint) throw new Error(`no endpoint named '${wanted}'`);
			return await check(ctx, endpoint);
		},
	},
};
