import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The fleet's one local CA — generated once per hub, next to its database, and
 * handed to nodes as the public half only. See src/agent/modules/ca.ts for the
 * node side; this file never sends the key anywhere, including to itself twice
 * — a cert already on disk is reused rather than regenerated, because rotating
 * it would mean every node's trust store falling out of date until its `ca`
 * module runs again.
 */

export interface HubCa {
	/** PEM-encoded certificate, public — the only half a node ever sees */
	pem: string;
	/** sha256 of the PEM text, so a node can tell "same CA" from "rotated" */
	fingerprint: string;
}

let cached: { dir: string; ca: HubCa } | null = null;

/** `:memory:` has no directory of its own — keep test/dev hubs out of the repo. */
function caDir(dbPath: string): string {
	if (dbPath === ":memory:") return join(tmpdir(), "stats-hub-ca");
	return dirname(dbPath);
}

async function run(argv: string[]): Promise<void> {
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	const [stderr, code] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(`${argv[0]} failed: ${stderr.trim() || `exit ${code}`}`);
	}
}

export async function ensureHubCa(dbPath: string): Promise<HubCa> {
	const dir = caDir(dbPath);
	if (cached?.dir === dir) return cached.ca;

	const certPath = join(dir, "ca-cert.pem");
	const keyPath = join(dir, "ca-key.pem");

	if (!(await Bun.file(certPath).exists())) {
		await mkdir(dir, { recursive: true });
		await run([
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:4096",
			"-sha256",
			"-days",
			"3650",
			"-nodes",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-subj",
			"/O=stats fleet/CN=stats local CA",
		]);
		await chmod(keyPath, 0o600);
	}

	const pem = await Bun.file(certPath).text();
	const ca: HubCa = {
		pem,
		fingerprint: createHash("sha256").update(pem).digest("hex"),
	};
	cached = { dir, ca };
	return ca;
}
