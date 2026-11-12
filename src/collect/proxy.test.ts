import { describe, expect, test } from "bun:test";
import {
	collectProxy,
	ProxyUnavailable,
	removeProxyRoute,
	shapeTopology,
} from "./proxy.ts";

const ep = { url: "http://p:7778", token: "t" };

const topology = [
	{
		name: "app",
		source: "api",
		hosts: ["app.example.com"],
		path: "/",
		chain: ["compress"],
		error: null,
		to: [
			{ url: "http://a:1", down: false },
			{ url: "http://b:1", down: true },
		],
		stats: { requests: 10, errors: 2, lastSeen: 5 },
	},
	{
		name: "bad",
		source: "file",
		hosts: [],
		path: "/x",
		chain: [],
		error: "boom",
		to: [],
	},
];

describe("proxy collector", () => {
	test("summarises topology and sends the bearer token", async () => {
		let auth = "";
		const { proxy, proxyRoutes } = await collectProxy(async (url, init) => {
			expect(url).toBe("http://p:7778/topology");
			auth = new Headers(init?.headers).get("authorization") ?? "";
			return Response.json(topology);
		}, ep);
		expect(auth).toBe("Bearer t");
		expect(proxyRoutes).toHaveLength(2);
		expect(proxy).toMatchObject({
			routes: 2,
			api: 1,
			file: 1,
			requests: 10,
			errors: 2,
			down: 1,
			broken: 1,
		});
	});

	test("a missing stats block reads as zero", () => {
		expect(shapeTopology(topology)[1]).toMatchObject({
			requests: 0,
			lastSeen: null,
		});
		expect(shapeTopology("nope")).toEqual([]);
	});

	test("401 and unreachable are ProxyUnavailable", async () => {
		await expect(
			collectProxy(async () => new Response("", { status: 401 }), ep),
		).rejects.toBeInstanceOf(ProxyUnavailable);
		await expect(
			collectProxy(async () => {
				throw new Error("ECONNREFUSED");
			}, ep),
		).rejects.toThrow(/unreachable/);
	});

	test("remove encodes the name and surfaces the proxy's refusal", async () => {
		let seen = "";
		await removeProxyRoute(
			async (url, init) => {
				seen = `${init?.method} ${url}`;
				return Response.json({ ok: true });
			},
			ep,
			"a b",
		);
		expect(seen).toBe("DELETE http://p:7778/routes/a%20b");
		await expect(
			removeProxyRoute(
				async () =>
					Response.json(
						{ error: "not found (only api routes can be deleted)" },
						{ status: 404 },
					),
				ep,
				"x",
			),
		).rejects.toThrow(/only api routes/);
	});
});
