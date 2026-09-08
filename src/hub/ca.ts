import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
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

export interface IssuedCert {
	/** signed by the fleet CA */
	cert: string;
	/** matching private key — this is the one and only time it exists; the hub keeps no copy */
	key: string;
	/** the fleet CA's own cert, so the leaf can be presented as a chain */
	caCert: string;
}

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * A one-off leaf cert signed by the fleet CA, for services that want the same
 * trust nodes already have (see src/agent/modules/ca.ts) rather than a cert of
 * their own. Generated and signed in a scratch directory that's gone before
 * this returns — the hub never persists a leaf key, only the CA's.
 */
export async function issueCert(
	dbPath: string,
	opts: { commonName: string; sans?: string[]; days?: number },
): Promise<IssuedCert> {
	const dir = caDir(dbPath);
	const ca = await ensureHubCa(dbPath);
	const keyPath = join(dir, "ca-key.pem");
	const certPath = join(dir, "ca-cert.pem");

	const days = Math.min(Math.max(Math.round(opts.days ?? 825), 1), 3650);
	const names = [opts.commonName, ...(opts.sans ?? [])].filter(Boolean);
	const altNames = names
		.map((name) => (IPV4.test(name) ? `IP:${name}` : `DNS:${name}`))
		.join(",");

	const scratch = await mkdtemp(join(tmpdir(), "stats-ca-issue-"));
	try {
		const leafKey = join(scratch, "leaf-key.pem");
		const csr = join(scratch, "leaf.csr");
		const leafCert = join(scratch, "leaf-cert.pem");
		const extfile = join(scratch, "leaf.ext");
		await Bun.write(
			extfile,
			`basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=${altNames}\n`,
		);

		await run([
			"openssl",
			"req",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			leafKey,
			"-out",
			csr,
			"-subj",
			`/O=stats fleet/CN=${opts.commonName}`,
		]);
		await run([
			"openssl",
			"x509",
			"-req",
			"-in",
			csr,
			"-CA",
			certPath,
			"-CAkey",
			keyPath,
			"-CAcreateserial",
			"-days",
			String(days),
			"-sha256",
			"-extfile",
			extfile,
			"-out",
			leafCert,
		]);

		return {
			cert: await Bun.file(leafCert).text(),
			key: await Bun.file(leafKey).text(),
			caCert: ca.pem,
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
