import {
	collectListeningPorts,
	collectProcesses,
} from "../../collect/processes.ts";
import { MODULES } from "../../modules/manifest.ts";
import type { NodeModule } from "./mod.ts";

/**
 * Two read-only modules that happen to share a collector file: the busiest
 * processes, and what is listening. Neither owns a control action — there is no
 * "kill this" in the protocol, on purpose.
 */

export const processesModule: NodeModule = {
	manifest: MODULES.processes,
	async collect() {
		return { processes: await collectProcesses() };
	},
};

export const portsModule: NodeModule = {
	manifest: MODULES.ports,
	async collect() {
		return { ports: await collectListeningPorts() };
	},
};
