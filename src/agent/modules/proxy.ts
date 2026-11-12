import {
	collectProxy,
	ProxyUnavailable,
	reloadProxy,
	removeProxyRoute,
} from "../../collect/proxy.ts";
import { MODULES } from "../../modules/manifest.ts";
import { RemoteError } from "../../proto/link.ts";
import type { ProxyRemoveParams } from "../../proto/messages.ts";
import type { NodeModule, NodeModuleContext } from "./mod.ts";
import { requireControl } from "./mod.ts";

/**
 * The reverse proxy in ../proxy, watched over its API. The endpoint is the
 * node's `proxy` config — the same one `RouteSync` registers project routes
 * with — so a node told about a proxy both feeds it and reports on it.
 *
 * Whether the proxy is answering is a collection failure, not an availability
 * one: a dead proxy is exactly the thing the card should say so about.
 */

function endpoint(ctx: NodeModuleContext) {
	const proxy = ctx.config.proxy;
	if (!proxy) throw new RemoteError("proxy_unavailable", "no proxy configured");
	return { url: proxy.url, token: proxy.token };
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (err instanceof ProxyUnavailable)
			throw new RemoteError("proxy_unavailable", err.message);
		throw err;
	}
}

export const proxyModule: NodeModule = {
	manifest: MODULES.proxy,

	async available(ctx) {
		return Boolean(ctx.config.proxy);
	},

	async collect(ctx) {
		return await collectProxy(
			(url, init) => ctx.host.fetch(url, init),
			endpoint(ctx),
		);
	},

	actions: {
		"proxy.reload": async (_req, ctx) => {
			requireControl(ctx);
			return await guarded(() =>
				reloadProxy((u, i) => ctx.host.fetch(u, i), endpoint(ctx)),
			);
		},

		"proxy.remove": async (req, ctx) => {
			requireControl(ctx);
			const p = (req.params ?? {}) as unknown as ProxyRemoveParams;
			return await guarded(() =>
				removeProxyRoute(
					(u, i) => ctx.host.fetch(u, i),
					endpoint(ctx),
					String(p.name ?? ""),
				),
			);
		},
	},
};
