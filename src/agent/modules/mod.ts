import type { ModuleReport } from "../../modules/external.ts";
import type { ModuleHost } from "../../modules/host.ts";
import type { ModuleManifest } from "../../modules/manifest.ts";
import type { InboundRequest } from "../../proto/link.ts";
import { RemoteError } from "../../proto/link.ts";
import type {
	CaStatus,
	Container,
	HostFacts,
	ListeningPort,
	PiholeDetail,
	PiholeSummary,
	ProcessInfo,
	ProjectStatus,
	ProxmoxGuest,
	ProxmoxSummary,
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
	/**
	 * The hub's local CA, read live rather than captured at load time — it
	 * arrives in Welcome, after modules have already loaded once. Null until a
	 * hub has sent one, which is a fact about the fleet and not a failure.
	 * Absent entirely in a context nothing wired it into, which reads the same
	 * as "no CA yet".
	 */
	trustedCa?(): { pem: string; fingerprint: string } | null;
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
	proxmox?: ProxmoxSummary;
	guests?: ProxmoxGuest[];
	pihole?: PiholeSummary;
	piholeDetail?: PiholeDetail;
	ca?: CaStatus;
	/** installed modules' reports, keyed by module id — merged, not replaced */
	extras?: Record<string, ModuleReport>;
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
