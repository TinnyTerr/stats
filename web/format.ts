import type { HostFacts, ProcessState, SystemdUnit } from "../src/types.ts";
import { compareVersions } from "../src/version.ts";

/** Formatting shared by every panel. Presentation only — no fetching here. */

export const bytes = (n: number | null | undefined): string => {
	if (n == null) return "—";
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let value = n;
	let unit = 0;
	while (Math.abs(value) >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

export const rate = (n: number | null | undefined): string =>
	n == null ? "—" : `${bytes(n)}/s`;

export const pct = (n: number | null | undefined): string =>
	n == null ? "—" : `${Math.round(n * 100)}%`;

export const duration = (sec: number | null | undefined): string => {
	if (sec == null) return "—";
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = Math.floor(sec % 60);
	if (d) return `${d}d ${h}h`;
	if (h) return `${h}h ${m}m`;
	if (m) return `${m}m ${s}s`;
	return `${s}s`;
};

export const clock = (ts: number | null | undefined): string =>
	ts == null ? "—" : new Date(ts).toLocaleTimeString();

export const dateTime = (ts: number | null | undefined): string =>
	ts == null ? "—" : new Date(ts).toLocaleString();

/** "3m ago" / "just now" — for last-seen on an offline node. */
export const ago = (ts: number | null | undefined): string => {
	if (ts == null) return "never";
	const seconds = Math.round((Date.now() - ts) / 1000);
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
	return `${Math.round(seconds / 86400)}d ago`;
};

/** systemd's ExecMainStartTimestamp: "Mon 2026-08-09 11:22:33 UTC". */
export const systemdTime = (value: string | null): string => {
	if (!value) return "—";
	const parsed = Date.parse(value.replace(/^[A-Za-z]{3}\s/, ""));
	return Number.isFinite(parsed) ? dateTime(parsed) : value;
};

/** ns of CPU time, as systemd reports it for a unit. */
export const cpuTime = (ns: number | null): string => {
	if (ns == null) return "—";
	const seconds = ns / 1e9;
	if (seconds < 1) return `${Math.round(ns / 1e6)}ms`;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return duration(seconds);
};

/* ---------- versions ---------- */

export type VersionState = "current" | "behind" | "ahead" | "unknown";

/**
 * How a node's build compares to the hub's. The hub is the reference because it
 * is the thing you upgrade first — a node ahead of it means someone updated in
 * the wrong order, which is worth saying out loud rather than colouring green.
 */
export function versionState(
	nodeVersion: string | null | undefined,
	hubVersion: string | null | undefined,
): VersionState {
	if (!nodeVersion || !hubVersion) return "unknown";
	const diff = compareVersions(nodeVersion, hubVersion);
	if (diff < 0) return "behind";
	if (diff > 0) return "ahead";
	return "current";
}

export function versionTone(state: VersionState): Tone {
	switch (state) {
		case "behind":
			return "warn";
		case "ahead":
			return "info";
		default:
			return "idle";
	}
}

/* ---------- distributions ---------- */

/**
 * Distro identity, so a node's card says "Debian 13" in Debian's colour rather
 * than showing a kernel string. IDs come from os-release; derivatives fall back
 * to their ID_LIKE, and anything unrecognised gets the neutral chip.
 */
const DISTRO_STYLES: Record<string, { label: string; accent: string }> = {
	ubuntu: { label: "Ubuntu", accent: "#e95420" },
	debian: { label: "Debian", accent: "#d70a53" },
	fedora: { label: "Fedora", accent: "#3c6eb4" },
	rhel: { label: "RHEL", accent: "#ee0000" },
	centos: { label: "CentOS", accent: "#932279" },
	rocky: { label: "Rocky", accent: "#10b981" },
	almalinux: { label: "AlmaLinux", accent: "#0f4266" },
	alpine: { label: "Alpine", accent: "#0d597f" },
	arch: { label: "Arch", accent: "#1793d1" },
	manjaro: { label: "Manjaro", accent: "#35bf5c" },
	opensuse: { label: "openSUSE", accent: "#73ba25" },
	"opensuse-leap": { label: "openSUSE Leap", accent: "#73ba25" },
	"opensuse-tumbleweed": { label: "Tumbleweed", accent: "#73ba25" },
	raspbian: { label: "Raspberry Pi OS", accent: "#c51a4a" },
	nixos: { label: "NixOS", accent: "#5277c3" },
	gentoo: { label: "Gentoo", accent: "#54487a" },
	void: { label: "Void", accent: "#478061" },
	amzn: { label: "Amazon Linux", accent: "#ff9900" },
	ol: { label: "Oracle Linux", accent: "#c74634" },
	linuxmint: { label: "Mint", accent: "#87cf3e" },
	proxmox: { label: "Proxmox", accent: "#e57000" },
};

export interface DistroStyle {
	label: string;
	accent: string;
	/** "Ubuntu 24.04 LTS (noble)" — the full line for the overview panel */
	full: string;
}

export function distro(facts: HostFacts | null): DistroStyle | null {
	if (!facts) return null;
	const id = facts.osId?.toLowerCase() ?? "";
	const style =
		DISTRO_STYLES[id] ??
		DISTRO_STYLES[facts.osLike?.toLowerCase() ?? ""] ??
		null;

	const label = style?.label ?? facts.osName ?? facts.osId ?? "Linux";
	const version = facts.osVersion ? ` ${facts.osVersion}` : "";
	const codename = facts.osCodename ? ` (${facts.osCodename})` : "";

	return {
		label: `${label}${version}`,
		accent: style?.accent ?? "#6b7280",
		full: facts.osPretty ?? `${label}${version}${codename}`,
	};
}

/** Virtualisation, phrased the way you'd say it out loud. */
export function virtualization(facts: HostFacts | null): string {
	const virt = facts?.virtualization;
	if (!virt || virt === "none") return "bare metal";
	const names: Record<string, string> = {
		kvm: "KVM guest",
		qemu: "QEMU guest",
		vmware: "VMware guest",
		microsoft: "Hyper-V guest",
		oracle: "VirtualBox guest",
		xen: "Xen guest",
		lxc: "LXC container",
		"lxc-libvirt": "LXC container",
		docker: "Docker container",
		podman: "Podman container",
		"systemd-nspawn": "nspawn container",
		wsl: "WSL",
	};
	return names[virt] ?? virt;
}

/* ---------- systemd ---------- */

export type Tone = "ok" | "warn" | "crit" | "idle" | "info";

/**
 * A unit's colour comes from active+sub together: `active/exited` is normal for
 * a oneshot but means nothing is listening for a daemon, so both are shown and
 * only `failed` is ever red.
 */
export function unitTone(
	unit: Pick<SystemdUnit, "active" | "sub" | "load">,
): Tone {
	if (unit.active === "failed" || unit.sub === "failed") return "crit";
	if (unit.load === "not-found" || unit.load === "error") return "crit";
	if (unit.load === "masked") return "idle";
	if (unit.active === "activating" || unit.active === "deactivating")
		return "warn";
	if (unit.active === "active") return unit.sub === "running" ? "ok" : "info";
	return "idle";
}

export function systemStateTone(state: string | null | undefined): Tone {
	switch (state) {
		case "running":
			return "ok";
		case "degraded":
			return "crit";
		case "starting":
		case "stopping":
			return "warn";
		case "maintenance":
			return "warn";
		default:
			return "idle";
	}
}

/* ---------- projects ---------- */

export function processTone(state: ProcessState): Tone {
	switch (state) {
		case "running":
			return "ok";
		case "starting":
		case "restarting":
		case "stopping":
			return "warn";
		case "crashed":
		case "fatal":
			return "crit";
		case "exited":
			return "info";
		default:
			return "idle";
	}
}

export function healthTone(health: string): Tone {
	switch (health) {
		case "healthy":
			return "ok";
		case "unhealthy":
			return "crit";
		case "starting":
			return "warn";
		default:
			return "idle";
	}
}

export function usageTone(value: number | null | undefined): Tone {
	if (value == null) return "idle";
	if (value > 0.9) return "crit";
	if (value > 0.75) return "warn";
	return "ok";
}

/**
 * The other direction: a fraction where full is the healthy end — units active,
 * containers up, projects running. {@link usageTone} reads a bar as pressure on
 * a resource, which is right for CPU and disk and exactly backwards here: 99% of
 * units running is the best a box gets, and it should not be painted as an
 * alarm.
 */
export function readyTone(value: number | null | undefined): Tone {
	if (value == null) return "idle";
	if (value < 0.5) return "crit";
	if (value < 0.9) return "warn";
	return "ok";
}
