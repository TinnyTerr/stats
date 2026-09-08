import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MODULES } from "../../modules/manifest.ts";
import type { CaStatus } from "../../types.ts";
import type { NodeModule, NodeModuleContext } from "./mod.ts";

/**
 * Trusting the fleet's local CA in this host's own certificate store.
 *
 * The hub holds the one CA — see src/hub/ca.ts — and hands its public half to
 * every node in Welcome. This module's whole job is deciding "is that the one
 * already trusted here?" and running the platform's own command to fix it when
 * it isn't. It never sees a private key and never asks the hub for one; the
 * cert is the only thing that travels, the same way it would if you copied it
 * onto the machine by hand.
 *
 * Available is "the hub has sent a CA and this platform has an installer for
 * it" — a node the hub hasn't reached yet, or one on a platform with no
 * trust-store command written for it, reports the module as absent rather than
 * as failing every tick.
 */

function caStateDir(): string {
	// systemd's StateDirectory= creates and chowns this for us, and — under
	// ProtectHome — is the only writable state directory a non-root unit has;
	// homedir() is a fallback for running outside systemd entirely.
	if (process.env.STATE_DIRECTORY) return process.env.STATE_DIRECTORY;
	if (process.getuid?.() === 0) return "/var/lib/stats";
	return join(homedir(), ".local", "share", "stats");
}

async function certPath(): Promise<string> {
	const dir = caStateDir();
	await mkdir(dir, { recursive: true });
	return join(dir, "fleet-ca.pem");
}

interface Installer {
	/** name shown on the card when the install fails, e.g. "update-ca-certificates" */
	method: string;
	run(ctx: NodeModuleContext, pemPath: string, pem: string): Promise<void>;
}

// Both RHEL/Fedora and Arch ship a `update-ca-trust` command, but disagree on
// where its anchors live — p11-kit vs. Arch's own ca-certificates-utils.
const TRUST_ANCHOR_DIRS = [
	"/etc/pki/ca-trust/source/anchors",
	"/etc/ca-certificates/trust-source/anchors",
];

const LINUX: Installer = {
	method: "update-ca-certificates",
	async run(ctx, _pemPath, pem) {
		// Bun.file(dir).exists() reads false for a directory — stat it instead.
		for (const dir of TRUST_ANCHOR_DIRS) {
			const isDir = await stat(dir)
				.then((s) => s.isDirectory())
				.catch(() => false);
			if (!isDir) continue;
			await Bun.write(join(dir, "stats-fleet-ca.pem"), pem);
			await ctx.host.exec(["update-ca-trust", "extract"]);
			return;
		}
		await mkdir("/usr/local/share/ca-certificates", { recursive: true });
		await Bun.write(
			"/usr/local/share/ca-certificates/stats-fleet-ca.crt",
			pem,
		);
		await ctx.host.exec(["update-ca-certificates"]);
	},
};

const DARWIN: Installer = {
	method: "security add-trusted-cert",
	async run(ctx, pemPath, _pem) {
		const result = await ctx.host.exec([
			"security",
			"add-trusted-cert",
			"-d",
			"-r",
			"trustRoot",
			"-k",
			"/Library/Keychains/System.keychain",
			pemPath,
		]);
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || "security add-trusted-cert failed");
		}
	},
};

const WIN32: Installer = {
	method: "certutil -addstore Root",
	async run(ctx, pemPath, _pem) {
		const result = await ctx.host.exec([
			"certutil",
			"-addstore",
			"-f",
			"Root",
			pemPath,
		]);
		if (result.code !== 0) {
			throw new Error(result.stdout.trim() || "certutil -addstore failed");
		}
	},
};

const INSTALLERS: Partial<Record<NodeJS.Platform, Installer>> = {
	linux: LINUX,
	darwin: DARWIN,
	win32: WIN32,
};

let lastInstalled: { fingerprint: string; error: string | null } | null = null;

async function reconcile(ctx: NodeModuleContext): Promise<CaStatus> {
	const ca = ctx.trustedCa?.() ?? null;
	const installer = INSTALLERS[process.platform];
	if (!ca || !installer) {
		return {
			available: false,
			installedFingerprint: lastInstalled?.fingerprint ?? null,
			fleetFingerprint: ca?.fingerprint ?? null,
			method: installer?.method ?? null,
			error: null,
		};
	}

	if (lastInstalled?.fingerprint === ca.fingerprint) {
		return {
			available: true,
			installedFingerprint: lastInstalled.fingerprint,
			fleetFingerprint: ca.fingerprint,
			method: installer.method,
			error: lastInstalled.error,
		};
	}

	const pemPath = await certPath();
	await Bun.write(pemPath, ca.pem);
	try {
		await installer.run(ctx, pemPath, ca.pem);
		lastInstalled = { fingerprint: ca.fingerprint, error: null };
	} catch (err) {
		lastInstalled = {
			fingerprint: ca.fingerprint,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	return {
		available: true,
		installedFingerprint: lastInstalled.error ? null : lastInstalled.fingerprint,
		fleetFingerprint: ca.fingerprint,
		method: installer.method,
		error: lastInstalled.error,
	};
}

export const caModule: NodeModule = {
	manifest: MODULES.ca,

	async available(ctx) {
		return ctx.trustedCa?.() != null && process.platform in INSTALLERS;
	},

	async collect(ctx) {
		return { ca: await reconcile(ctx) };
	},

	actions: {
		"ca.status": async (_req, ctx) => reconcile(ctx),
	},
};
