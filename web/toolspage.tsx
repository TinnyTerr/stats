import { useState } from "react";
import type { CaIssueResult } from "../src/proto/messages.ts";
import type { HubConnection } from "./link.ts";
import { ActionButton, ErrorNote } from "./ui.tsx";

/**
 * Two things a fleet operator wants without touching a shell: a projects.json
 * to paste onto a node, and a cert signed by the fleet's own CA (see
 * src/hub/ca.ts). Neither writes anything — the projects text is local to
 * this tab, dropped the moment it's closed, and a node's real projects file
 * only ever comes from src/agent/projects.ts reading disk. The cert side asks
 * the hub to sign, but the hub hands the leaf key back and keeps no copy —
 * this page is the only place it's ever shown.
 */

const TEMPLATE = `{
  "$schema": "/schema/projects.schema.json",
  "version": 1,
  "projects": [
    {
      "id": "example",
      "name": "Example",
      "cwd": "/opt/example",
      "processes": [
        {
          "id": "web",
          "command": ["bun", "run", "start"]
        }
      ]
    }
  ]
}
`;

function ProjectsEditor() {
	const [text, setText] = useState(TEMPLATE);
	const [error, setError] = useState<string | null>(null);

	const validate = (value: string) => {
		try {
			JSON.parse(value);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const copy = async () => {
		await navigator.clipboard.writeText(text);
	};

	const download = () => {
		const blob = new Blob([text], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "projects.json";
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<section className="panel">
			<header className="panel-head">
				<h4>Projects file</h4>
				<span className="dim">
					Edited here only — nothing is sent anywhere. Copy this onto a node at{" "}
					<span className="mono">/etc/stats/projects.json</span>, or a file
					under <span className="mono">/etc/stats/projects.d/</span>.
				</span>
			</header>

			{error && <ErrorNote>{error}</ErrorNote>}

			<textarea
				className="code-editor mono"
				spellCheck={false}
				rows={20}
				value={text}
				onChange={(event) => {
					setText(event.target.value);
					validate(event.target.value);
				}}
			/>

			<div className="toolbar" style={{ marginTop: 10 }}>
				<button type="button" onClick={copy}>
					Copy
				</button>
				<button type="button" onClick={download}>
					Download
				</button>
				<button type="button" onClick={() => setText(TEMPLATE)}>
					Reset
				</button>
			</div>
		</section>
	);
}

function CertIssuer({ hub }: { hub: HubConnection }) {
	const [commonName, setCommonName] = useState("");
	const [sans, setSans] = useState("");
	const [days, setDays] = useState(825);
	const [issued, setIssued] = useState<CaIssueResult | null>(null);

	const issue = async () => {
		const result = await hub.request<CaIssueResult>("ca.issue", {
			commonName,
			sans: sans
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
			days,
		});
		setIssued(result);
	};

	return (
		<section className="panel">
			<header className="panel-head">
				<h4>Generate a certificate</h4>
				<span className="dim">
					Signed by the fleet's own CA — the same one nodes trust in{" "}
					<span className="mono">src/agent/modules/ca.ts</span>. The key is
					shown once and kept nowhere but here.
				</span>
			</header>

			<div className="toolbar">
				<input
					type="text"
					placeholder="common name, e.g. grafana.internal"
					value={commonName}
					onChange={(event) => setCommonName(event.target.value)}
				/>
				<input
					type="text"
					placeholder="extra SANs, comma-separated"
					value={sans}
					onChange={(event) => setSans(event.target.value)}
				/>
				<input
					type="number"
					min={1}
					max={3650}
					value={days}
					title="days valid"
					onChange={(event) => setDays(Number(event.target.value) || 825)}
					style={{ width: 90 }}
				/>
				<ActionButton
					disabled={!commonName.trim()}
					onAction={issue}
					title="ask the hub to sign a new leaf cert"
				>
					Generate
				</ActionButton>
			</div>

			{issued && (
				<div className="stack" style={{ marginTop: 12 }}>
					<div>
						<div className="panel-head">
							<h4>Certificate</h4>
							<button
								type="button"
								onClick={() => navigator.clipboard.writeText(issued.cert)}
							>
								Copy
							</button>
						</div>
						<textarea
							className="code-editor mono"
							spellCheck={false}
							rows={10}
							readOnly
							value={issued.cert}
						/>
					</div>
					<div>
						<div className="panel-head">
							<h4>Private key</h4>
							<button
								type="button"
								onClick={() => navigator.clipboard.writeText(issued.key)}
							>
								Copy
							</button>
						</div>
						<textarea
							className="code-editor mono"
							spellCheck={false}
							rows={8}
							readOnly
							value={issued.key}
						/>
					</div>
					<div>
						<div className="panel-head">
							<h4>Fleet CA cert</h4>
							<span className="dim">
								Append this if the service needs the whole chain.
							</span>
							<button
								type="button"
								onClick={() => navigator.clipboard.writeText(issued.caCert)}
							>
								Copy
							</button>
						</div>
						<textarea
							className="code-editor mono"
							spellCheck={false}
							rows={8}
							readOnly
							value={issued.caCert}
						/>
					</div>
				</div>
			)}
		</section>
	);
}

export function ToolsPage({ hub }: { hub: HubConnection }) {
	return (
		<div className="modules-page">
			<header className="page-head">
				<h2>Tools</h2>
				<span className="dim">
					Local scratch space — nothing on this page touches a node's real
					files.
				</span>
			</header>

			<ProjectsEditor />
			<CertIssuer hub={hub} />
		</div>
	);
}
