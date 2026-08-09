import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import React, { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { NodeAction } from "../src/proto/messages.ts";
import type { NodeSummary, Telemetry } from "../src/types.ts";
import { type HubConnection, streamJson } from "./link.ts";
import { Empty, ErrorNote } from "./ui.tsx";

/**
 * A real shell in the browser. Keystrokes go out as binary stream frames and
 * the pty's bytes come back the same way, so xterm.js gets exactly what the
 * shell wrote — colours, cursor moves, curses apps and all.
 */

interface Session {
	where: { projectId?: string; container?: string };
	key: number;
}

export function TerminalPanel({
	node,
	telemetry,
	hub,
}: {
	node: NodeSummary;
	telemetry: Telemetry | null;
	hub: HubConnection;
}) {
	const [session, setSession] = useState<Session | null>(null);
	const [target, setTarget] = useState("host");
	const allowed = node.capabilities?.terminal ?? false;

	if (!allowed) {
		return (
			<Empty>
				Terminals are switched off for this node. Start it without{" "}
				<code>--no-terminal</code>, and leave <code>terminal</code> enabled in
				the hub config.
			</Empty>
		);
	}

	if (node.status !== "online") return <Empty>This node is offline.</Empty>;

	const containers =
		telemetry?.containers.filter((c) => c.state === "running") ?? [];
	const projects = telemetry?.projects ?? [];

	const open = () => {
		const where: Session["where"] = {};
		if (target.startsWith("project:")) where.projectId = target.slice(8);
		else if (target.startsWith("container:"))
			where.container = target.slice(10);
		setSession({ where, key: Date.now() });
	};

	return (
		<div className="terminal-panel">
			<div className="toolbar">
				<select
					value={target}
					onChange={(event) => setTarget(event.target.value)}
				>
					<option value="host">host shell</option>
					{projects.map((project) => (
						<option key={project.id} value={`project:${project.id}`}>
							in project: {project.name}
						</option>
					))}
					{containers.map((container) => (
						<option key={container.id} value={`container:${container.name}`}>
							in container: {container.name}
						</option>
					))}
				</select>
				<button type="button" onClick={open}>
					{session ? "New session" : "Open shell"}
				</button>
				{session && (
					<button type="button" onClick={() => setSession(null)}>
						Close
					</button>
				)}
				<div className="spacer" />
				<span className="dim">running as the user the node runs as</span>
			</div>

			{session ? (
				<TerminalView
					key={session.key}
					nodeId={node.id}
					hub={hub}
					where={session.where}
				/>
			) : (
				<Empty>No session open.</Empty>
			)}
		</div>
	);
}

function TerminalView({
	nodeId,
	hub,
	where,
}: {
	nodeId: string;
	hub: HubConnection;
	where: { projectId?: string; container?: string };
}) {
	const host = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);

	useEffect(() => {
		if (!host.current) return;

		const term = new Terminal({
			fontFamily:
				'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
			fontSize: 13,
			cursorBlink: true,
			convertEol: false,
			scrollback: 5000,
			theme: {
				background: "#0d1117",
				foreground: "#d7dce3",
				cursor: "#58a6ff",
				selectionBackground: "#264f78",
			},
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host.current);
		fit.fit();

		let sessionId: string | null = null;
		let disposed = false;

		const stream = hub.stream<{
			sessionId: string;
			pid: number;
			shell: string;
		}>(
			NodeAction.TerminalOpen,
			{ nodeId, cols: term.cols, rows: term.rows, ...where },
			{
				onData: (payload, binary) => {
					if (binary) {
						term.write(payload);
						return;
					}
					// The node's only JSON frame on this stream is the exit notice.
					const event = streamJson<{ message?: string }>(payload);
					if (event.message) term.write(event.message);
				},
				onEnd: (err) => {
					if (err) setError(err.message);
					else setInfo("session closed");
				},
			},
		);

		stream.ready
			.then((opened) => {
				sessionId = opened.sessionId;
				setInfo(`${opened.shell} · pid ${opened.pid}`);
				term.focus();
			})
			.catch((err: Error) => {
				setError(err.message);
				term.write(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`);
			});

		const input = term.onData((data) =>
			stream.bytes(new TextEncoder().encode(data)),
		);
		const binaryInput = term.onBinary((data) => {
			const bytes = new Uint8Array(data.length);
			for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 255;
			stream.bytes(bytes);
		});

		// Resize is its own control request: the pty needs to hear about it out of
		// band, not as keystrokes in the byte stream.
		const pushResize = () => {
			if (!sessionId || disposed) return;
			hub
				.request(NodeAction.TerminalResize, {
					nodeId,
					sessionId,
					cols: term.cols,
					rows: term.rows,
				})
				.catch(() => {});
		};
		const resizeHandler = term.onResize(pushResize);

		const observer = new ResizeObserver(() => {
			try {
				fit.fit();
			} catch {
				// the pane is hidden; the next fit will land
			}
		});
		observer.observe(host.current);

		return () => {
			disposed = true;
			observer.disconnect();
			input.dispose();
			binaryInput.dispose();
			resizeHandler.dispose();
			if (sessionId) {
				hub
					.request(NodeAction.TerminalClose, { nodeId, sessionId })
					.catch(() => {});
			}
			stream.end();
			term.dispose();
		};
	}, [hub, nodeId, where.projectId, where.container]);

	return (
		<div className="terminal-frame">
			{error && <ErrorNote>{error}</ErrorNote>}
			{!error && info && <p className="dim terminal-info">{info}</p>}
			<div className="xterm-host" ref={host} />
		</div>
	);
}
