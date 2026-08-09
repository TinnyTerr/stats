import { $ } from "bun";
import type { CommandResult, UnitVerb } from "../proto/messages.ts";
import type {
	SystemdSummary,
	SystemdUnit,
	SystemdUnitDetail,
} from "../types.ts";

/**
 * systemd, formatted rather than dumped. The dashboard renders load/active/sub
 * as three separate signals — a unit can be `loaded active exited`, which is
 * healthy for a oneshot and alarming for a daemon — so the parser keeps the
 * columns apart instead of flattening them into one status string.
 */

/** Unit types worth listing. Everything else is noise on a server dashboard. */
const LISTED_TYPES = ["service", "timer", "socket", "mount"] as const;

/**
 * The canonical test: /run/systemd/system exists only when systemd is PID 1.
 * It's a directory, so this stats it rather than asking Bun.file().exists(),
 * which answers false for anything that isn't a regular file.
 */
export async function systemdAvailable(): Promise<boolean> {
	const stat = await Bun.file("/run/systemd/system")
		.stat()
		.catch(() => null);
	return stat?.isDirectory() ?? false;
}

function unitType(unit: string): string {
	const dot = unit.lastIndexOf(".");
	return dot === -1 ? "unknown" : unit.slice(dot + 1);
}

/**
 * `systemctl list-units --plain --no-legend` gives five whitespace-separated
 * columns, the last of which (description) contains spaces. Failed units keep
 * their bullet in some versions even with --plain, so it's stripped here.
 */
export function parseUnitLines(text: string): SystemdUnit[] {
	const units: SystemdUnit[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/^\s*[●*×→●]\s*/, "").trim();
		if (!line) continue;
		const parts = line.split(/\s+/);
		if (parts.length < 4) continue;
		const [unit, load, active, sub] = parts as [string, string, string, string];
		// `not-found` rows are units something referenced but that don't exist.
		if (!unit.includes(".")) continue;
		units.push({
			unit,
			type: unitType(unit),
			load,
			active,
			sub,
			description: parts.slice(4).join(" "),
		});
	}
	return units;
}

export async function collectUnits(): Promise<SystemdUnit[]> {
	const out =
		await $`systemctl list-units --type=${LISTED_TYPES.join(",")} --no-pager --plain --no-legend --full`
			.nothrow()
			.quiet();
	if (out.exitCode !== 0) return [];

	const units = parseUnitLines(out.stdout.toString());
	// Failed units are the point of the panel, so they sort first, then anything
	// still activating, then the rest alphabetically.
	const rank = (u: SystemdUnit) =>
		u.active === "failed" ? 0 : u.active === "activating" ? 1 : 2;
	return units.sort(
		(a, b) => rank(a) - rank(b) || a.unit.localeCompare(b.unit),
	);
}

export async function collectSystemdSummary(
	units: SystemdUnit[],
): Promise<SystemdSummary> {
	if (!(await systemdAvailable())) {
		return {
			available: false,
			version: null,
			state: null,
			total: 0,
			active: 0,
			failed: [],
		};
	}

	const [stateOut, versionOut] = await Promise.all([
		// Exit code is non-zero when the system is degraded, which is exactly the
		// case we care about — read stdout regardless.
		$`systemctl is-system-running`.nothrow().quiet(),
		$`systemctl --version`.nothrow().quiet(),
	]);

	return {
		available: true,
		version:
			versionOut.exitCode === 0
				? (versionOut.stdout
						.toString()
						.split("\n")[0]
						?.replace(/^systemd\s+/, "")
						.trim() ?? null)
				: null,
		state: stateOut.stdout.toString().trim() || null,
		total: units.length,
		active: units.filter((u) => u.active === "active").length,
		failed: units.filter((u) => u.active === "failed").map((u) => u.unit),
	};
}

/** Properties worth showing in the unit drawer. */
const SHOW_PROPERTIES = [
	"Description",
	"LoadState",
	"ActiveState",
	"SubState",
	"UnitFileState",
	"FragmentPath",
	"MainPID",
	"ExecMainStartTimestamp",
	"ActiveEnterTimestamp",
	"MemoryCurrent",
	"CPUUsageNSec",
	"TasksCurrent",
	"NRestarts",
	"Result",
];

/** systemd reports "unset" numeric properties as [UINT64_MAX]. */
function optionalNumber(value: string | undefined): number | null {
	if (!value || value === "[not set]") return null;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0 || n >= Number.MAX_SAFE_INTEGER) return null;
	return n;
}

function optionalString(value: string | undefined): string | null {
	return value && value !== "n/a" && value !== "0" ? value : null;
}

export function isValidUnitName(unit: string): boolean {
	// Keeps a unit name from turning into extra systemctl arguments or a path.
	return (
		/^[A-Za-z0-9:_.\\@-]+$/.test(unit) &&
		unit.length <= 256 &&
		unit.includes(".")
	);
}

export async function showUnit(unit: string): Promise<SystemdUnitDetail> {
	if (!isValidUnitName(unit)) throw new Error(`invalid unit name '${unit}'`);

	const out =
		await $`systemctl show ${unit} --property=${SHOW_PROPERTIES.join(",")} --no-pager`
			.nothrow()
			.quiet();
	if (out.exitCode !== 0) {
		throw new Error(
			out.stderr.toString().trim() || `systemctl show ${unit} failed`,
		);
	}

	const props = new Map<string, string>();
	for (const line of out.stdout.toString().split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
	}

	return {
		unit,
		description: optionalString(props.get("Description")),
		loadState: optionalString(props.get("LoadState")),
		activeState: optionalString(props.get("ActiveState")),
		subState: optionalString(props.get("SubState")),
		unitFileState: optionalString(props.get("UnitFileState")),
		fragmentPath: optionalString(props.get("FragmentPath")),
		mainPid: optionalNumber(props.get("MainPID")) || null,
		execMainStartTimestamp: optionalString(props.get("ExecMainStartTimestamp")),
		activeEnterTimestamp: optionalString(props.get("ActiveEnterTimestamp")),
		memoryCurrent: optionalNumber(props.get("MemoryCurrent")),
		cpuUsageNSec: optionalNumber(props.get("CPUUsageNSec")),
		tasksCurrent: optionalNumber(props.get("TasksCurrent")),
		nRestarts: optionalNumber(props.get("NRestarts")),
		result: optionalString(props.get("Result")),
	};
}

const VERBS: UnitVerb[] = ["start", "stop", "restart", "reload"];

/** Requires the node to run with enough privilege; the error says so if not. */
export async function unitAction(
	unit: string,
	verb: UnitVerb,
): Promise<CommandResult> {
	if (!isValidUnitName(unit)) throw new Error(`invalid unit name '${unit}'`);
	if (!VERBS.includes(verb)) throw new Error(`unknown verb '${verb}'`);

	const out = await $`systemctl ${verb} ${unit}`.nothrow().quiet();
	const output = `${out.stdout.toString()}${out.stderr.toString()}`.trim();
	return {
		ok: out.exitCode === 0,
		output:
			output ||
			(out.exitCode === 0 ? `${verb} ${unit}: ok` : `exit ${out.exitCode}`),
	};
}
