import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "./supervisor.ts";

const git = Bun.which("git") !== null;

async function sh(cwd: string, ...argv: string[]) {
	const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
	if ((await p.exited) !== 0)
		throw new Error(await new Response(p.stderr).text());
}

describe.skipIf(!git)("deploy", () => {
	let root: string;
	let sup: Supervisor;

	async function setup(build: string[]) {
		const origin = join(root, "origin");
		const work = join(root, "work");
		await sh(root, "git", "init", "-q", "-b", "main", origin);
		await Bun.write(join(origin, "hello.txt"), "v1");
		await sh(origin, "git", "add", ".");
		await sh(
			origin,
			"git",
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-qm",
			"one",
		);
		const file = join(root, "projects.json");
		await Bun.write(
			file,
			JSON.stringify({
				projects: [
					{
						id: "app",
						cwd: work,
						source: { repo: origin },
						build,
						processes: [{ id: "p", command: "sleep 60", autostart: false }],
					},
				],
			}),
		);
		sup = new Supervisor([file]);
		await sup.load();
		return work;
	}

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "stats-deploy-"));
	});
	afterAll(async () => {
		await sup?.shutdown();
		await rm(root, { recursive: true, force: true });
	});

	test("clones, builds and reports the revision", async () => {
		const work = await setup(["cp hello.txt built.txt"]);
		const status = await sup.deploy("app");
		expect(status.error).toBeNull();
		expect(status.state).toBe("ok");
		expect(status.revision).toMatch(/^[0-9a-f]{7,}$/);
		expect(await Bun.file(join(work, "built.txt")).text()).toBe("v1");
		const [project] = await sup.status();
		expect(project?.deploy?.state).toBe("ok");
	});

	test("a failing build is a failed deploy and says why", async () => {
		const status = await (async () => {
			// Same checkout, now with a build that cannot pass.
			const file = join(root, "projects.json");
			const doc = await Bun.file(file).json();
			doc.projects[0].build = ["exit 3"];
			await Bun.write(file, JSON.stringify(doc));
			await sup.load();
			return sup.deploy("app");
		})();
		expect(status.state).toBe("failed");
		expect(status.error).toBe("exit 3");
	});

	test("refuses a project with nothing to deploy", () => {
		expect(() => sup.deploy("nope")).toThrow("unknown project");
	});
});
