import type React from "react";
import type {
	ExternalManifest,
	ModuleFormat,
	ModuleHeadline,
	ModuleReport,
	ModuleValue,
} from "../src/modules/external.ts";
import type { NodeSummary } from "../src/types.ts";
import {
	ago,
	bytes,
	clock,
	duration,
	pct,
	rate,
	readyTone,
	type Tone,
	usageTone,
} from "./format.ts";
import type { CardFace, ModuleTab, UiModule } from "./modules.tsx";
import type { PanelProps } from "./panels.tsx";
import { DataTable, Empty, Meter, Pill, Tile } from "./ui.tsx";

/**
 * The dashboard half of an installed module.
 *
 * There is no code here from the module itself, and there deliberately can't
 * be: a page that ran a third party's script would be promising something much
 * larger than "you installed this on your own server". What arrives instead is
 * a declaration — these columns, these tiles, this meter — and this file is the
 * one renderer that draws all of them.
 *
 * The trade shows up as a ceiling: an installed module gets a table and a card
 * face, and anything that wants a bespoke widget belongs in web/modules.tsx as
 * a builtin.
 */

/* ---------- values ---------- */

function formatValue(
	value: ModuleValue | undefined,
	format: ModuleFormat = "text",
): string {
	if (value === undefined || value === null) return "—";
	if (typeof value === "boolean") return value ? "yes" : "no";

	const numeric = typeof value === "number" ? value : Number(value);
	switch (format) {
		case "number":
			return typeof value === "number" ? value.toLocaleString() : String(value);
		case "percent":
			return pct(Number.isFinite(numeric) ? numeric : null);
		case "bytes":
			return bytes(Number.isFinite(numeric) ? numeric : null);
		case "rate":
			return rate(Number.isFinite(numeric) ? numeric : null);
		case "duration":
			return duration(Number.isFinite(numeric) ? numeric : null);
		case "time":
			return clock(Number.isFinite(numeric) ? numeric : null);
		case "ago":
			return ago(Number.isFinite(numeric) ? numeric : null);
		default:
			return String(value);
	}
}

/**
 * The words a module is likely to use for "this thing is fine" and "it isn't".
 * A module wanting a colour it can control returns one of these; anything else
 * renders as a neutral pill rather than being guessed at.
 */
const OK_WORDS = new Set([
	"ok",
	"up",
	"online",
	"running",
	"healthy",
	"active",
	"ready",
	"success",
	"true",
]);
const CRIT_WORDS = new Set([
	"error",
	"failed",
	"failing",
	"down",
	"offline",
	"unhealthy",
	"crit",
	"critical",
	"false",
]);
const WARN_WORDS = new Set([
	"warn",
	"warning",
	"degraded",
	"pending",
	"starting",
	"stale",
	"unknown",
]);

function stateTone(value: ModuleValue | undefined): Tone {
	if (value === null || value === undefined) return "idle";
	if (typeof value === "boolean") return value ? "ok" : "crit";
	const word = String(value).toLowerCase();
	if (OK_WORDS.has(word)) return "ok";
	if (CRIT_WORDS.has(word)) return "crit";
	if (WARN_WORDS.has(word)) return "warn";
	return "idle";
}

function number(value: ModuleValue | undefined): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/* ---------- the tab ---------- */

function ExternalPanel({
	manifest,
	telemetry,
	node,
}: PanelProps & { manifest: ExternalManifest }) {
	const spec = manifest.tab;
	const report: ModuleReport | undefined = telemetry?.extras?.[manifest.id];

	if (!spec) return null;
	if (!report || !report.rows.length) {
		return (
			<Empty>
				{spec.empty ??
					(telemetry
						? `${manifest.label} reported nothing this tick.`
						: `Waiting for ${node.name} to report.`)}
			</Empty>
		);
	}

	return (
		<div className="stack">
			{report.detail && <p className="dim">{report.detail}</p>}
			<DataTable
				columns={spec.columns.map((column) => ({
					label: column.label,
					align: column.align,
				}))}
			>
				{report.rows.map((row, index) => (
					// Rows are whatever the module sent; there is no id to key on, and
					// the list is replaced wholesale on every frame anyway.
					// biome-ignore lint/suspicious/noArrayIndexKey: no stable row identity
					<tr key={index}>
						{spec.columns.map((column) => {
							const value = row[column.key];
							return (
								<td
									key={column.key}
									className={column.align === "right" ? "right" : undefined}
								>
									{column.format === "state" ? (
										<Pill tone={stateTone(value)}>
											{formatValue(value, "text")}
										</Pill>
									) : (
										`${formatValue(value, column.format)}${column.suffix ?? ""}`
									)}
								</td>
							);
						})}
					</tr>
				))}
			</DataTable>
		</div>
	);
}

/* ---------- the card face ---------- */

function ExternalFace({
	manifest,
	report,
}: {
	manifest: ExternalManifest;
	report: ModuleHeadline;
}) {
	const spec = manifest.face;
	if (!spec) return null;
	const values = report.values ?? {};

	const meter = spec.meter;
	const meterValue = meter
		? (() => {
				const numerator = number(values[meter.value]);
				if (numerator === null) return null;
				if (!meter.of) return numerator;
				const denominator = number(values[meter.of]);
				return denominator ? numerator / denominator : null;
			})()
		: null;

	return (
		<>
			{spec.tiles?.length ? (
				<div className="metrics">
					{spec.tiles.map((tile) => (
						<Tile
							key={tile.value}
							label={tile.label}
							value={`${formatValue(values[tile.value], tile.format)}${tile.suffix ?? ""}`}
							tone={
								tile.critWhenSet && number(values[tile.value])
									? "crit"
									: undefined
							}
						/>
					))}
				</div>
			) : null}

			{meter ? (
				<Meter
					value={meterValue}
					label={meter.label}
					// A module's own verdict wins over the shape of the bar: it knows
					// why 60% is fine today and wasn't yesterday.
					tone={
						report.status === "crit"
							? "crit"
							: report.status === "warn"
								? "warn"
								: meter.good === "low"
									? usageTone(meterValue)
									: readyTone(meterValue)
					}
					detail={meter.detail ?? report.detail ?? undefined}
				/>
			) : null}

			{spec.facts?.length ? (
				<dl className="facts">
					{spec.facts.map((fact) => (
						<div key={fact.value}>
							<dt>{fact.label}</dt>
							<dd>{formatValue(values[fact.value], fact.format)}</dd>
						</div>
					))}
				</dl>
			) : null}
		</>
	);
}

/* ---------- registration ---------- */

/**
 * Turns a node's declared manifests into the same {@link UiModule} shape the
 * builtins register, so `tabsFor` and `facesFor` don't learn that some of their
 * entries came off the wire.
 */
export function externalUiModules(node: NodeSummary): UiModule[] {
	return (node.capabilities?.externals ?? []).map((manifest) => {
		const tab: ModuleTab | undefined = manifest.tab
			? {
					id: manifest.tab.id ?? manifest.id,
					label: manifest.tab.label ?? manifest.label.toLowerCase(),
					render: (props: PanelProps) => (
						<ExternalPanel {...props} manifest={manifest} />
					),
					badge: (summary: NodeSummary) => {
						const status = summary.extras?.[manifest.id]?.status;
						return status === "warn" || status === "crit";
					},
				}
			: undefined;

		const faces: CardFace[] = manifest.face
			? [
					{
						id: manifest.id,
						label: manifest.face.label ?? manifest.label,
						module: manifest.id,
						available: ({ node: summary }) =>
							Boolean(summary.extras?.[manifest.id]),
						render: ({ node: summary }): React.ReactNode => (
							<ExternalFace
								manifest={manifest}
								report={summary.extras[manifest.id]!}
							/>
						),
					},
				]
			: [];

		return { id: manifest.id, tab, faces };
	});
}
