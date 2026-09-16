import { describe, expect, test } from "bun:test";
import {
	detectVirtualization,
	factsFromReport,
	freshState,
	LoadAverage,
	setWin32Shell,
	statsFromReport,
	type TickReport,
	win32Probe,
	windowsVersion,
} from "./win32.ts";

/** A quad-core box, 100ns ticks, as Win32_PerfRawData_PerfOS_Processor prints it. */
function tick(ts: number, idle: number[]): TickReport {
	const mean = idle.reduce((sum, n) => sum + n, 0) / idle.length;
	return {
		cpu: [
			{ name: "_Total", idle: mean, ts },
			...idle.map((i, n) => ({ name: String(n), idle: i, ts })),
		],
		queue: 0,
		mem: { totalKb: 16_000_000, freeKb: 6_000_000 },
		page: [{ total: 4096, used: 512 }],
		disks: [
			{ id: "C:", size: 500e9, free: 200e9, fs: "NTFS", label: "Windows" },
			{ id: "D:", size: 0, free: 0, fs: "", label: "" },
			{ id: "E:", size: 1e12, free: 1e12, fs: "exFAT", label: "" },
		],
		net: [
			{ name: "Ethernet", rx: 1000, tx: 500 },
			{ name: "Tailscale", rx: 10, tx: 10 },
			{ name: "Loopback Pseudo-Interface 1", rx: 99, tx: 99 },
			{ name: "Bluetooth Network Connection", rx: 0, tx: 0 },
		],
		temps: [
			{ name: "ACPI\\ThermalZone\\TZ00_0", k10: 3232 },
			{ name: "ACPI\\ThermalZone\\TZ01_0", k10: 2732 },
			{ name: "ACPI\\ThermalZone\\TZ02_0", k10: 0 },
		],
	};
}

describe("win32 stats arithmetic", () => {
	test("cpu usage is 1 - Δidle/Δtime, per core and overall", () => {
		const state = freshState();
		const t0 = 1_000_000;
		statsFromReport(tick(t0, [0, 0, 0, 0]), state, 1000, null, true);
		// One second later: core 0 idle the whole time, core 3 never idle.
		const one = 10_000_000;
		const stats = statsFromReport(
			tick(t0 + one, [one, one / 2, one / 4, 0]),
			state,
			2000,
			"Some CPU",
		);
		expect(stats.cpu.cores).toBe(4);
		expect(stats.cpu.perCore.map((n) => Number(n.toFixed(2)))).toEqual([
			0, 0.5, 0.75, 1,
		]);
		expect(stats.cpu.usage).toBeCloseTo(1 - 1.75 / 4, 5);
		expect(stats.cpu.model).toBe("Some CPU");
	});

	test("first sample has no rates; second has them, plumbing adapters skipped", () => {
		const state = freshState();
		const first = statsFromReport(tick(1, [0, 0, 0, 0]), state, 1000, null);
		expect(first.net.map((n) => n.name)).toEqual(["Ethernet", "Tailscale"]);
		expect(first.net[0]!.rxRate).toBeNull();

		const report = tick(2, [0, 0, 0, 0]);
		report.net![0]!.rx = 3000;
		const second = statsFromReport(report, state, 3000, null);
		expect(second.net[0]!.rxRate).toBe(1000);
		expect(second.net[0]!.txRate).toBe(0);
	});

	test("memory in bytes, page file as swap", () => {
		const stats = statsFromReport(tick(1, [0]), freshState(), 1, null);
		expect(stats.mem.total).toBe(16_000_000 * 1024);
		expect(stats.mem.available).toBe(6_000_000 * 1024);
		expect(stats.mem.used).toBe(10_000_000 * 1024);
		expect(stats.mem.swapTotal).toBe(4096 * 1024 * 1024);
		expect(stats.mem.swapUsed).toBe(512 * 1024 * 1024);
	});

	test("disks are drive letters; unsized ones are dropped", () => {
		const stats = statsFromReport(tick(1, [0]), freshState(), 1, null);
		expect(stats.disks.map((d) => d.mount)).toEqual(["C:\\", "E:\\"]);
		const c = stats.disks[0]!;
		expect(c.filesystem).toBe("Windows (NTFS)");
		expect(c.used).toBe(300e9);
		expect(c.usage).toBeCloseTo(0.6);
		expect(stats.disks[1]!.filesystem).toBe("exFAT");
		expect(stats.disks[1]!.usage).toBe(0);
	});

	test("temperatures convert from tenths of kelvin and drop the fake zones", () => {
		const stats = statsFromReport(tick(1, [0]), freshState(), 1, null);
		expect(stats.temps).toHaveLength(1);
		expect(stats.temps[0]!.name).toBe("TZ00");
		expect(stats.temps[0]!.celsius).toBeCloseTo(50.05, 2);
	});

	test("a one-element array that PowerShell unwrapped still reads", () => {
		const report = tick(1, [0]);
		// biome-ignore lint/suspicious/noExplicitAny: deliberately wrong shape
		(report as any).disks = report.disks![0];
		const stats = statsFromReport(report, freshState(), 1, null);
		expect(stats.disks).toHaveLength(1);
	});

	test("the priming read doesn't seed the load average", () => {
		const state = freshState();
		const t0 = 1_000_000;
		const one = 10_000_000;
		const primed = statsFromReport(
			tick(t0, [0, 0, 0, 0]),
			state,
			0,
			null,
			true,
		);
		expect(primed.loadavg).toEqual([0, 0, 0]);
		// All four cores flat out, two threads queued: run queue of 6.
		const report = tick(t0 + one, [0, 0, 0, 0]);
		report.queue = 2;
		const stats = statsFromReport(report, state, 1000, null);
		expect(stats.loadavg).toEqual([6, 6, 6]);
	});
});

describe("LoadAverage", () => {
	test("decays toward the sample with the kernel's damping", () => {
		const load = new LoadAverage();
		expect(load.sample(4, 0)).toEqual([4, 4, 4]);
		// After one 1-minute window at zero, the 1-min value has fallen to 1/e.
		const [one, five, fifteen] = load.sample(0, 60_000);
		expect(one).toBeCloseTo(4 / Math.E, 5);
		expect(five).toBeCloseTo(4 * Math.exp(-1 / 5), 5);
		expect(fifteen).toBeCloseTo(4 * Math.exp(-1 / 15), 5);
	});
});

describe("win32 facts", () => {
	test("version parses out of the caption", () => {
		expect(windowsVersion("Microsoft Windows 11 Pro")).toBe("11");
		expect(windowsVersion("Microsoft Windows 10 Enterprise LTSC")).toBe("10");
		expect(windowsVersion("Microsoft Windows Server 2022 Datacenter")).toBe(
			"Server 2022",
		);
		expect(windowsVersion("Microsoft Windows Server 2012 R2 Standard")).toBe(
			"Server 2012 R2",
		);
		expect(windowsVersion(undefined)).toBeNull();
	});

	test("virtualization comes from the model, not HypervisorPresent", () => {
		expect(
			detectVirtualization({
				manufacturer: "Microsoft Corporation",
				model: "Virtual Machine",
			}),
		).toBe("microsoft");
		expect(
			detectVirtualization({
				manufacturer: "VMware, Inc.",
				model: "VMware20,1",
			}),
		).toBe("vmware");
		expect(
			detectVirtualization({
				manufacturer: "innotek GmbH",
				model: "VirtualBox",
			}),
		).toBe("oracle");
		expect(
			detectVirtualization({
				manufacturer: "QEMU",
				model: "Standard PC (Q35 + ICH9, 2009)",
			}),
		).toBe("kvm");
		expect(
			detectVirtualization({ manufacturer: "LENOVO", model: "20XW" }),
		).toBe("none");
	});

	test("a report becomes facts a card can style", () => {
		const now = 1_700_000_000_000;
		const facts = factsFromReport(
			{
				caption: "Microsoft Windows 11 Pro",
				version: "10.0.26100",
				ubr: "4652",
				release: "24H2",
				manufacturer: "LENOVO",
				model: "20XW",
				cpu: "11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz",
				cores: 8,
				memKb: 16_000_000,
				machineId: "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
				uptime: 3600,
			},
			now,
		);
		expect(facts.osId).toBe("windows");
		expect(facts.osVersion).toBe("11");
		expect(facts.osCodename).toBe("24H2");
		expect(facts.osPretty).toBe(
			"Microsoft Windows 11 Pro 24H2 (build 26100.4652)",
		);
		expect(facts.kernel).toBe("10.0.26100.4652");
		expect(facts.cpuModel).toBe(
			"11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz",
		);
		expect(facts.cpuCores).toBe(8);
		expect(facts.memTotal).toBe(16_000_000 * 1024);
		expect(facts.machineId).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
		expect(facts.bootedAt).toBe(now - 3600_000);
		expect(facts.init).toBe("scm");
		expect(facts.virtualization).toBe("none");
	});

	test("an empty report still produces facts from what node:os knows", () => {
		const facts = factsFromReport({}, 1);
		expect(facts.osId).toBe("windows");
		expect(facts.kernel).toBeTruthy();
		expect(facts.memTotal).toBeGreaterThan(0);
		expect(facts.cpuCores).toBeGreaterThan(0);
	});
});

describe("win32 probe", () => {
	test("is unavailable off Windows whatever is on PATH", async () => {
		setWin32Shell("/usr/bin/pwsh");
		try {
			expect(await win32Probe.available()).toBe(process.platform === "win32");
		} finally {
			setWin32Shell(undefined);
		}
	});
});

/** The real thing, on the real platform: `bun test` on the Windows box. */
describe.skipIf(process.platform !== "win32")("win32 probe, live", () => {
	test("is available and reports a plausible tick", async () => {
		expect(await win32Probe.available()).toBe(true);
		const stats = await win32Probe.stats();
		expect(stats.cpu.cores).toBeGreaterThan(0);
		expect(stats.cpu.perCore).toHaveLength(stats.cpu.cores);
		expect(stats.cpu.usage).toBeGreaterThanOrEqual(0);
		expect(stats.cpu.usage).toBeLessThanOrEqual(1);
		expect(stats.mem.total).toBeGreaterThan(0);
		expect(stats.mem.used).toBeLessThanOrEqual(stats.mem.total);
		expect(stats.disks.length).toBeGreaterThan(0);
		expect(stats.disks[0]!.mount).toMatch(/^[A-Z]:\\$/);
		expect(stats.uptimeSec).toBeGreaterThan(0);
	}, 60_000);

	test("second sample carries network rates", async () => {
		await win32Probe.stats();
		await Bun.sleep(200);
		const stats = await win32Probe.stats();
		for (const iface of stats.net) {
			expect(iface.rxRate).not.toBeNull();
		}
	}, 60_000);

	test("facts name the machine", async () => {
		const facts = await win32Probe.facts(true);
		expect(facts.osId).toBe("windows");
		expect(facts.osPretty).toMatch(/Windows/);
		expect(facts.kernel).toMatch(/^10\.0\.\d+/);
		expect(facts.machineId).toMatch(/^[0-9a-f-]{36}$/);
		expect(facts.cpuModel).toBeTruthy();
	}, 60_000);
});
