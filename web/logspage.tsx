import { useCallback, useEffect, useState } from "react";
import { HubAction } from "../src/proto/messages.ts";
import type { HubConnection } from "./link.ts";
import { Empty, ErrorNote, Pill } from "./ui.tsx";

/**
 * Lines services have pushed to POST /api/logs. Polled rather than streamed:
 * these are a handful a day, not a tail. A line that named a project shows it
 * as a chip that jumps to the projects page.
 */

interface ServiceLog {
	ts: number;
	source: string;
	level: string;
	message: string;
	project: string | null;
	nodeId: string | null;
}

const LEVELS = ["", "debug", "info", "warn", "error"];
const WINDOWS = [
	{ label: "1h", minutes: 60 },
	{ label: "24h", minutes: 1440 },
	{ label: "7d", minutes: 10080 },
];
const TONE: Record<string, "ok" | "warn" | "crit" | "info"> = {
	debug: "info",
	info: "ok",
	warn: "warn",
	error: "crit",
};

export function LogsPage({
	hub,
	onOpenProject,
}: {
	hub: HubConnection;
	onOpenProject: () => void;
}) {
	const [rows, setRows] = useState<ServiceLog[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [level, setLevel] = useState("");
	const [project, setProject] = useState("");
	const [source, setSource] = useState("");
	const [minutes, setMinutes] = useState(1440);

	const load = useCallback(() => {
		hub
			.request<ServiceLog[]>(HubAction.ServiceLogs, {
				minutes,
				level,
				project,
				source,
			})
			.then((r) => {
				setRows(r);
				setError(null);
			})
			.catch((e) => setError(e instanceof Error ? e.message : String(e)));
	}, [hub, minutes, level, project, source]);

	useEffect(() => {
		load();
		const t = setInterval(load, 5000);
		return () => clearInterval(t);
	}, [load]);

	return (
		<div className="stack">
			<div className="row">
				<input
					placeholder="source"
					value={source}
					onChange={(e) => setSource(e.target.value)}
				/>
				<input
					placeholder="project"
					value={project}
					onChange={(e) => setProject(e.target.value)}
				/>
				<select value={level} onChange={(e) => setLevel(e.target.value)}>
					{LEVELS.map((l) => (
						<option key={l} value={l}>
							{l || "any level"}
						</option>
					))}
				</select>
				<select
					value={minutes}
					onChange={(e) => setMinutes(Number(e.target.value))}
				>
					{WINDOWS.map((w) => (
						<option key={w.minutes} value={w.minutes}>
							{w.label}
						</option>
					))}
				</select>
			</div>
			{error && <ErrorNote>{error}</ErrorNote>}
			{rows.length ? (
				<ul className="events service-logs">
					{rows.map((r) => (
						<li key={`${r.ts}-${r.source}-${r.message}`}>
							<time>{new Date(r.ts).toLocaleString()}</time>
							<Pill tone={TONE[r.level] ?? "info"}>{r.level}</Pill>
							<strong>{r.source}</strong>
							{r.project && (
								<button
									type="button"
									className="chip"
									title={r.nodeId ? `on ${r.nodeId}` : "open projects"}
									onClick={onOpenProject}
								>
									{r.project}
									{r.nodeId ? ` @ ${r.nodeId}` : ""}
								</button>
							)}
							<span>{r.message}</span>
						</li>
					))}
				</ul>
			) : (
				<Empty>
					Nothing pushed yet. POST to /api/logs with a source and message.
				</Empty>
			)}
		</div>
	);
}
