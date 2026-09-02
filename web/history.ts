/**
 * The hub's rolling metric series, as the browser reads it.
 *
 * The row shape mirrors `MetricStore.history()` — but it is redeclared here
 * rather than imported, because that module opens `bun:sqlite` and nothing in
 * the browser bundle may pull that in.
 */
export interface MetricPoint {
	ts: number;
	cpu: number;
	memUsed: number;
	memTotal: number;
	load1: number;
	rxRate: number;
	txRate: number;
	diskUsed: number;
	diskTotal: number;
}

/**
 * The windows the overview offers. Each one names how many buckets it wants:
 * the hub averages the window into that many slots, so an hour is drawn from
 * near-raw samples and a day is drawn from minute-and-a-half averages rather
 * than from the first ninety minutes of it.
 */
export interface HistoryRange {
	id: string;
	label: string;
	minutes: number;
	buckets: number;
}

export const DEFAULT_RANGE: HistoryRange = {
	id: "1h",
	label: "1 hour",
	minutes: 60,
	buckets: 120,
};

export const HISTORY_RANGES: HistoryRange[] = [
	DEFAULT_RANGE,
	{ id: "6h", label: "6 hours", minutes: 360, buckets: 180 },
	{ id: "24h", label: "24 hours", minutes: 1440, buckets: 240 },
];

/** Where a chart's y-axis should stop: a round number at or above the peak. */
export function niceMax(peak: number): number {
	if (!Number.isFinite(peak) || peak <= 0) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(peak));
	for (const step of [1, 1.5, 2, 2.5, 5, 10]) {
		if (peak <= step * magnitude) return step * magnitude;
	}
	return 10 * magnitude;
}
