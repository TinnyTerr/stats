import {
	type ModuleGrant,
	type ModuleManifest,
	OPEN_GRANTS,
	PRIVILEGED_GRANTS,
} from "./manifest.ts";

/**
 * Modules that don't ship in this repo.
 *
 * An installed module is a git repository with a `stats.module.json` at its
 * root and one file of node-side code. The node half is ordinary JavaScript and
 * runs in the node's process behind the same {@link ModuleHost} gate as
 * everything else. The browser half is *not* code: the manifest describes what
 * to draw and the dashboard draws it, because a page that fetched and ran a
 * third party's script would be a much bigger promise than "you installed a
 * module on your own server".
 *
 * That trade is the whole design here. A declared table and a declared face
 * cover what a monitoring module actually does — count things, list them, say
 * which are unhealthy — and anything beyond that is a pull request against this
 * repo rather than an install.
 */

/* ---------- what a module reports ---------- */

/** The only value types that survive the wire and are safe to render as text. */
export type ModuleValue = string | number | boolean | null;

/** How a value reads out. The renderer owns the formatting, not the module. */
export type ModuleFormat =
	| "text"
	| "number"
	| "percent"
	| "bytes"
	| "rate"
	| "duration"
	| "time"
	| "ago"
	/** a coloured pill: values ok/up/healthy read green, error/failed/down red */
	| "state";

/** One tick of an external module's data. */
export interface ModuleReport {
	/** scalars the face and the tab header refer to by key */
	values: Record<string, ModuleValue>;
	/** the table the tab draws, one object per row keyed by column key */
	rows: Record<string, ModuleValue>[];
	/** lights the tab's badge when it isn't "ok" */
	status?: "ok" | "warn" | "crit";
	/** one line of context under the card face */
	detail?: string | null;
}

/**
 * What a node summary carries: everything but the rows. Card faces only ever
 * read scalars, and summaries are re-sent to every browser on every tick — a
 * module listing two hundred rows would be paying that cost four times a
 * second for data nothing on the card can show.
 */
export type ModuleHeadline = Omit<ModuleReport, "rows">;

export function emptyReport(): ModuleReport {
	return { values: {}, rows: [] };
}

export function headline(report: ModuleReport): ModuleHeadline {
	return {
		values: report.values,
		status: report.status,
		detail: report.detail,
	};
}

/* ---------- what a module declares ---------- */

export interface ModuleColumn {
	/** the key to read from each row */
	key: string;
	label: string;
	format?: ModuleFormat;
	/** appended after the formatted value, e.g. "°C" */
	suffix?: string;
	/** right-align, as numbers want to be */
	align?: "left" | "right";
}

export interface ModuleTabSpec {
	/** defaults to the module id */
	id?: string;
	/** the tab's caption; defaults to the module label, lowercased */
	label?: string;
	columns: ModuleColumn[];
	/** shown instead of the table when there are no rows */
	empty?: string;
}

export interface ModuleTileSpec {
	label: string;
	/** key in the report's values */
	value: string;
	format?: ModuleFormat;
	suffix?: string;
	/** paint the tile red when this value is truthy and non-zero */
	critWhenSet?: boolean;
}

export interface ModuleMeterSpec {
	label: string;
	/** the numerator's key */
	value: string;
	/** the denominator's key; omit when `value` is already a 0..1 fraction */
	of?: string;
	/**
	 * Which end is healthy. "high" is the common case for a module counting
	 * things that should be up; "low" reads the bar as pressure, like disk usage.
	 */
	good?: "high" | "low";
	detail?: string;
}

export interface ModuleFaceSpec {
	/** the caption on the card's face selector; defaults to the module label */
	label?: string;
	tiles?: ModuleTileSpec[];
	meter?: ModuleMeterSpec;
	facts?: { label: string; value: string; format?: ModuleFormat }[];
}

/** `stats.module.json`, as it appears in an installed repository. */
export interface ExternalManifest {
	id: string;
	label: string;
	description: string;
	/** the node-side entry, relative to the module directory */
	entry: string;
	grants: ModuleGrant[];
	/** control action names this module answers; must be prefixed with its id */
	actions: string[];
	tab: ModuleTabSpec | null;
	face: ModuleFaceSpec | null;
	/** the module's own version string, for `stats modules` */
	version: string | null;
	/** where to file a bug */
	homepage: string | null;
}

/**
 * Ids have to survive being a directory name, a JSON key and a URL fragment, and
 * they must not collide with a builtin — a module calling itself "docker" would
 * be claiming docker's actions.
 */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

const FORMATS: ModuleFormat[] = [
	"text",
	"number",
	"percent",
	"bytes",
	"rate",
	"duration",
	"time",
	"ago",
	"state",
];

function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function problemsWithFormat(
	format: unknown,
	where: string,
	problems: string[],
): ModuleFormat | undefined {
	if (format === undefined) return undefined;
	if (typeof format === "string" && FORMATS.includes(format as ModuleFormat))
		return format as ModuleFormat;
	problems.push(
		`${where}: unknown format '${String(format)}' — one of ${FORMATS.join(", ")}`,
	);
	return undefined;
}

/**
 * Reads a manifest the way the loader has to: every problem at once, named, so
 * a module author fixes one file rather than playing whack-a-mole with the
 * installer. Returns null alongside the problems when it can't be used at all.
 */
export function parseExternalManifest(
	raw: unknown,
	reserved: readonly string[] = [],
): { manifest: ExternalManifest | null; problems: string[] } {
	const problems: string[] = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { manifest: null, problems: ["stats.module.json is not an object"] };
	}
	const source = raw as Record<string, unknown>;

	const id = str(source.id);
	if (!id) problems.push("id is required");
	else if (!MODULE_ID_PATTERN.test(id)) {
		problems.push(
			`id '${id}' must be lowercase letters, digits and dashes, 2–32 characters`,
		);
	} else if (reserved.includes(id)) {
		problems.push(`id '${id}' is the name of a module that ships with stats`);
	}

	const grants: ModuleGrant[] = [];
	const rawGrants = Array.isArray(source.grants) ? source.grants : [];
	for (const grant of rawGrants) {
		if (
			typeof grant === "string" &&
			([...OPEN_GRANTS, ...PRIVILEGED_GRANTS] as string[]).includes(grant)
		) {
			grants.push(grant as ModuleGrant);
		} else {
			problems.push(`unknown grant '${String(grant)}'`);
		}
	}

	// An action a module doesn't own is an action it could steal from one that
	// does, so the namespace is enforced rather than suggested.
	const actions: string[] = [];
	for (const action of Array.isArray(source.actions) ? source.actions : []) {
		const name = str(action);
		if (!name) {
			problems.push("actions must be non-empty strings");
			continue;
		}
		if (id && !name.startsWith(`${id}.`)) {
			problems.push(`action '${name}' must be named '${id}.something'`);
			continue;
		}
		actions.push(name);
	}

	let tab: ModuleTabSpec | null = null;
	if (source.tab !== undefined && source.tab !== null) {
		const rawTab = source.tab as Record<string, unknown>;
		const columns: ModuleColumn[] = [];
		for (const [i, column] of (Array.isArray(rawTab.columns)
			? rawTab.columns
			: []
		).entries()) {
			const entry = (column ?? {}) as Record<string, unknown>;
			const key = str(entry.key);
			if (!key) {
				problems.push(`tab.columns[${i}]: key is required`);
				continue;
			}
			columns.push({
				key,
				label: str(entry.label) ?? key,
				format: problemsWithFormat(entry.format, `tab.columns[${i}]`, problems),
				suffix: str(entry.suffix) ?? undefined,
				align: entry.align === "right" ? "right" : "left",
			});
		}
		if (!columns.length) problems.push("tab declares no usable columns");
		tab = {
			id: str(rawTab.id) ?? id ?? undefined,
			label: str(rawTab.label) ?? undefined,
			columns,
			empty: str(rawTab.empty) ?? undefined,
		};
	}

	let face: ModuleFaceSpec | null = null;
	if (source.face !== undefined && source.face !== null) {
		const rawFace = source.face as Record<string, unknown>;
		const tiles: ModuleTileSpec[] = [];
		for (const [i, tile] of (Array.isArray(rawFace.tiles)
			? rawFace.tiles
			: []
		).entries()) {
			const entry = (tile ?? {}) as Record<string, unknown>;
			const value = str(entry.value);
			if (!value) {
				problems.push(`face.tiles[${i}]: value is required`);
				continue;
			}
			tiles.push({
				label: str(entry.label) ?? value,
				value,
				format: problemsWithFormat(entry.format, `face.tiles[${i}]`, problems),
				suffix: str(entry.suffix) ?? undefined,
				critWhenSet: entry.critWhenSet === true,
			});
		}
		// Three is what the card's metrics row fits; a fourth would wrap and make
		// every card in the grid a different height.
		if (tiles.length > 3) {
			problems.push(`face declares ${tiles.length} tiles; the card fits 3`);
		}

		const rawMeter = rawFace.meter as Record<string, unknown> | undefined;
		const meterValue = rawMeter ? str(rawMeter.value) : null;
		if (rawMeter && !meterValue) problems.push("face.meter: value is required");

		const facts: ModuleFaceSpec["facts"] = [];
		for (const [i, fact] of (Array.isArray(rawFace.facts)
			? rawFace.facts
			: []
		).entries()) {
			const entry = (fact ?? {}) as Record<string, unknown>;
			const value = str(entry.value);
			if (!value) {
				problems.push(`face.facts[${i}]: value is required`);
				continue;
			}
			facts.push({
				label: str(entry.label) ?? value,
				value,
				format: problemsWithFormat(entry.format, `face.facts[${i}]`, problems),
			});
		}

		face = {
			label: str(rawFace.label) ?? undefined,
			tiles,
			meter:
				rawMeter && meterValue
					? {
							label: str(rawMeter.label) ?? meterValue,
							value: meterValue,
							of: str(rawMeter.of) ?? undefined,
							good: rawMeter.good === "low" ? "low" : "high",
							detail: str(rawMeter.detail) ?? undefined,
						}
					: undefined,
			facts,
		};
	}

	if (!id || problems.length) return { manifest: null, problems };

	return {
		manifest: {
			id,
			label: str(source.label) ?? id,
			description: str(source.description) ?? "",
			entry: str(source.entry) ?? "./node.ts",
			grants,
			actions,
			tab,
			face,
			version: str(source.version),
			homepage: str(source.homepage),
		},
		problems,
	};
}

/**
 * The row an external module occupies in the same table the builtins are in.
 * Everything downstream — grant checking, the hub's narrowing, the dispatch
 * table — works off {@link ModuleManifest} and never learns that this one came
 * from a git repository.
 */
export function toModuleManifest(external: ExternalManifest): ModuleManifest {
	return {
		id: external.id,
		label: external.label,
		description: external.description,
		required: false,
		// It was installed on purpose; making an operator then enable it would be
		// asking the same question twice.
		enabledByDefault: true,
		grants: external.grants,
		actions: external.actions,
		tab: external.tab ? (external.tab.id ?? external.id) : null,
		provides: external.tab || external.face ? [external.id] : [],
	};
}
