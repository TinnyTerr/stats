import {
	collectPihole,
	PiholeUnavailable,
	piholeConfigured,
	setBlocking,
	usePiholeTransport,
} from "../../collect/pihole.ts";
import { MODULES } from "../../modules/manifest.ts";
import { RemoteError } from "../../proto/link.ts";
import type { PiholeBlockingParams } from "../../proto/messages.ts";
import type { NodeModule, NodeModuleContext } from "./mod.ts";
import { requireControl } from "./mod.ts";

/**
 * A Pi-hole, watched over its own HTTP API.
 *
 * PIHOLE_URL is the whole of the availability question: a node told about a
 * Pi-hole loads the module, and one that isn't doesn't. Whether that Pi-hole is
 * actually answering is a collection failure rather than an availability one —
 * it lands in `telemetry.errors` and shows on the node's card, which is where
 * "the DNS server is down" belongs. Dropping the module for it would hide the
 * one machine you most wanted to hear about.
 */

/** Points the collector's only reach at the host's gated fetch. */
function wire(ctx: NodeModuleContext) {
	usePiholeTransport({ fetch: (url, init) => ctx.host.fetch(url, init) });
}

export const piholeModule: NodeModule = {
	manifest: MODULES.pihole,

	async available(ctx) {
		wire(ctx);
		return piholeConfigured();
	},

	async collect() {
		return await collectPihole();
	},

	actions: {
		"pihole.blocking": async (req, ctx) => {
			requireControl(ctx);
			const p = (req.params ?? {}) as unknown as PiholeBlockingParams;
			try {
				return await setBlocking({
					blocking: p.blocking === true,
					seconds: typeof p.seconds === "number" ? p.seconds : null,
				});
			} catch (err) {
				if (err instanceof PiholeUnavailable) {
					throw new RemoteError("pihole_unavailable", err.message);
				}
				throw err;
			}
		},
	},
};
