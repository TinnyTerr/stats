import { useEffect, useState } from "react";
import { HubAction } from "../src/proto/messages.ts";
import type { NodeSummary, Telemetry } from "../src/types.ts";
import type { HubConnection } from "./link.ts";
import { type LogTarget, ProjectsPanel } from "./panels.tsx";
import { ProjectsBuilder } from "./toolspage.tsx";
import { Dot, Empty } from "./ui.tsx";

/**
 * Projects, fleet-wide: what every node is running, then the builder for the
 * file that declares it. The live half used to be a tab in each node's drawer,
 * which made "is anything degraded?" a question you asked one node at a time.
 *
 * Full telemetry is only pushed for the node the drawer has open, so this
 * polls the hub's `node` action for the nodes that declare projects.
 */

const POLL_MS = 3000;

function NodeProjects({
	node,
	hub,
	openLogs,
}: {
	node: NodeSummary;
	hub: HubConnection;
	openLogs: (nodeId: string, context: LogTarget) => void;
}) {
	const [telemetry, setTelemetry] = useState<Telemetry | null>(null);

	useEffect(() => {
		let live = true;
		const load = () =>
			hub
				.request<{ telemetry: Telemetry | null }>(HubAction.Node, {
					nodeId: node.id,
				})
				.then((r) => live && setTelemetry(r.telemetry))
				.catch(() => {});
		load();
		const t = setInterval(load, POLL_MS);
		return () => {
			live = false;
			clearInterval(t);
		};
	}, [hub, node.id]);

	return (
		<section className="stack">
			<h3>
				<Dot tone={node.status === "online" ? "ok" : "crit"} /> {node.name}
			</h3>
			<ProjectsPanel
				node={node}
				telemetry={telemetry}
				hub={hub}
				go={(_tab, context) => context && openLogs(node.id, context)}
			/>
		</section>
	);
}

export function ProjectsPage({
	nodes,
	hub,
	openLogs,
}: {
	nodes: NodeSummary[];
	hub: HubConnection;
	openLogs: (nodeId: string, context: LogTarget) => void;
}) {
	const withProjects = nodes.filter((n) => n.projects?.total);

	return (
		<div className="wide-page">
			<header className="page-head">
				<h2>Projects</h2>
			</header>

			{withProjects.length ? (
				withProjects.map((node) => (
					<NodeProjects
						key={node.id}
						node={node}
						hub={hub}
						openLogs={openLogs}
					/>
				))
			) : (
				<Empty>
					No node is running projects. Add <code>/etc/stats/projects.json</code>{" "}
					on a host, or build one below.
				</Empty>
			)}

			<header className="page-head">
				<h2>Builder</h2>
				<span className="dim">
					Built here only — nothing is sent anywhere. Blank fields take the
					node's defaults and stay out of the file. Drop the result onto a node
					at <span className="mono">/etc/stats/projects.json</span>, or as a
					file under <span className="mono">/etc/stats/projects.d/</span>.
				</span>
			</header>
			<ProjectsBuilder />
		</div>
	);
}
