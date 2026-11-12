import type { ProxyConfig } from "./config.ts";
import type { Supervisor } from "./supervisor.ts";

/**
 * Keeps a proxy's route table in step with what this node is actually
 * serving. A route exists while its process is running and healthy and is
 * deleted the moment it isn't, so the proxy never sends traffic to a process
 * that is mid-deploy or crash-looping.
 *
 * The proxy is deliberately dumb about this: it only knows its own API
 * (`PUT /routes/:name`, `DELETE /routes/:name`). Everything that decides *when*
 * a route should exist lives here.
 */

/** Re-checked on this cadence even with no change, so a restarted proxy heals. */
const RESYNC_MS = 30_000;
const DEBOUNCE_MS = 250;

export interface RouteSyncOptions {
	fetch?: typeof fetch;
	log?: (message: string) => void;
}

export class RouteSync {
	/** name → the body we last PUT, so an unchanged route costs nothing */
	private registered = new Map<string, string>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private interval: ReturnType<typeof setInterval> | null = null;
	private off: (() => void) | null = null;
	private running = false;
	private again = false;
	private readonly fetch: typeof fetch;
	private readonly log: (message: string) => void;

	constructor(
		private supervisor: Supervisor,
		private proxy: ProxyConfig,
		opts: RouteSyncOptions = {},
	) {
		this.fetch = opts.fetch ?? fetch;
		this.log = opts.log ?? ((m) => console.warn(`proxy: ${m}`));
	}

	start() {
		this.off = this.supervisor.onChange(() => this.schedule());
		this.interval = setInterval(() => this.schedule(), RESYNC_MS);
		this.schedule();
	}

	async stop() {
		this.off?.();
		if (this.timer) clearTimeout(this.timer);
		if (this.interval) clearInterval(this.interval);
		this.timer = this.interval = null;
		// Leave nothing behind pointing at a node that is going away.
		await Promise.all([...this.registered.keys()].map((n) => this.remove(n)));
	}

	private schedule() {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.sync();
		}, DEBOUNCE_MS);
	}

	private headers() {
		return {
			"content-type": "application/json",
			...(this.proxy.token
				? { authorization: `Bearer ${this.proxy.token}` }
				: {}),
		};
	}

	private body(route: {
		hosts: string[];
		path: string | null;
		port: number;
		target: string | null;
	}) {
		return {
			host: route.hosts,
			...(route.path ? { path: route.path } : {}),
			to: route.target ?? `${this.proxy.host}:${route.port}`,
		};
	}

	async sync() {
		// One pass at a time; a change that lands mid-pass gets a second one.
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		try {
			const wanted = new Map<string, string>();
			for (const { name, route, up } of this.supervisor.routes()) {
				if (up) wanted.set(name, JSON.stringify(this.body(route)));
			}
			for (const name of [...this.registered.keys()]) {
				if (!wanted.has(name)) await this.remove(name);
			}
			for (const [name, body] of wanted) {
				if (this.registered.get(name) === body) continue;
				await this.put(name, body);
			}
		} finally {
			this.running = false;
			if (this.again) {
				this.again = false;
				this.schedule();
			}
		}
	}

	private async put(name: string, body: string) {
		try {
			const res = await this.fetch(
				`${this.proxy.url}/routes/${encodeURIComponent(name)}`,
				{ method: "PUT", headers: this.headers(), body },
			);
			if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
			this.registered.set(name, body);
		} catch (err) {
			// Not recorded, so the next pass tries again.
			this.log(
				`could not register '${name}': ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	private async remove(name: string) {
		try {
			const res = await this.fetch(
				`${this.proxy.url}/routes/${encodeURIComponent(name)}`,
				{ method: "DELETE", headers: this.headers() },
			);
			// 404 means it is already gone, which is what we wanted.
			if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
			this.registered.delete(name);
		} catch (err) {
			this.log(
				`could not remove '${name}': ${err instanceof Error ? err.message : err}`,
			);
		}
	}
}
