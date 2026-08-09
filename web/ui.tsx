import React from "react";
import type { HostFacts } from "../src/types.ts";
import { distro, pct, type Tone, usageTone } from "./format.ts";

/** Shared presentational pieces. Nothing here fetches or holds app state. */

export function Dot({ tone, title }: { tone: Tone; title?: string }) {
	return <span className={`dot ${tone}`} title={title} />;
}

export function Pill({
	tone = "idle",
	children,
	title,
}: {
	tone?: Tone;
	children: React.ReactNode;
	title?: string;
}) {
	return (
		<span className={`pill ${tone}`} title={title}>
			{children}
		</span>
	);
}

export function Meter({
	value,
	label,
	detail,
}: {
	value: number | null;
	label: string;
	detail?: string;
}) {
	return (
		<div className="meter">
			<div className="meter-head">
				<span className="meter-label">{label}</span>
				<span className="meter-value">{pct(value)}</span>
			</div>
			<div className="meter-track">
				<div
					className={`meter-fill ${usageTone(value)}`}
					style={{ width: `${Math.min(100, (value ?? 0) * 100)}%` }}
				/>
			</div>
			{detail && <div className="meter-detail">{detail}</div>}
		</div>
	);
}

/** Dependency-free sparkline; history comes back as plain numbers. */
export function Sparkline({
	points,
	height = 34,
	tone = "ok",
}: {
	points: number[];
	height?: number;
	tone?: Tone;
}) {
	if (points.length < 2)
		return <div className="spark empty" style={{ height }} />;
	const max = Math.max(...points, 0.01);
	const step = 100 / (points.length - 1);
	const line = points
		.map(
			(p, i) =>
				`${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${(100 - (p / max) * 100).toFixed(2)}`,
		)
		.join(" ");
	// Close the path back along the baseline for the fill underneath.
	const area = `${line} L100,100 L0,100 Z`;

	return (
		<svg
			className={`spark ${tone}`}
			viewBox="0 0 100 100"
			preserveAspectRatio="none"
			style={{ height }}
			aria-hidden="true"
		>
			<path className="spark-area" d={area} />
			<path className="spark-line" d={line} vectorEffect="non-scaling-stroke" />
		</svg>
	);
}

export function Stat({
	label,
	value,
	title,
}: {
	label: string;
	value: React.ReactNode;
	title?: string;
}) {
	return (
		<div className="stat" title={title}>
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}

export function Empty({ children }: { children: React.ReactNode }) {
	return <p className="empty-state">{children}</p>;
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
	return <p className="error">{children}</p>;
}

/** The distro chip: the one place a node's identity is stated in its own colours. */
export function DistroChip({
	facts,
	full = false,
}: {
	facts: HostFacts | null;
	full?: boolean;
}) {
	const style = distro(facts);
	if (!style) return null;
	return (
		<span
			className="distro"
			style={{ "--distro-accent": style.accent } as React.CSSProperties}
			title={style.full}
		>
			{full ? style.full : style.label}
		</span>
	);
}

/** A button that reports what it's doing, and what went wrong if it did. */
export function ActionButton({
	onAction,
	children,
	disabled,
	danger,
	title,
}: {
	onAction: () => Promise<unknown>;
	children: React.ReactNode;
	disabled?: boolean;
	danger?: boolean;
	title?: string;
}) {
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	return (
		<button
			type="button"
			className={`action ${danger ? "danger" : ""} ${error ? "failed" : ""}`}
			disabled={busy || disabled}
			title={error ?? title}
			onClick={async (event) => {
				event.stopPropagation();
				setBusy(true);
				setError(null);
				try {
					await onAction();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			}}
		>
			{busy ? "…" : children}
		</button>
	);
}

/** Table with a sticky head; every panel's data is tabular. */
export function DataTable({
	columns,
	children,
	className,
}: {
	columns: string[];
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={`table-wrap ${className ?? ""}`}>
			<table>
				<thead>
					<tr>
						{columns.map((column) => (
							<th key={column}>{column}</th>
						))}
					</tr>
				</thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}
