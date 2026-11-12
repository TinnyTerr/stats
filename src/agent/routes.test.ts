import { describe, expect, test } from "bun:test";
import { RouteSync } from "./routes.ts";
import type { Supervisor } from "./supervisor.ts";

type Call = { method: string; url: string; body: unknown };

function setup() {
	let up = false;
	const calls: Call[] = [];
	const supervisor = {
		onChange: () => () => {},
		routes: () => [
			{
				name: "app-web",
				up,
				route: { hosts: ["app.lan"], path: null, port: 3000, target: null },
			},
		],
	} as unknown as Supervisor;
	const fake = (async (url: string, init: RequestInit) => {
		calls.push({
			method: init.method ?? "GET",
			url,
			body: init.body ? JSON.parse(String(init.body)) : null,
		});
		return new Response("{}", { status: 200 });
	}) as unknown as typeof fetch;
	const sync = new RouteSync(
		supervisor,
		{ url: "http://proxy:7778", token: "t", host: "10.0.0.5" },
		{ fetch: fake, log: () => {} },
	);
	return { sync, calls, setUp: (v: boolean) => (up = v) };
}

describe("RouteSync", () => {
	test("registers a healthy route once, and removes it when it stops", async () => {
		const { sync, calls, setUp } = setup();

		await sync.sync();
		expect(calls).toEqual([]);

		setUp(true);
		await sync.sync();
		await sync.sync(); // unchanged: no second PUT
		expect(calls).toEqual([
			{
				method: "PUT",
				url: "http://proxy:7778/routes/app-web",
				body: { host: ["app.lan"], to: "10.0.0.5:3000" },
			},
		]);

		setUp(false);
		await sync.sync();
		expect(calls.at(-1)).toMatchObject({
			method: "DELETE",
			url: "http://proxy:7778/routes/app-web",
		});
	});
});
