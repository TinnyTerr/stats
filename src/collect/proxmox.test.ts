import { afterEach, describe, expect, test } from "bun:test";
import {
	collectProxmoxVia,
	guestAction,
	isValidPveName,
	type ProxmoxTransport,
	shapeResources,
	useProxmoxTransport,
} from "./proxmox.ts";

/**
 * The transport is the seam: everything here runs the real shaping and the real
 * argument building against a fake `pvesh`, so a change to either shows up as a
 * failing assertion rather than as an empty guests tab on a machine nobody is
 * looking at.
 */

const RESOURCES = [
	{
		type: "node",
		id: "node/pve1",
		node: "pve1",
		status: "online",
		cpu: 0.12,
		maxcpu: 16,
		mem: 8 * 1024 ** 3,
		maxmem: 64 * 1024 ** 3,
		uptime: 86_400,
	},
	{
		type: "node",
		id: "node/pve2",
		node: "pve2",
		status: "offline",
	},
	{
		type: "qemu",
		id: "qemu/101",
		vmid: 101,
		name: "web",
		node: "pve1",
		status: "running",
		cpu: 0.05,
		maxcpu: 4,
		mem: 2 * 1024 ** 3,
		maxmem: 4 * 1024 ** 3,
		disk: 0,
		maxdisk: 32 * 1024 ** 3,
		uptime: 3600,
		tags: "prod;web",
	},
	{
		type: "lxc",
		id: "lxc/200",
		vmid: 200,
		name: "dns",
		node: "pve1",
		status: "stopped",
	},
	{
		type: "qemu",
		id: "qemu/9000",
		vmid: 9000,
		name: "debian-template",
		node: "pve1",
		status: "stopped",
		template: 1,
	},
	{
		type: "storage",
		id: "storage/pve1/local-lvm",
		node: "pve1",
		storage: "local-lvm",
		plugintype: "lvmthin",
		status: "available",
		disk: 100 * 1024 ** 3,
		maxdisk: 500 * 1024 ** 3,
	},
];

/** A pvesh that answers from a table of paths, and records what it was asked. */
function fakePvesh(answers: Record<string, unknown>) {
	const calls: string[][] = [];
	const transport: ProxmoxTransport = {
		async exec(argv) {
			calls.push(argv);
			const path = argv[2] ?? "";
			if (!(path in answers)) {
				return { code: 2, stdout: "", stderr: `no such path ${path}` };
			}
			return { code: 0, stdout: JSON.stringify(answers[path]), stderr: "" };
		},
		fetch: async () => {
			throw new Error("the http transport should not be used here");
		},
	};
	useProxmoxTransport(transport);
	return calls;
}

afterEach(() => useProxmoxTransport(null));

describe("shapeResources", () => {
	test("splits one flat list into guests, hosts and storage", () => {
		const { guests, hosts, storage } = shapeResources(RESOURCES);

		expect(hosts.map((h) => h.node)).toEqual(["pve1", "pve2"]);
		expect(storage).toHaveLength(1);
		expect(storage[0]!.type).toBe("lvmthin");
		expect(guests.map((g) => g.vmid)).toEqual([200, 101, 9000]);
	});

	test("sorts stopped guests first and templates last", () => {
		// The point of the list is finding what isn't running; a template is
		// neither running nor a problem, so it sits at the bottom.
		const { guests } = shapeResources(RESOURCES);
		expect(guests[0]!.status).toBe("stopped");
		expect(guests[0]!.template).toBe(false);
		expect(guests.at(-1)!.template).toBe(true);
	});

	test("splits tags and keeps the guest's own cpu fraction", () => {
		const { guests } = shapeResources(RESOURCES);
		const web = guests.find((g) => g.vmid === 101)!;
		expect(web.tags).toEqual(["prod", "web"]);
		expect(web.cpu).toBe(0.05);
		expect(web.cores).toBe(4);
		expect(web.type).toBe("qemu");
	});

	test("missing numbers come back null rather than zero", () => {
		// Zero memory and "we didn't ask" are different answers, and a stopped
		// guest reports neither.
		const { guests } = shapeResources(RESOURCES);
		const dns = guests.find((g) => g.vmid === 200)!;
		expect(dns.memUsed).toBeNull();
		expect(dns.uptimeSec).toBeNull();
	});
});

describe("collectProxmoxVia", () => {
	test("counts guests without letting templates skew the totals", async () => {
		fakePvesh({
			"/cluster/resources": RESOURCES,
			"/version": { version: "8.2.4" },
			"/cluster/status": [{ type: "cluster", name: "homelab" }],
		});

		const { proxmox, guests } = await collectProxmoxVia("pvesh");

		expect(proxmox.available).toBe(true);
		expect(proxmox.via).toBe("pvesh");
		expect(proxmox.version).toBe("8.2.4");
		expect(proxmox.cluster).toBe("homelab");
		expect(proxmox.total).toBe(2);
		expect(proxmox.running).toBe(1);
		expect(proxmox.stopped).toBe(1);
		expect(proxmox.templates).toBe(1);
		// The guest list still carries the template — it's the counts that exclude it.
		expect(guests).toHaveLength(3);
	});

	test("a standalone host reports no cluster rather than a cluster of one", async () => {
		fakePvesh({
			"/cluster/resources": RESOURCES,
			"/version": { version: "8.2.4" },
			"/cluster/status": [{ type: "node", name: "pve1" }],
		});

		const { proxmox } = await collectProxmoxVia("pvesh");
		expect(proxmox.cluster).toBeNull();
	});

	test("identity is optional; resources are not", async () => {
		// /version failing shouldn't cost us the guest list, but a host that can't
		// list resources has nothing to report and should say so.
		fakePvesh({ "/cluster/resources": RESOURCES });
		const { proxmox } = await collectProxmoxVia("pvesh");
		expect(proxmox.version).toBeNull();
		expect(proxmox.total).toBe(2);

		fakePvesh({});
		expect(collectProxmoxVia("pvesh")).rejects.toThrow(/cluster\/resources/);
	});
});

describe("guestAction", () => {
	test("builds the status path pvesh expects", async () => {
		const calls = fakePvesh({});
		const result = await guestAction(
			{ node: "pve1", vmid: 101, type: "qemu", verb: "shutdown" },
			"pvesh",
		);

		expect(calls[0]).toEqual([
			"pvesh",
			"create",
			"/nodes/pve1/qemu/101/status/shutdown",
		]);
		// The fake answers nothing for create, so this is the failure path — which
		// must still come back as a result rather than a throw.
		expect(result.ok).toBe(false);
	});

	test("refuses anything that would become extra path segments", async () => {
		fakePvesh({});
		const bad = { vmid: 101, type: "qemu" as const, verb: "start" as const };

		expect(guestAction({ ...bad, node: "../../etc" }, "pvesh")).rejects.toThrow(
			/invalid node name/,
		);
		expect(guestAction({ ...bad, node: "pve1/x" }, "pvesh")).rejects.toThrow(
			/invalid node name/,
		);
		expect(
			guestAction({ ...bad, node: "pve1", vmid: 0 }, "pvesh"),
		).rejects.toThrow(/invalid vmid/);
		expect(
			guestAction({ ...bad, node: "pve1", verb: "destroy" as never }, "pvesh"),
		).rejects.toThrow(/unknown verb/);
	});

	test("accepts the node names Proxmox itself accepts", () => {
		expect(isValidPveName("pve1")).toBe(true);
		expect(isValidPveName("pve-node.lan")).toBe(true);
		expect(isValidPveName("-leading")).toBe(false);
		expect(isValidPveName("has space")).toBe(false);
		expect(isValidPveName("")).toBe(false);
	});
});
