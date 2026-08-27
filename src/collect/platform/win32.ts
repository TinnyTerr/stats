import { ProbeUnimplemented, type SystemProbe } from "../probe.ts";

/**
 * The Windows probe — declared, not yet written.
 *
 * Unlike macOS this one has no shared ground with the Linux implementation at
 * all: there is no /proc to fall back to and no `df` to reuse, so every field
 * is its own lookup. The likely shape is one PowerShell/CIM call per tick
 * rather than five, because process start-up is the expensive part on Windows
 * and a per-field spawn would cost more than the telemetry is worth.
 *
 * What it needs:
 *   cpu     `Win32_PerfFormattedData_PerfOS_Processor`, or GetSystemTimes
 *   memory  `Win32_OperatingSystem` Free/TotalVisibleMemorySize
 *   disks   `Win32_LogicalDisk` — drive letters, not mount points; DiskMount's
 *           `mount` field takes "C:\\" fine, but the UI sorts by path depth
 *   net     `Win32_PerfRawData_Tcpip_NetworkInterface`, deltas as elsewhere
 *   temps   `MSAcpi_ThermalZoneTemperature`, absent on most desktop hardware
 *   facts   `Win32_OperatingSystem` + `Win32_Processor`; machineId is the
 *           MachineGuid registry value, which is what /etc/machine-id is for
 *
 * Note that `system` is only half of a Windows node. The other half is that
 * `systemd` and `processes` don't run there either — see their `platforms` in
 * src/modules/manifest.ts — so a Windows node is a real but sparse node until
 * services and process probes exist too.
 */
export const win32Probe: SystemProbe = {
	platform: "win32",

	async available() {
		return false;
	},

	async stats(): Promise<never> {
		throw new ProbeUnimplemented("win32", "system statistics");
	},

	async facts(): Promise<never> {
		throw new ProbeUnimplemented("win32", "host facts");
	},
};
