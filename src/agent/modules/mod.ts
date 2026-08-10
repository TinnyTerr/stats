import type { ModuleHost } from "../../modules/host.ts";
import type { ModuleManifest } from "../../modules/manifest.ts";
import type { InboundRequest } from "../../proto/link.ts";
import { RemoteError } from "../../proto/link.ts";
import type {
	Container,
	HostFacts,
	ListeningPort,
	ProcessInfo,
	ProjectStatus,
	SystemdSummary,
	SystemdUnit,
	SystemStats,
} from "../../types.ts";
import type { AgentConfig } from "../config.ts";
import type { Supervisor } from "../supervisor.ts";
import type { TerminalManager } from "../terminal.ts";

/**
 * The node half of a module.
 *
 * A module contributes three things and nothing else: whether the host can
 * serve it at all, the slice of a telemetry frame it fills in, and the control
 * actions it owns. The agent knows how to run those three; it knows nothing
 * about docker, systemd or ptys, which is what makes them removable.
 */

export interface NodeModuleContext {
	/** the gated surface — see src/modules/host.ts */
	host: ModuleHost;
	config: AgentConfig;
	supervisor: Supervisor;
	terminals: TerminalManager;
	/** the node's own switch for anything that changes state */
	control: boolean;
}

/** The parts of a telemetry frame a module may fill in. */
export interface TelemetryParts {
	stats?: SystemStats;
	facts?: HostFacts;
	systemd?: SystemdSummary;
	units?: SystemdUnit[];
	containers?: Container[];
	processes?: ProcessInfo[];
	ports?: ListeningPort[];
	projects?: ProjectStatus[];
}

export type ModuleActionHandler = (
	req: InboundRequest,
	ctx: NodeModuleContext,
) => Promise<unknown>;

export interface NodeModule {
	manifest: ModuleManifest;
	/**
	 * Whether this host can serve the module right now — no docker socket, no
	 * docker. A module that reports false is dropped from the set the node
	 * announces, so the dashboard hides its tab instead of showing an empty one.
	 */
	available?(ctx: NodeModuleContext): Promise<boolean>;
	/** one module's slice of a telemetry frame; a throw lands in telemetry.errors */
	collect?(ctx: NodeModuleContext): Promise<TelemetryParts>;
	actions?: Record<string, ModuleActionHandler>;
}

/** Guard for the handlers that change something rather than report it. */
export function requireControl(ctx: NodeModuleContext) {
	if (!ctx.control) {
		throw new RemoteError(
			"forbidden",
			"control actions are disabled on this node",
		);
	}
}
