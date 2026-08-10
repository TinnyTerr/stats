import {
	collectContainers,
	containerAction,
	DOCKER_SOCKET,
	DockerUnavailable,
	dockerAvailable,
	dockerUrl,
	useDockerTransport,
} from "../../collect/docker.ts";
import { MODULES } from "../../modules/manifest.ts";
import { RemoteError } from "../../proto/link.ts";
import type { ContainerActionParams } from "../../proto/messages.ts";
import type { NodeModule, NodeModuleContext } from "./mod.ts";
import { requireControl } from "./mod.ts";

/**
 * Containers, straight from the engine API. Everything this module does goes
 * through one unix socket, which is the whole of its `socket` grant — install
 * it on a host without docker and it reports unavailable rather than filling
 * telemetry.errors on every tick.
 */

/** Points the collector's transport at the host's gated socket. */
function wire(ctx: NodeModuleContext) {
	useDockerTransport((path, init) =>
		ctx.host.socket(DOCKER_SOCKET, dockerUrl(path), init),
	);
}

export const dockerModule: NodeModule = {
	manifest: MODULES.docker,

	async available(ctx) {
		wire(ctx);
		return await dockerAvailable();
	},

	async collect() {
		return { containers: await collectContainers() };
	},

	actions: {
		"container.action": async (req, ctx) => {
			requireControl(ctx);
			const p = (req.params ?? {}) as unknown as ContainerActionParams;
			try {
				return await containerAction(p.container, p.verb);
			} catch (err) {
				if (err instanceof DockerUnavailable) {
					throw new RemoteError("docker_unavailable", err.message);
				}
				throw err;
			}
		},
	},
};
