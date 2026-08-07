import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Exercises install.sh against a fake "binary" — a shell script that prints a
 * version — so the download, checksum and placement logic can be tested without
 * a 100 MB artifact or root.
 */

const SCRIPT = join(import.meta.dir, "..", "install.sh");
const ASSET = "stats-linux-x64";

let dir = "";
const dist = () => join(dir, "dist");
const prefix = () => join(dir, "bin");

async function run(args: string[]) {
  const proc = Bun.spawn(["sh", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, STATS_ASSET: ASSET, NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function writeFakeRelease(sums: "correct" | "wrong" | "none") {
  const path = join(dist(), ASSET);
  await Bun.write(path, "#!/bin/sh\necho 'stats 9.9.9 (protocol 1)'\n");
  await Bun.$`chmod +x ${path}`.quiet();
  if (sums === "none") return;

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).bytes());
  const digest = sums === "correct" ? hasher.digest("hex") : "0".repeat(64);
  await Bun.write(join(dist(), "SHA256SUMS"), `${digest}  ${ASSET}\n`);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stats-install-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("installs a local build and verifies its checksum", async () => {
  await writeFakeRelease("correct");

  const { stdout, exitCode } = await run(["--from", dist(), "--prefix", prefix()]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("checksum ok");
  expect(stdout).toContain("stats 9.9.9");
  expect(await Bun.file(join(prefix(), "stats")).exists()).toBe(true);
});

test("refuses a binary whose checksum doesn't match", async () => {
  await writeFakeRelease("wrong");

  const { stderr, exitCode } = await run(["--from", dist(), "--prefix", prefix()]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("checksum mismatch");
  expect(await Bun.file(join(prefix(), "stats")).exists()).toBe(false);
});

test("installs without a checksum file, but says so", async () => {
  await writeFakeRelease("none");

  const { stdout, stderr, exitCode } = await run(["--from", dist(), "--prefix", prefix()]);

  expect(exitCode).toBe(0);
  expect(stderr).toContain("skipping checksum");
  expect(stdout).toContain("stats 9.9.9");
});

test("upgrades in place over an existing install", async () => {
  await writeFakeRelease("correct");
  await run(["--from", dist(), "--prefix", prefix()]);

  await Bun.write(join(dist(), ASSET), "#!/bin/sh\necho 'stats 9.9.10 (protocol 1)'\n");
  await Bun.$`chmod +x ${join(dist(), ASSET)}`.quiet();
  await rm(join(dist(), "SHA256SUMS"));

  const { stdout, exitCode } = await run(["--from", dist(), "--prefix", prefix()]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("stats 9.9.10");
});

test("rejects a binary that can't run here", async () => {
  await Bun.write(join(dist(), ASSET), "\x7fELF not really\n");
  await Bun.$`chmod +x ${join(dist(), ASSET)}`.quiet();

  const { stderr, exitCode } = await run(["--from", dist(), "--prefix", prefix()]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("doesn't run on this machine");
});

test("names the missing target when the build isn't there", async () => {
  await Bun.write(join(dist(), "placeholder"), "");

  const { stderr, exitCode } = await run(["--from", dist(), "--prefix", prefix()]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("bun run build --targets linux-x64");
});

test("--help and unknown flags behave", async () => {
  expect((await run(["--help"])).exitCode).toBe(0);

  const bad = await run(["--nonsense"]);
  expect(bad.exitCode).not.toBe(0);
  expect(bad.stderr).toContain("unknown option");
});
