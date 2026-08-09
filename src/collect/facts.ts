import { readFile } from "node:fs/promises";
import os from "node:os";
import { $ } from "bun";
import type { HostFacts } from "../types.ts";

/**
 * The slow half of collection: what this machine *is*, rather than what it is
 * doing. os-release, lsb_release, virtualisation, init system. None of it
 * changes between telemetry ticks, so it's cached and refreshed hourly.
 */

/** Parses the KEY="value" format shared by os-release and friends. */
export function parseKeyValue(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		// Values may be bare, 'single' or "double" quoted, with \" escapes.
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
			(value.startsWith("'") && value.endsWith("'") && value.length > 1)
		) {
			value = value.slice(1, -1).replace(/\\(["'\\$`])/g, "$1");
		}
		out.set(key, value);
	}
	return out;
}

async function readText(path: string): Promise<string | null> {
	return await readFile(path, "utf8").catch(() => null);
}

/**
 * Runs a probe and returns its stdout. `acceptFailure` is for the tools that
 * report their answer through the exit code — `systemd-detect-virt` exits 1
 * when the answer is "none", which is a perfectly good answer.
 */
async function run(
	cmd: string[],
	acceptFailure = false,
): Promise<string | null> {
	const out = await $`${cmd}`.nothrow().quiet();
	const text = out.stdout.toString().trim();
	if (out.exitCode !== 0 && !acceptFailure) return null;
	return text || null;
}

/**
 * os-release is the standard; lsb-release is the older one Debian derivatives
 * still carry, and it's occasionally more specific (Debian testing reports
 * `trixie/sid` there while os-release says just "13"). We read both and keep
 * the disagreement rather than picking a winner.
 */
export async function collectOsRelease(): Promise<{
	release: Map<string, string>;
	lsb: Map<string, string>;
}> {
	const releaseText =
		(await readText("/etc/os-release")) ??
		(await readText("/usr/lib/os-release")) ??
		"";
	const lsbText = (await readText("/etc/lsb-release")) ?? "";
	const lsb = parseKeyValue(lsbText);

	// The file is absent on Debian/Fedora; the command exists more often.
	if (!lsb.size) {
		const out = await run(["lsb_release", "-a"]);
		if (out) {
			for (const line of out.split("\n")) {
				const [key, ...rest] = line.split(":");
				if (!key || !rest.length) continue;
				const value = rest.join(":").trim();
				if (/^description$/i.test(key)) lsb.set("DISTRIB_DESCRIPTION", value);
				else if (/^release$/i.test(key)) lsb.set("DISTRIB_RELEASE", value);
				else if (/^codename$/i.test(key)) lsb.set("DISTRIB_CODENAME", value);
				else if (/^distributor id$/i.test(key)) lsb.set("DISTRIB_ID", value);
			}
		}
	}

	return { release: parseKeyValue(releaseText), lsb };
}

/** systemd | openrc | sysvinit | unknown — decides how much of the UI applies. */
async function detectInit(): Promise<string> {
	const comm = await readText("/proc/1/comm");
	if (comm) {
		const name = comm.trim();
		if (name === "systemd") return "systemd";
		if (name === "init") {
			// Both OpenRC and SysV call PID 1 "init"; the runtime dir gives it away.
			if (await Bun.file("/run/openrc/softlevel").exists()) return "openrc";
			return "sysvinit";
		}
		if (name) return name;
	}
	return "unknown";
}

async function dockerVersion(): Promise<string | null> {
	const socket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
	try {
		const res = await fetch("http://localhost/version", { unix: socket });
		if (!res.ok) return null;
		const body = (await res.json()) as { Version?: string };
		return body.Version ?? null;
	} catch {
		return null;
	}
}

let cached: HostFacts | null = null;
let cachedAt = 0;

/** How long facts are considered current. */
const TTL_MS = 3600_000;

export async function collectFacts(force = false): Promise<HostFacts> {
	if (!force && cached && Date.now() - cachedAt < TTL_MS) return cached;

	const [
		{ release, lsb },
		init,
		uptimeText,
		cpuinfo,
		meminfo,
		machineId,
		virt,
		systemdVer,
		docker,
	] = await Promise.all([
		collectOsRelease(),
		detectInit(),
		readText("/proc/uptime"),
		readText("/proc/cpuinfo"),
		readText("/proc/meminfo"),
		readText("/etc/machine-id"),
		run(["systemd-detect-virt"], true),
		run(["systemctl", "--version"]),
		dockerVersion(),
	]);

	const cpuModel =
		cpuinfo
			?.split("\n")
			.find((l) => l.startsWith("model name") || l.startsWith("Model"))
			?.split(":")[1]
			?.trim() ?? null;

	const memTotalKb = Number(
		meminfo
			?.split("\n")
			.find((l) => l.startsWith("MemTotal"))
			?.match(/\d+/)?.[0] ?? 0,
	);

	const uptimeSec = Number(uptimeText?.trim().split(/\s+/)[0] ?? 0);
	const kernel =
		(await readText("/proc/sys/kernel/osrelease"))?.trim() ?? os.release();

	const osVersion =
		release.get("VERSION_ID") ??
		lsb.get("DISTRIB_RELEASE") ??
		release.get("VERSION") ??
		null;
	const lsbRelease = lsb.get("DISTRIB_RELEASE") ?? null;

	cached = {
		hostname: os.hostname(),
		osId: release.get("ID") ?? lsb.get("DISTRIB_ID")?.toLowerCase() ?? null,
		osLike: release.get("ID_LIKE")?.split(/\s+/)[0] ?? null,
		osPretty:
			release.get("PRETTY_NAME") ??
			lsb.get("DISTRIB_DESCRIPTION") ??
			release.get("NAME") ??
			null,
		osName: release.get("NAME") ?? lsb.get("DISTRIB_ID") ?? null,
		osVersion,
		osCodename:
			release.get("VERSION_CODENAME") ?? lsb.get("DISTRIB_CODENAME") ?? null,
		// Only interesting when it says something os-release doesn't.
		lsbRelease: lsbRelease && lsbRelease !== osVersion ? lsbRelease : null,
		kernel,
		arch: os.arch(),
		virtualization: virt,
		init,
		// `systemctl --version` prints "systemd 255 (255.4-1ubuntu8)" then a feature list.
		systemdVersion:
			systemdVer
				?.split("\n")[0]
				?.replace(/^systemd\s+/, "")
				.trim() ?? null,
		machineId: machineId?.trim() || null,
		cpuModel,
		cpuCores: os.cpus().length,
		memTotal: memTotalKb * 1024,
		bootedAt: uptimeSec ? Date.now() - uptimeSec * 1000 : null,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
		dockerVersion: docker,
		collectedAt: Date.now(),
	};
	cachedAt = Date.now();
	return cached;
}
