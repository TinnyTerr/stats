import { describe, expect, test } from "bun:test";
import {
	cpuUsage,
	macosName,
	memFromVmStat,
	netInterfaces,
	parseBootTime,
	parseDf,
	parseNetstat,
	parsePlatformUuid,
	parseSwapUsage,
	parseSwVers,
	parseVmStat,
} from "./darwin.ts";
import {
	parseEtime,
	parseNetstatListeners,
	parsePs,
} from "./darwin-processes.ts";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                          150000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                         90000.
Pages purgeable:                           3000.
File-backed pages:                       120000.
Pages occupied by compressor:             40000.
`;

describe("darwin memory", () => {
	test("vm_stat pages are scaled by the page size in its header", () => {
		const vm = parseVmStat(VM_STAT);
		expect(vm.pageSize).toBe(16384);
		expect(vm.free).toBe(10000);
		expect(vm.wired).toBe(90000);
		expect(vm.compressed).toBe(40000);
	});

	test("available is free + inactive + speculative + purgeable", () => {
		const vm = parseVmStat(VM_STAT);
		const mem = memFromVmStat(vm, 16 * 1024 ** 3, { total: 0, used: 0 });
		expect(mem.available).toBe((10000 + 150000 + 5000 + 3000) * 16384);
		expect(mem.used).toBe(mem.total - mem.available);
		expect(mem.cached).toBe(120000 * 16384);
	});

	test("swapusage reads its own units", () => {
		const swap = parseSwapUsage(
			"total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)",
		);
		expect(swap.total).toBe(2048 * 1024 ** 2);
		expect(swap.used).toBe(1024.5 * 1024 ** 2);
		expect(parseSwapUsage("total = 0.00M  used = 0.00M").total).toBe(0);
	});
});

describe("darwin disks", () => {
	const DF = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   488245288  15000000 300000000     5%    /
devfs                  214       214         0   100%    /dev
/dev/disk3s6     488245288  20000000 300000000     7%    /System/Volumes/VM
/dev/disk3s5     488245288 180000000 300000000    38%    /System/Volumes/Data
map auto_home            0         0         0   100%    /System/Volumes/Data/home
/dev/disk5s1     976490576 100000000 876000000    11%    /Volumes/Macintosh HD 2
//user@nas/share 100000000  40000000  60000000    40%    /Volumes/share
`;

	test("keeps real volumes and drops APFS plumbing", () => {
		const disks = parseDf(DF);
		expect(disks.map((d) => d.mount)).toEqual([
			"/",
			"/System/Volumes/Data",
			"/Volumes/Macintosh HD 2",
			"/Volumes/share",
		]);
	});

	test("block counts are kilobytes", () => {
		const data = parseDf(DF).find((d) => d.mount === "/System/Volumes/Data")!;
		expect(data.total).toBe(488245288 * 1024);
		expect(data.used).toBe(180000000 * 1024);
		expect(data.usage).toBeCloseTo(180000000 / 488245288, 5);
	});
});

describe("darwin network", () => {
	const NETSTAT = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                          100     0       9000      100     0       9000     0
lo0        16384 127           127.0.0.1           100     -       9000      100     -       9000     -
en0        1500  <Link#6>    a4:83:e7:aa:bb:cc  5000     0    7000000     4000     0    2000000     0
en0        1500  192.168.1     192.168.1.20       5000     -    7000000     4000     -    2000000     -
en1*       1500  <Link#7>    a4:83:e7:aa:bb:cd     0     0          0        0     0          0     0
utun4      1380  <Link#12>                         10     0       2000       10     0       1000     0
awdl0      1500  <Link#8>    aa:bb:cc:dd:ee:ff    50     0       9999       50     0       9999     0
`;

	test("reads the Link row, skips plumbing and idle interfaces", () => {
		const rows = parseNetstat(NETSTAT);
		expect(rows).toEqual([
			{ name: "en0", rx: 7000000, tx: 2000000 },
			{ name: "utun4", rx: 2000, tx: 1000 },
		]);
	});

	test("second sample yields rates, a reset yields null", () => {
		netInterfaces([{ name: "x0", rx: 1000, tx: 100 }], 1_000);
		const next = netInterfaces([{ name: "x0", rx: 3000, tx: 50 }], 3_000);
		expect(next[0]!.rxRate).toBe(1000);
		expect(next[0]!.txRate).toBeNull();
	});
});

describe("darwin cpu", () => {
	test("usage is 1 - Δidle/Δtotal per core", () => {
		const prev = [
			{ idle: 0, total: 0 },
			{ idle: 0, total: 0 },
		];
		const now = [
			{ idle: 50, total: 100 },
			{ idle: 0, total: 100 },
		];
		expect(cpuUsage(now, prev)).toEqual([0.5, 1]);
	});

	test("a runtime that returns no ticks is reported, not read as idle", () => {
		expect(cpuUsage([{ idle: 0, total: 0 }], null)).toBeNull();
	});
});

describe("darwin facts", () => {
	test("sw_vers, codenames, boot time and platform uuid", () => {
		const v = parseSwVers(
			"ProductName:\t\tmacOS\nProductVersion:\t\t14.5\nBuildVersion:\t\t23F79\n",
		);
		expect(v.get("ProductVersion")).toBe("14.5");
		expect(macosName("14.5")).toBe("Sonoma");
		expect(macosName("26.0")).toBe("Tahoe");
		expect(macosName("99.0")).toBeNull();
		expect(
			parseBootTime("{ sec = 1700000000, usec = 0 } Tue Nov 14 22:13:20 2023"),
		).toBe(1700000000_000);
		expect(parsePlatformUuid('    "IOPlatformUUID" = "ABCD-1234-EF"')).toBe(
			"ABCD-1234-EF",
		);
	});
});

describe("darwin processes", () => {
	test("etime forms", () => {
		expect(parseEtime("05:09")).toBe(309);
		expect(parseEtime("01:02:03")).toBe(3723);
		expect(parseEtime("2-01:00:00")).toBe(2 * 86400 + 3600);
		expect(parseEtime("nonsense")).toBe(0);
	});

	test("sorted by cpu, comm basename, args joined by pid", () => {
		const main = [
			"  1     0 root      0.1  0.0   5000     10-02:00:00 /sbin/launchd",
			"  42    1 lewis    45.0  2.5 900000        01:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		].join("\n");
		const args =
			"1 /sbin/launchd\n42 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=gpu";
		const procs = parsePs(main, args, 10);
		expect(procs.map((p) => p.pid)).toEqual([42, 1]);
		expect(procs[0]!.command).toBe("Google Chrome");
		expect(procs[0]!.args).toContain("--type=gpu");
		expect(procs[0]!.rssBytes).toBe(900000 * 1024);
	});

	test("listeners take the pid from the right column per protocol", () => {
		const text = [
			"tcp4       0      0  *.3000                 *.*                    LISTEN      131072  131072  1234      0 0x0100 0x00000106",
			"tcp6       0      0  ::1.5432               *.*                    LISTEN      131072  131072  555       0 0x0100 0x00000106",
			"tcp4       0      0  10.0.0.2.51000         1.2.3.4.443            ESTABLISHED 131072  131072  777       0 0x0102 0x00000104",
			"udp4       0      0  *.5353                 *.*                                786896    9216  99        0 0x4100 0x00000000",
		].join("\n");
		const ports = parseNetstatListeners(
			text,
			new Map([
				[1234, "bun"],
				[99, "mDNSResponder"],
			]),
		);
		expect(ports).toEqual([
			{ proto: "tcp", address: "*", port: 3000, pid: 1234, process: "bun" },
			{
				proto: "udp",
				address: "*",
				port: 5353,
				pid: 99,
				process: "mDNSResponder",
			},
			{ proto: "tcp", address: "::1", port: 5432, pid: 555, process: null },
		]);
	});
});
