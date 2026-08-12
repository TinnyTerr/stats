import {
	collectProxmox,
	guestAction,
	ProxmoxUnavailable,
	proxmoxAvailable,
	useProxmoxTransport,
} from "../../collect/proxmox.ts";
import { MODULES } from "../../modules/manifest.ts";
import { RemoteError } from "../../proto/link.ts";
import type { ProxmoxActionParams } from "../../proto/messages.ts";
import type { NodeModule, NodeModuleContext } from "./mod.ts";
import { requireControl } from "./mod.ts";

/**
 * Guests on a Proxmox VE host. On the hypervisor itself this needs nothing
 * configured — `pvesh` is already authenticated over the local socket — and
 * anywhere else it wants PROXMOX_URL and PROXMOX_TOKEN. A host that is neither
 * reports unavailable, so the guests tab never appears on an ordinary server.
 */

/** Points the collector's two reaches at the host's gated versions. */
function wire(ctx: NodeModuleContext) {
	useProxmoxTransport({
		exec: (argv) => ctx.host.exec(argv),
		fetch: (url, init) => ctx.host.fetch(url, init),
	});
}

export const proxmoxModule: NodeModule = {
	manifest: MODULES.proxmox,

	async available(ctx) {
		wire(ctx);
		return await proxmoxAvailable();
	},

	async collect() {
		return await collectProxmox();
	},

	actions: {
		"guest.action": async (req, ctx) => {
			requireControl(ctx);
			const p = (req.params ?? {}) as unknown as ProxmoxActionParams;
			try {
				return await guestAction({
					node: String(p.node ?? ""),
					vmid: Number(p.vmid),
					type: p.type,
					verb: p.verb,
				});
			} catch (err) {
				if (err instanceof ProxmoxUnavailable) {
					throw new RemoteError("proxmox_unavailable", err.message);
				}
				throw err;
			}
		},
	},
};
