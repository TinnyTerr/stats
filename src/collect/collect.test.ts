import { describe, expect, test } from "bun:test";
import { fileTargetAllowed } from "./logs.ts";
import { collectListeningPorts, collectProcesses } from "./processes.ts";
import { collectSystem } from "./system.ts";

describe("fileTargetAllowed", () => {
	test("allows paths under the default /var/log", () => {
		expect(fileTargetAllowed("/var/log/syslog")).toBe(true);
		expect(fileTargetAllowed("/var/log/nginx/access.log")).toBe(true);
	});

	test("refuses paths outside the allowlist", () => {
		expect(fileTargetAllowed("/etc/shadow")).toBe(false);
		expect(fileTargetAllowed("/home/user/.ssh/id_rsa")).toBe(false);
	});

	test("refuses traversal and relative paths", () => {
		expect(fileTargetAllowed("/var/log/../etc/shadow")).toBe(false);
		expect(fileTargetAllowed("var/log/syslog")).toBe(false);
	});

	test("refuses a sibling directory sharing the prefix", () => {
		expect(fileTargetAllowed("/var/logsecret/creds")).toBe(false);
	});
});

describe("system collectors", () => {
	test("reports plausible cpu and memory", async () => {
		const stats = await collectSystem();

		expect(stats.hostname).toBeTruthy();
		expect(stats.cpu.usage).toBeGreaterThanOrEqual(0);
		expect(stats.cpu.usage).toBeLessThanOrEqual(1);
		expect(stats.cpu.perCore.length).toBe(stats.cpu.cores);
		expect(stats.mem.total).toBeGreaterThan(0);
		expect(stats.mem.used).toBeLessThanOrEqual(stats.mem.total);
		expect(stats.uptimeSec).toBeGreaterThan(0);
		expect(stats.loadavg).toHaveLength(3);
	});

	test("second sample produces network rates", async () => {
		await collectSystem();
		await Bun.sleep(150);
		const stats = await collectSystem();

		// First sample has null rates; by the second they must be real numbers.
		for (const iface of stats.net) {
			expect(iface.rxRate).not.toBeNull();
			expect(iface.rxRate!).toBeGreaterThanOrEqual(0);
		}
	});

	test("disks exclude pseudo filesystems", async () => {
		const stats = await collectSystem();
		for (const disk of stats.disks) {
			expect(disk.total).toBeGreaterThan(0);
			expect(disk.usage).toBeGreaterThanOrEqual(0);
			expect(disk.usage).toBeLessThanOrEqual(1);
			expect(disk.mount.startsWith("/snap/")).toBe(false);
		}
	});
});

describe("process collectors", () => {
	test("returns processes sorted by cpu, capped at the limit", async () => {
		const procs = await collectProcesses(5);
		expect(procs.length).toBeLessThanOrEqual(5);
		expect(procs.length).toBeGreaterThan(0);

		for (const p of procs) {
			expect(p.pid).toBeGreaterThan(0);
			expect(p.user).toBeTruthy();
			// cpu is normalised across cores, so it can never exceed 1.
			expect(p.cpu).toBeLessThanOrEqual(1);
		}
		for (let i = 1; i < procs.length; i++) {
			expect(procs[i - 1]!.cpu).toBeGreaterThanOrEqual(procs[i]!.cpu);
		}
	});

	test("listening ports parse into numbers", async () => {
		const ports = await collectListeningPorts();
		for (const p of ports) {
			expect(Number.isInteger(p.port)).toBe(true);
			expect(p.port).toBeGreaterThan(0);
			expect(["tcp", "udp"]).toContain(p.proto);
		}
	});
});
