import { useEffect, useMemo, useRef, useState } from "react";
import { HubAction, type PacketRecord } from "../src/proto/messages.ts";
import type { HubConnection } from "./link.ts";
import { streamJson } from "./link.ts";
import { Empty, Pill } from "./ui.tsx";

/**
 * Every frame the hub has sent or received, decoded as far as the wire format
 * goes. The hub captures raw bytes at the socket boundary (src/hub/packets.ts)
 * so this shows exactly what crossed the wire, not what a peer's PeerLink made
 * of it — a malformed frame shows up here instead of just an error in a log
 * somewhere.
 */

const MAX_PACKETS = 1000;

const DIRECTION_LABEL: Record<PacketRecord["direction"], string> = {
	"node->hub": "node → hub",
	"hub->node": "hub → node",
	"browser->hub": "browser → hub",
	"hub->browser": "hub → browser",
};

function hexDump(base64: string): string {
	let bytes: string;
	try {
		bytes = atob(base64);
	} catch {
		return "(couldn't decode)";
	}
	const rows: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += 16) {
		const chunk = bytes.slice(offset, offset + 16);
		const hex = Array.from(chunk)
			.map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
			.join(" ");
		const ascii = Array.from(chunk)
			.map((c) => {
				const code = c.charCodeAt(0);
				return code >= 32 && code < 127 ? c : ".";
			})
			.join("");
		rows.push(
			`${offset.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${ascii}`,
		);
	}
	return rows.join("\n") || "(empty payload)";
}

export function PacketsPage({ hub }: { hub: HubConnection }) {
	const [packets, setPackets] = useState<PacketRecord[]>([]);
	const [paused, setPaused] = useState(false);
	const [filter, setFilter] = useState("");
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [detailView, setDetailView] = useState<"decoded" | "raw">("decoded");
	const [follow, setFollow] = useState(true);
	const pausedRef = useRef(paused);
	pausedRef.current = paused;
	const bottom = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const stream = hub.stream<null>(
			HubAction.PacketsTail,
			{ backlog: 500 },
			{
				onData: (payload, binary) => {
					if (binary || pausedRef.current) return;
					const record = streamJson<PacketRecord>(payload);
					setPackets((prev) => [...prev, record].slice(-MAX_PACKETS));
				},
			},
		);
		stream.ready.catch(() => {});
		return () => stream.end();
	}, [hub]);

	// `packets` is the trigger — every new batch should scroll — not a read.
	// biome-ignore lint/correctness/useExhaustiveDependencies: explained above
	useEffect(() => {
		if (follow) bottom.current?.scrollIntoView({ block: "end" });
	}, [packets, follow]);

	const filtered = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		if (!needle) return packets;
		return packets.filter(
			(p) =>
				p.type.toLowerCase().includes(needle) ||
				p.peer.toLowerCase().includes(needle) ||
				DIRECTION_LABEL[p.direction].includes(needle),
		);
	}, [packets, filter]);

	const selected = packets.find((p) => p.id === selectedId) ?? null;

	return (
		<div className="packets-page">
			<header className="page-head">
				<h2>Packets</h2>
				<span className="dim">
					Every frame the hub has sent or received since this tab opened.
					Nothing is persisted — reload and the log starts over.
				</span>
			</header>

			<div className="toolbar">
				<input
					type="text"
					placeholder="filter by type, peer or direction"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
				<button type="button" onClick={() => setPaused((p) => !p)}>
					{paused ? "Resume" : "Pause"}
				</button>
				<button type="button" onClick={() => setPackets([])}>
					Clear
				</button>
				<label className="check">
					<input
						type="checkbox"
						checked={follow}
						onChange={(event) => setFollow(event.target.checked)}
					/>
					<span>follow</span>
				</label>
				<span className="dim">
					{filtered.length} of {packets.length}
				</span>
			</div>

			<div className="packets-body">
				<div className="packets-list table-wrap">
					<table>
						<thead>
							<tr>
								<th>time</th>
								<th>direction</th>
								<th>peer</th>
								<th>type</th>
								<th className="right">corr</th>
								<th className="right">bytes</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{filtered.map((p) => (
								<tr
									key={p.id}
									className={`unit-row ${p.id === selectedId ? "expanded" : ""}`}
									onClick={() => {
										setSelectedId(p.id);
										setDetailView("decoded");
									}}
								>
									<td className="mono dim">
										{new Date(p.ts).toLocaleTimeString()}
									</td>
									<td>{DIRECTION_LABEL[p.direction]}</td>
									<td className="mono">{p.peer}</td>
									<td className="mono">{p.type}</td>
									<td className="right mono">{p.correlationId || "—"}</td>
									<td className="right mono">{p.bytes}</td>
									<td>
										<div className="row-actions">
											{p.compressed && <Pill tone="idle">gz</Pill>}
											{p.binary && <Pill tone="idle">bin</Pill>}
											{p.jsonError && <Pill tone="crit">bad json</Pill>}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					<div ref={bottom} />
					{!filtered.length && (
						<Empty>
							{packets.length
								? "Nothing matches that filter."
								: "Waiting for traffic…"}
						</Empty>
					)}
				</div>

				<aside className="packets-detail">
					{selected ? (
						<>
							<div className="panel-head">
								<h4>
									{selected.type}{" "}
									{selected.correlationId ? (
										<span className="dim">#{selected.correlationId}</span>
									) : null}
								</h4>
								<div className="toolbar">
									<button
										type="button"
										className={detailView === "decoded" ? "active" : ""}
										onClick={() => setDetailView("decoded")}
									>
										decoded
									</button>
									<button
										type="button"
										className={detailView === "raw" ? "active" : ""}
										onClick={() => setDetailView("raw")}
									>
										raw
									</button>
								</div>
							</div>
							<p className="dim">
								{DIRECTION_LABEL[selected.direction]} · {selected.peer} ·{" "}
								{selected.bytes} bytes
								{selected.compressed ? " · gzipped on the wire" : ""}
								{selected.truncated ? " · raw view truncated" : ""}
							</p>
							{detailView === "decoded" ? (
								selected.binary ? (
									<Empty>Binary payload — see raw.</Empty>
								) : selected.jsonError ? (
									<p className="error">{selected.jsonError}</p>
								) : (
									<pre className="code-editor mono">
										{JSON.stringify(selected.json, null, 2)}
									</pre>
								)
							) : (
								<pre className="code-editor mono">
									{hexDump(selected.rawBase64)}
								</pre>
							)}
						</>
					) : (
						<Empty>Select a frame to see its payload.</Empty>
					)}
				</aside>
			</div>
		</div>
	);
}
