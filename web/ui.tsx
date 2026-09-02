import React from "react";
import type { HostFacts } from "../src/types.ts";
import { distro, pct, type Tone, usageTone } from "./format.ts";
import { niceMax } from "./history.ts";

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
	format = pct,
	tone,
}: {
	value: number | null;
	label: string;
	detail?: string;
	/** how the 0..1 value reads out; temperatures aren't percentages */
	format?: (value: number | null) => string;
	/**
	 * Colour for the fill. Defaults to reading the bar as pressure on a resource,
	 * which is wrong for any meter where full is the healthy end — those pass
	 * `readyTone(value)` or a tone of their own.
	 */
	tone?: Tone;
}) {
	return (
		<div className="meter">
			<div className="meter-head">
				<span className="meter-label">{label}</span>
				<span className="meter-value">{format(value)}</span>
			</div>
			<div className="meter-track">
				<div
					className={`meter-fill ${tone ?? usageTone(value)}`}
					style={{ width: `${Math.min(100, (value ?? 0) * 100)}%` }}
				/>
			</div>
			{detail && <div className="meter-detail">{detail}</div>}
		</div>
	);
}

/**
 * A counted thing, sized to sit in the same row as a {@link Meter}: the card
 * faces swap between the two, and a face that changed the row height would make
 * the whole grid jump every time it came round.
 */
export function Tile({
	label,
	value,
	detail,
	tone,
}: {
	label: string;
	value: React.ReactNode;
	detail?: string;
	tone?: Tone;
}) {
	return (
		<div className="tile">
			<span className="tile-label">{label}</span>
			<span className={`tile-value ${tone ?? ""}`}>{value}</span>
			<span className="tile-detail">{detail ?? ""}</span>
		</div>
	);
}

/** Dependency-free sparkline; history comes back as plain numbers. */
export function Sparkline({
	points,
	height = 28,
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
	/** a caption, or one that says which edge its column reads against */
	columns: (string | { label: string; align?: "left" | "right" })[];
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={`table-wrap ${className ?? ""}`}>
			<table>
				<thead>
					<tr>
						{columns.map((column) => {
							const { label, align } =
								typeof column === "string"
									? { label: column, align: "left" }
									: column;
							return (
								<th
									key={label}
									className={align === "right" ? "right" : undefined}
								>
									{label}
								</th>
							);
						})}
					</tr>
				</thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}

/* ---------- charts ---------- */

export interface ChartSeries {
	id: string;
	label: string;
	/** one value per x position; null is a gap, not a zero */
	values: (number | null)[];
	/** the series colour, as a CSS value — a var() reference in practice */
	color: string;
}

/** Pixels reserved around the plot for the two axes. */
const PAD = { left: 58, right: 10, top: 10, bottom: 26 };

/**
 * A time series, drawn as SVG at real pixel coordinates.
 *
 * Not a scaled-up {@link Sparkline}: a sparkline stretches a 0..100 viewBox to
 * whatever width it lands in, which is fine for a shape with no axes and wrong
 * the moment there is text or a 2px stroke in the picture. So the chart
 * measures its own box and lays itself out in it, which is also what lets the
 * crosshair map a pointer back onto a sample.
 *
 * One value scale per chart, always. Two measures that don't share units are
 * two charts — the alignment of a second y-axis is arbitrary, and a reader
 * takes it for a correlation.
 */
export function Chart({
	x,
	series,
	format,
	max,
	height = 150,
	label,
}: {
	/** timestamps, one per sample, ascending */
	x: number[];
	series: ChartSeries[];
	/** how a y value reads out, in the tooltip and on the axis */
	format: (value: number) => string;
	/** a fixed ceiling — percentages want 1, so the axis doesn't rescale */
	max?: number;
	height?: number;
	/** what is plotted; a single series needs no legend because of this */
	label: string;
}) {
	const host = React.useRef<HTMLDivElement>(null);
	const [width, setWidth] = React.useState(560);
	const [hover, setHover] = React.useState<number | null>(null);

	// The chart is laid out in pixels, so it has to know how many it got.
	React.useEffect(() => {
		const node = host.current;
		if (!node) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setWidth(Math.max(240, entry.contentRect.width));
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	const plotW = Math.max(10, width - PAD.left - PAD.right);
	const plotH = Math.max(10, height - PAD.top - PAD.bottom);

	const peak = React.useMemo(() => {
		if (max != null) return max;
		let found = 0;
		for (const line of series)
			for (const value of line.values)
				if (value != null && value > found) found = value;
		return niceMax(found);
	}, [series, max]);

	if (x.length < 2)
		return (
			<div className="chart">
				<div className="chart-head">
					<span className="chart-label">{label}</span>
				</div>
				<div className="chart-empty" style={{ height }}>
					Not enough history yet.
				</div>
			</div>
		);

	const px = (index: number) => PAD.left + (index / (x.length - 1)) * plotW;
	const py = (value: number) =>
		PAD.top + plotH - Math.min(1, Math.max(0, value / peak)) * plotH;

	// A gap in the data breaks the path rather than being drawn through: a node
	// that was offline for an hour did not hold a steady line across it.
	const path = (values: (number | null)[]) => {
		let d = "";
		let pen = false;
		values.forEach((value, index) => {
			if (value == null) {
				pen = false;
				return;
			}
			d += `${pen ? "L" : "M"}${px(index).toFixed(1)},${py(value).toFixed(1)}`;
			pen = true;
		});
		return d;
	};

	// The wash under a line only makes sense when there is one line to be under.
	const area = (values: (number | null)[]) => {
		const first = values.findIndex((value) => value != null);
		if (first === -1) return "";
		let last = values.length - 1;
		while (last > first && values[last] == null) last--;
		const base = PAD.top + plotH;
		return `${path(values)} L${px(last).toFixed(1)},${base} L${px(first).toFixed(1)},${base} Z`;
	};

	const ticks = [0, peak / 2, peak];
	const last = (line: ChartSeries) => {
		for (let i = line.values.length - 1; i >= 0; i--) {
			const value = line.values[i];
			if (value != null) return { index: i, value };
		}
		return null;
	};

	const time = (ts: number) =>
		new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

	const at = hover != null ? Math.min(hover, x.length - 1) : null;
	const move = (clientX: number) => {
		const box = host.current?.getBoundingClientRect();
		if (!box) return;
		const ratio = (clientX - box.left - PAD.left) / plotW;
		setHover(
			Math.min(x.length - 1, Math.max(0, Math.round(ratio * (x.length - 1)))),
		);
	};

	return (
		<div className="chart" ref={host}>
			<div className="chart-head">
				<span className="chart-label">{label}</span>
				{series.length > 1 && (
					<div className="chart-legend">
						{series.map((line) => (
							<span key={line.id}>
								<i style={{ background: line.color }} />
								{line.label}
							</span>
						))}
					</div>
				)}
			</div>

			<div className="chart-plot">
				<svg
					viewBox={`0 0 ${width} ${height}`}
					width="100%"
					height={height}
					role="img"
					aria-label={`${label}, ${x.length} samples from ${time(x[0] ?? 0)} to ${time(x[x.length - 1] ?? 0)}`}
					// The plot takes focus so the arrow keys can walk the crosshair
					// along it. A picture is not an interactive control and normally
					// has no business in the tab order, but a chart whose values are
					// only reachable by pointer is a chart some readers cannot read at
					// all — and the History panel's table view is the other half of
					// that answer, not a substitute for this half.
					// biome-ignore lint/a11y/noNoninteractiveTabindex: explained above
					tabIndex={0}
					onPointerMove={(event) => move(event.clientX)}
					onPointerLeave={() => setHover(null)}
					onFocus={() => setHover(x.length - 1)}
					onBlur={() => setHover(null)}
					onKeyDown={(event) => {
						if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
							event.preventDefault();
							setHover((index) =>
								Math.min(
									x.length - 1,
									Math.max(
										0,
										(index ?? x.length - 1) +
											(event.key === "ArrowRight" ? 1 : -1),
									),
								),
							);
						}
						if (event.key === "Escape") setHover(null);
					}}
				>
					<title>{label}</title>

					{ticks.map((tick) => (
						<g key={tick}>
							<line
								className="chart-grid"
								x1={PAD.left}
								x2={width - PAD.right}
								y1={py(tick)}
								y2={py(tick)}
							/>
							<text
								className="chart-tick y"
								x={PAD.left - 8}
								y={py(tick) + 3.5}
							>
								{format(tick)}
							</text>
						</g>
					))}

					{[0, Math.floor((x.length - 1) / 2), x.length - 1].map((index) => (
						<text
							key={index}
							className={`chart-tick x ${
								index === 0 ? "first" : index === x.length - 1 ? "last" : ""
							}`}
							x={px(index)}
							y={height - 6}
						>
							{time(x[index] ?? 0)}
						</text>
					))}

					{series.length === 1 && series[0] && (
						<path
							d={area(series[0].values)}
							fill={series[0].color}
							opacity={0.1}
						/>
					)}

					{series.map((line) => (
						<path
							key={line.id}
							className="chart-line"
							d={path(line.values)}
							stroke={line.color}
						/>
					))}

					{series.map((line) => {
						const end = last(line);
						if (!end) return null;
						return (
							<circle
								key={line.id}
								className="chart-end"
								cx={px(end.index)}
								cy={py(end.value)}
								r={4}
								fill={line.color}
							/>
						);
					})}

					{at != null && (
						<>
							<line
								className="chart-cross"
								x1={px(at)}
								x2={px(at)}
								y1={PAD.top}
								y2={PAD.top + plotH}
							/>
							{series.map((line) => {
								const value = line.values[at];
								if (value == null) return null;
								return (
									<circle
										key={line.id}
										className="chart-end"
										cx={px(at)}
										cy={py(value)}
										r={4}
										fill={line.color}
									/>
								);
							})}
						</>
					)}
				</svg>

				{at != null && (
					<div
						className="chart-tip"
						style={{
							left: `${(px(at) / width) * 100}%`,
							transform: px(at) > width / 2 ? "translateX(-100%)" : undefined,
						}}
					>
						<span className="dim">{time(x[at] ?? 0)}</span>
						{series.map((line) => {
							const value = line.values[at];
							return (
								<span key={line.id} className="chart-tip-row">
									<i style={{ background: line.color }} />
									<strong>{value == null ? "—" : format(value)}</strong>
									{series.length > 1 && <em>{line.label}</em>}
								</span>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
