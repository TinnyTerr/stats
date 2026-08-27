/**
 * What a module runs on.
 *
 * Every module declares the platforms it supports, the way package.json's `os`
 * field does, and the loader drops one that doesn't name the host it woke up
 * on. This is the seam that lets `system` mean "/proc and /sys" on Linux and
 * something else entirely on Windows without either implementation knowing the
 * other exists.
 *
 * Two things are deliberately separate here:
 *
 *   - the *declaration* (`platforms`), which travels to the hub and the browser
 *     so both can say "this module isn't for that host" without running code;
 *   - the *entry* (see {@link resolveEntry}), which is how an installed module
 *     ships a different file per platform.
 *
 * A module that declares no platforms is portable and runs everywhere. That is
 * the right default: it's what a module made of HTTP calls looks like, and
 * making authors enumerate platforms they never thought about would produce
 * lists that are wrong rather than lists that are true.
 */

/**
 * The platforms this codebase names. These are `process.platform` values, so
 * the strings match Node/Bun rather than being a vocabulary of our own — the
 * one place they get compared is against the running process.
 */
export const PLATFORMS = ["linux", "darwin", "win32", "freebsd"] as const;

export type Platform = (typeof PLATFORMS)[number];

/** Human names, for the dashboard and the CLI's module table. */
export const PLATFORM_LABELS: Record<Platform, string> = {
	linux: "Linux",
	darwin: "macOS",
	win32: "Windows",
	freebsd: "FreeBSD",
};

export function isPlatform(value: unknown): value is Platform {
	return (
		typeof value === "string" &&
		(PLATFORMS as readonly string[]).includes(value)
	);
}

/**
 * The host this process is on, or null on something we have no name for. Null
 * is not an error: an unknown platform still runs portable modules, it just
 * can't match a platform-specific one, which is the correct outcome.
 */
export function currentPlatform(): Platform | null {
	return isPlatform(process.platform) ? process.platform : null;
}

/**
 * `null`/`undefined`/`[]` all mean "portable" — see the note at the top. A
 * non-empty list is a closed set: naming linux and darwin excludes Windows.
 */
export function supportsPlatform(
	platforms: readonly Platform[] | null | undefined,
	platform: Platform | null,
): boolean {
	if (!platforms || platforms.length === 0) return true;
	if (!platform) return false;
	return platforms.includes(platform);
}

/** Why a module was dropped, in the words the operator needs to hear. */
export function platformNote(
	id: string,
	platforms: readonly Platform[],
	platform: Platform | null,
): string {
	const supported = platforms.map((p) => PLATFORM_LABELS[p]).join(", ");
	const here = platform ? PLATFORM_LABELS[platform] : process.platform;
	return `${id}: supports ${supported}; this host is ${here}`;
}

/**
 * A module's node-side entry point, which may be one file or one file per
 * platform:
 *
 *     "entry": "./node.ts"
 *     "entry": { "linux": "./linux.ts", "win32": "./windows.ts" }
 *
 * The object form takes a `default` key for "everything I didn't name", so a
 * module can special-case Windows without restating the other three.
 */
export type ModuleEntry =
	| string
	| ({ default?: string } & Partial<Record<Platform, string>>);

export function resolveEntry(
	entry: ModuleEntry,
	platform: Platform | null,
): string | null {
	if (typeof entry === "string") return entry;
	if (platform && entry[platform]) return entry[platform];
	return entry.default ?? null;
}

/**
 * The platforms an entry can actually serve. A module with a per-platform entry
 * and no `default` implicitly supports exactly the platforms it named — which
 * is worth deriving rather than making the author write the same list twice and
 * eventually disagree with themselves.
 */
export function platformsFromEntry(entry: ModuleEntry): Platform[] | null {
	if (typeof entry === "string") return null;
	if (entry.default) return null;
	return PLATFORMS.filter((p) => Boolean(entry[p]));
}

/** Parses the `platforms` field of a manifest, naming anything it can't use. */
export function parsePlatforms(
	raw: unknown,
	where: string,
	problems: string[],
): Platform[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		problems.push(`${where}: platforms must be an array`);
		return [];
	}
	const platforms: Platform[] = [];
	for (const value of raw) {
		if (isPlatform(value)) {
			if (!platforms.includes(value)) platforms.push(value);
		} else {
			problems.push(
				`${where}: unknown platform '${String(value)}' — one of ${PLATFORMS.join(", ")}`,
			);
		}
	}
	return platforms;
}
