import { afterEach, describe, expect, test } from "bun:test";
import {
	collectPiholeVia,
	detectApi,
	type PiholeTransport,
	resetPiholeCache,
	setBlocking,
	usePiholeTransport,
} from "./pihole.ts";

/**
 * The transport is the seam, the way it is for Proxmox: everything here runs
 * the real shaping and the real request building against recorded response
 * shapes, so v5 and v6 disagreeing about units — counts one side, percentages
 * the other — shows up as a failing assertion rather than as a leaderboard of
 * nonsense on a machine nobody is looking at.
 */

const BASE = "http://pi.hole";

interface Call {
	url: string;
	init?: RequestInit;
}

/** A fake Pi-hole: routes matched by substring, in the order they were given. */
function serve(routes: [string, unknown, number?][]): {
	transport: PiholeTransport;
	calls: Call[];
} {
	const calls: Call[] = [];
	return {
		calls,
		transport: {
			async fetch(url, init) {
				calls.push({ url, init });
				const route = routes.find(([match]) => url.includes(match));
				if (!route) return new Response("not found", { status: 404 });
				const [, body, status] = route;
				return new Response(JSON.stringify(body), {
					status: status ?? 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		},
	};
}

afterEach(() => {
	usePiholeTransport(null);
	resetPiholeCache();
	delete process.env.PIHOLE_PASSWORD;
	delete process.env.PIHOLE_TOKEN;
});

/* ---------- v6 ---------- */

const V6_ROUTES: [string, unknown, number?][] = [
	[
		"/api/stats/summary",
		{
			queries: {
				total: 10_000,
				blocked: 2_500,
				percent_blocked: 25,
				unique_domains: 812,
				forwarded: 5_000,
				cached: 2_500,
				types: { A: 6_000, AAAA: 3_000, HTTPS: 1_000 },
			},
			clients: { active: 12, total: 30 },
			gravity: { domains_being_blocked: 120_000, last_update: 1_700_000_000 },
		},
	],
	["/api/dns/blocking", { blocking: "enabled", timer: null }],
	[
		"/api/stats/top_domains?blocked=true",
		{ domains: [{ domain: "ads.example", count: 900 }] },
	],
	[
		"/api/stats/top_domains",
		{
			domains: [
				{ domain: "quiet.example", count: 10 },
				{ domain: "busy.example", count: 400 },
			],
		},
	],
	[
		"/api/stats/top_clients",
		{ clients: [{ ip: "10.0.0.5", name: "laptop", count: 700 }] },
	],
	[
		"/api/stats/upstreams",
		{
			upstreams: [
				{ ip: "1.1.1.1", name: "cloudflare", port: 53, count: 4_000 },
				{ ip: "127.0.0.1", name: null, port: 5335, count: 1_000 },
			],
		},
	],
	[
		"/api/info/version",
		{ version: { core: { local: { version: "v6.0.4" } } } },
	],
];

describe("a v6 Pi-hole", () => {
	test("summary, blocking and the leaderboards come back shaped", async () => {
		const { transport } = serve(V6_ROUTES);
		usePiholeTransport(transport);

		const { pihole, piholeDetail } = await collectPiholeVia({
			base: BASE,
			api: "v6",
		});

		expect(pihole.available).toBe(true);
		expect(pihole.via).toBe("v6");
		expect(pihole.version).toBe("v6.0.4");
		expect(pihole.blocking).toBe("enabled");
		expect(pihole.queries).toBe(10_000);
		expect(pihole.blocked).toBe(2_500);
		expect(pihole.blockedRatio).toBeCloseTo(0.25);
		expect(pihole.activeClients).toBe(12);
		expect(pihole.gravityDomains).toBe(120_000);
		// FTL reports seconds; the dashboard wants milliseconds.
		expect(pihole.gravityUpdated).toBe(1_700_000_000_000);

		// Sorted by count, not by whatever order FTL answered in.
		expect(piholeDetail.topQueries.map((entry) => entry.name)).toEqual([
			"busy.example",
			"quiet.example",
		]);
		expect(piholeDetail.topBlocked[0]?.count).toBe(900);
		expect(piholeDetail.topClients[0]).toEqual({
			name: "10.0.0.5",
			label: "laptop",
			count: 700,
		});
		// A non-standard port is part of the upstream's identity; 53 is noise.
		expect(piholeDetail.upstreams.map((entry) => entry.name)).toEqual([
			"1.1.1.1",
			"127.0.0.1#5335",
		]);
		// Types arrive as counts and leave as shares of the total.
		expect(piholeDetail.queryTypes.A).toBeCloseTo(0.6);
		expect(piholeDetail.queryTypes.HTTPS).toBeCloseTo(0.1);
	});

	test("an expired session is re-authenticated once, not looped on", async () => {
		process.env.PIHOLE_PASSWORD = "hunter2";
		let authed = false;
		const calls: string[] = [];

		usePiholeTransport({
			async fetch(url) {
				calls.push(url);
				if (url.includes("/api/auth")) {
					authed = true;
					return Response.json({ session: { valid: true, sid: "abc" } });
				}
				if (!authed) return new Response("{}", { status: 401 });
				const route = V6_ROUTES.find(([match]) => url.includes(match));
				return Response.json(route?.[1] ?? {});
			},
		});

		const { pihole } = await collectPiholeVia({ base: BASE, api: "v6" });
		expect(pihole.queries).toBe(10_000);
		expect(calls.filter((url) => url.includes("/api/auth"))).toHaveLength(1);
	});

	test("no password and a Pi-hole that wants one says which one to set", async () => {
		usePiholeTransport({
			async fetch() {
				return new Response("{}", { status: 401 });
			},
		});
		expect(collectPiholeVia({ base: BASE, api: "v6" })).rejects.toThrow(
			/PIHOLE_PASSWORD/,
		);
	});

	test("pausing blocking sends the timer and says what it did", async () => {
		const { transport, calls } = serve([
			["/api/dns/blocking", { blocking: "disabled", timer: 300 }],
		]);
		usePiholeTransport(transport);

		const result = await setBlocking(
			{ blocking: false, seconds: 300 },
			{ base: BASE, api: "v6" },
		);
		expect(result.ok).toBe(true);
		expect(result.output).toBe("blocking disabled for 300s");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			blocking: false,
			timer: 300,
		});
	});
});

/* ---------- v5 ---------- */

const V5_BODY = {
	domains_being_blocked: 120_000,
	dns_queries_today: 10_000,
	ads_blocked_today: 2_500,
	ads_percentage_today: 25,
	unique_domains: 812,
	queries_forwarded: 5_000,
	queries_cached: 2_500,
	unique_clients: 12,
	status: "disabled",
	gravity_last_updated: { absolute: 1_700_000_000 },
	top_queries: { "busy.example": 400, "quiet.example": 10 },
	top_ads: { "ads.example": 900 },
	top_sources: { "laptop|10.0.0.5": 700, "10.0.0.9": 20 },
	forward_destinations: { "cloudflare|1.1.1.1": 40, "cache|cache": 25 },
	querytypes: { A: 60, AAAA: 30, HTTPS: 10 },
	core_current: "v5.18.4",
};

describe("a v5 Pi-hole", () => {
	test("one request answers everything, in the same shapes v6 does", async () => {
		const { transport, calls } = serve([["/admin/api.php", V5_BODY]]);
		usePiholeTransport(transport);
		process.env.PIHOLE_TOKEN = "deadbeef";

		const { pihole, piholeDetail } = await collectPiholeVia({
			base: BASE,
			api: "v5",
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("summaryRaw");
		expect(calls[0]?.url).toContain("auth=deadbeef");

		expect(pihole.via).toBe("v5");
		expect(pihole.version).toBe("v5.18.4");
		// The state this module exists to make visible.
		expect(pihole.blocking).toBe("disabled");
		expect(pihole.blockedRatio).toBeCloseTo(0.25);
		expect(pihole.gravityUpdated).toBe(1_700_000_000_000);

		// `name|address` splits the way round the address is the identity.
		expect(piholeDetail.topClients[0]).toEqual({
			name: "10.0.0.5",
			label: "laptop",
			count: 700,
		});
		expect(piholeDetail.topClients[1]?.label).toBeNull();
		// Upstreams arrive as percentages of the day and leave as counts, so a
		// v5 leaderboard reads the same as a v6 one.
		expect(piholeDetail.upstreams[0]).toEqual({
			name: "1.1.1.1",
			label: "cloudflare",
			count: 4_000,
		});
		expect(piholeDetail.queryTypes.A).toBeCloseTo(0.6);
	});

	test("api.php's empty-array refusal is reported as the missing token", async () => {
		const { transport } = serve([["/admin/api.php", []]]);
		usePiholeTransport(transport);
		expect(collectPiholeVia({ base: BASE, api: "v5" })).rejects.toThrow(
			/PIHOLE_TOKEN/,
		);
	});

	test("enabling blocking is confirmed by the state it reports back", async () => {
		const { transport, calls } = serve([
			["/admin/api.php", { status: "enabled" }],
		]);
		usePiholeTransport(transport);
		process.env.PIHOLE_TOKEN = "deadbeef";

		const result = await setBlocking(
			{ blocking: true },
			{ base: BASE, api: "v5" },
		);
		expect(result.ok).toBe(true);
		expect(calls[0]?.url).toContain("enable");
	});
});

/* ---------- shared ---------- */

describe("reaching a Pi-hole at all", () => {
	test("v6 is recognised even when it refuses the request", async () => {
		usePiholeTransport({
			async fetch(url) {
				return url.includes("/api/info/version")
					? new Response("{}", { status: 401 })
					: new Response("nope", { status: 404 });
			},
		});
		expect(await detectApi(BASE)).toBe("v6");
	});

	test("v5 is recognised by api.php answering with a status", async () => {
		usePiholeTransport({
			async fetch(url) {
				return url.includes("/admin/api.php")
					? Response.json({ status: "enabled" })
					: new Response("nope", { status: 404 });
			},
		});
		expect(await detectApi(BASE)).toBe("v5");
	});

	test("something that isn't a Pi-hole is neither, rather than v5", async () => {
		usePiholeTransport({
			async fetch() {
				return new Response("<html>hello</html>", { status: 200 });
			},
		});
		expect(await detectApi(BASE)).toBeNull();
	});

	test("a timer only makes sense on the way down, and has a ceiling", async () => {
		expect(
			setBlocking({ blocking: true, seconds: 60 }, { base: BASE, api: "v6" }),
		).rejects.toThrow(/only makes sense when disabling/);
		expect(
			setBlocking(
				{ blocking: false, seconds: 999_999 },
				{ base: BASE, api: "v6" },
			),
		).rejects.toThrow(/1\.\.86400/);
	});
});
