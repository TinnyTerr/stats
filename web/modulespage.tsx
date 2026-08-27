import { useCallback, useEffect, useState } from "react";
import type {
	ModuleState,
	ModuleStatus,
	NodeModuleView,
} from "../src/hub/modules.ts";
import type { ModuleSet } from "../src/modules/manifest.ts";
import { PLATFORM_LABELS, type Platform } from "../src/modules/platform.ts";
import type { HubConnection } from "./link.ts";
import { ActionButton, Empty, ErrorNote, Pill } from "./ui.tsx";

/**
 * Managing the fleet's modules from the hub.
 *
 * The page's whole job is to keep two different things visibly apart: what the
 * hub *wants* and what a node is *running*. A dashboard that collapses those
 * into one checkbox is a dashboard that lies the moment a node is offline, or
 * refuses hub-directed modules, or is on a platform the module doesn't support
 * — all three of which are ordinary states, not errors.
 *
 * So every cell shows the node's reality and the hub's intent beside it, and
 * the states that mean "asked for, not running" each say why. See
 * src/hub/modules.ts for where those states are decided.
 */

const STATE_TEXT: Record<ModuleState, string> = {
	on: "on",
	off: "off",
	pending: "pending",
	refused: "refused",
	unsupported: "n/a",
	blocked: "blocked",
};

const STATE_HELP: Record<ModuleState, string> = {
	on: "running on this node",
	off: "not running, and nothing asked for it",
	pending:
		"the hub asked for this; the node applies it the next time it connects",
	refused:
		"the hub asked for this, but the node was not started with --allow-hub-modules — which a node running as root defaults to on",
	unsupported: "this module does not run on that platform",
	blocked: "switched off for the whole fleet in hub.json",
};

function stateTone(state: ModuleState) {
	if (state === "on") return "ok" as const;
	if (state === "refused") return "crit" as const;
	if (state === "pending") return "warn" as const;
	return "idle" as const;
}

function platformText(platforms: Platform[]): string {
	if (!platforms.length) return "any platform";
	return platforms.map((p) => PLATFORM_LABELS[p]).join(", ");
}

function ModuleRow({
	node,
	module,
	onSet,
}: {
	node: NodeModuleView;
	module: ModuleStatus;
	onSet: (wanted: boolean | null) => Promise<void>;
}) {
	// A module the fleet switched off can't be fixed from a node's row, and a
	// module this platform can't run can't be fixed at all — offering a button
	// for either would be offering something that does nothing.
	const settable = module.allowedByFleet && module.state !== "unsupported";

	return (
		<tr>
			<td>
				<span className="mono">{module.id}</span>
				{module.installed && (
					<Pill tone="info" title="installed from a git repository">
						installed
					</Pill>
				)}
			</td>
			<td className="dim">{platformText(module.platforms)}</td>
			<td>
				<Pill tone={stateTone(module.state)} title={STATE_HELP[module.state]}>
					{STATE_TEXT[module.state]}
				</Pill>
			</td>
			<td className="dim">
				{module.desired === null
					? "—"
					: module.desired
						? "wanted on"
						: "wanted off"}
			</td>
			<td className="right">
				{settable && (
					<>
						<ActionButton
							disabled={module.desired === true}
							onAction={() => onSet(true)}
							title={
								node.acceptsHubModules
									? "ask this node to load the module"
									: "this node does not accept hub-directed modules — it will show as refused"
							}
						>
							on
						</ActionButton>
						<ActionButton
							disabled={module.desired === false}
							onAction={() => onSet(false)}
							title="switch the module off on this node"
						>
							off
						</ActionButton>
						<ActionButton
							disabled={module.desired === null}
							onAction={() => onSet(null)}
							title="drop the hub's opinion and let the node decide"
						>
							clear
						</ActionButton>
					</>
				)}
			</td>
		</tr>
	);
}

function NodeModules({
	node,
	onSet,
}: {
	node: NodeModuleView;
	onSet: (moduleId: string, wanted: boolean | null) => Promise<void>;
}) {
	return (
		<section className="panel module-node">
			<header>
				<h3>{node.name}</h3>
				<Pill tone={node.online ? "ok" : "idle"}>
					{node.online ? "online" : "offline"}
				</Pill>
				<span className="dim">
					{node.platform ? PLATFORM_LABELS[node.platform] : "unknown platform"}
				</span>
				{!node.acceptsHubModules && (
					<Pill
						tone="warn"
						title="this node applies the hub's removals but not its additions — start it with --allow-hub-modules, or as root, to hand the hub both directions"
					>
						narrow only
					</Pill>
				)}
			</header>

			<div className="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Module</th>
							<th>Runs on</th>
							<th>State</th>
							<th>Hub wants</th>
							<th className="right">Set</th>
						</tr>
					</thead>
					<tbody>
						{node.modules.map((module) => (
							<ModuleRow
								key={module.id}
								node={node}
								module={module}
								onSet={(wanted) => onSet(module.id, wanted)}
							/>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

export function ModulesPage({ hub }: { hub: HubConnection }) {
	const [nodes, setNodes] = useState<NodeModuleView[]>([]);
	const [fleet, setFleet] = useState<ModuleSet>({});
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		try {
			const result = await hub.request<{
				nodes: NodeModuleView[];
				fleet: ModuleSet;
			}>("modules.fleet");
			setNodes(result.nodes);
			setFleet(result.fleet);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [hub]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const set = useCallback(
		async (nodeId: string, moduleId: string, wanted: boolean | null) => {
			const result = await hub.request<{
				nodeId: string;
				modules: ModuleStatus[];
				applied: boolean;
				refused?: string;
			}>("modules.set", { nodeId, modules: { [moduleId]: wanted } });

			// The hub already resolved the new rows; taking them from the reply
			// rather than refetching keeps the button's result and the table's
			// contents from disagreeing for a tick.
			setNodes((prev) =>
				prev.map((node) =>
					node.nodeId === result.nodeId
						? { ...node, modules: result.modules }
						: node,
				),
			);
			if (result.refused) setError(result.refused);
		},
		[hub],
	);

	const blocked = Object.entries(fleet)
		.filter(([, on]) => on === false)
		.map(([id]) => id);

	return (
		<div className="modules-page">
			<header className="page-head">
				<h2>Modules</h2>
				<span className="dim">
					The hub records what each node should run; the node reports what it
					actually is. Both are shown.
				</span>
				<div className="spacer" />
				<ActionButton onAction={refresh}>Refresh</ActionButton>
			</header>

			{error && <ErrorNote>{error}</ErrorNote>}

			{blocked.length > 0 && (
				<p className="banner">
					Switched off for the whole fleet in <code>hub.json</code>:{" "}
					<span className="mono">{blocked.join(", ")}</span>. No node can turn
					these on.
				</p>
			)}

			{loading && <Empty>Loading…</Empty>}
			{!loading && !nodes.length && (
				<Empty>No nodes have connected to this hub yet.</Empty>
			)}

			{nodes.map((node) => (
				<NodeModules
					key={node.nodeId}
					node={node}
					onSet={(moduleId, wanted) => set(node.nodeId, moduleId, wanted)}
				/>
			))}
		</div>
	);
}
