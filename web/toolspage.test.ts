import { describe, expect, test } from "bun:test";
import {
	blankProcess,
	blankProject,
	buildDocument,
	exampleProjects,
} from "./toolspage.tsx";

describe("projects builder", () => {
	test("the example form is the old template and passes the node's validator", () => {
		const { doc, errors } = buildDocument(exampleProjects());
		expect(errors).toEqual([]);
		expect(doc).toEqual({
			$schema: "/schema/projects.schema.json",
			version: 1,
			projects: [
				{
					id: "example",
					name: "Example",
					cwd: "/opt/example",
					processes: [{ id: "web", command: ["bun", "run", "start"] }],
				},
			],
		});
	});

	test("blank fields stay out of the file; defaults are not written", () => {
		const { doc } = buildDocument([
			blankProject({
				id: "p",
				processes: [
					blankProcess({
						id: "x",
						command: "true",
						autostart: true,
						restart: "on-failure",
						shell: false,
					}),
				],
			}),
		]);
		expect(doc.projects[0]).toEqual({
			id: "p",
			processes: [{ id: "x", command: ["true"] }],
		});
	});

	test("non-default settings, env lines, lists and healthchecks are written", () => {
		const { doc, errors } = buildDocument([
			blankProject({
				id: "p",
				cwd: "/srv/p",
				tags: "web, prod",
				env: "A=1\n# comment\n\nB=two words",
				enabled: false,
				watch: {
					systemd: "nginx.service",
					containers: "",
					ports: "80, 443",
					paths: "",
				},
				processes: [
					blankProcess({
						id: "x",
						command: "echo hi | cat",
						shell: true,
						autostart: false,
						restart: "always",
						maxRestarts: "0",
						user: "www",
						health: {
							type: "http",
							url: "http://127.0.0.1:80/",
							expectStatus: "200, 204",
							port: "",
							host: "",
							command: "",
							intervalSec: "5",
							timeoutMs: "",
							failures: "",
							startPeriodSec: "",
						},
					}),
				],
			}),
		]);
		expect(errors).toEqual([]);
		expect(doc.projects[0]).toEqual({
			id: "p",
			cwd: "/srv/p",
			env: { A: "1", B: "two words" },
			tags: ["web", "prod"],
			enabled: false,
			watch: { systemd: ["nginx.service"], ports: [80, 443] },
			processes: [
				{
					id: "x",
					command: "echo hi | cat",
					shell: true,
					autostart: false,
					restart: "always",
					maxRestarts: 0,
					user: "www",
					healthcheck: {
						type: "http",
						url: "http://127.0.0.1:80/",
						expectStatus: [200, 204],
						intervalSec: 5,
					},
				},
			],
		});
	});

	test("mistakes are reported by the same validator the node uses", () => {
		const { errors } = buildDocument([
			blankProject({
				id: "bad id",
				cwd: "relative",
				env: "NOEQUALS",
				processes: [blankProcess({ id: "x", command: "" })],
			}),
			blankProject({ id: "dup", processes: [] }),
			blankProject({ id: "dup", processes: [] }),
		]);
		expect(errors.join("\n")).toContain("'bad id' must be letters");
		expect(errors.join("\n")).toContain("expected KEY=value");
		expect(errors.join("\n")).toContain("'dup' is defined twice");
		// cwd and the empty command are never reached because the id is rejected
		// first — which is exactly how the node reports it too.
		const { errors: more } = buildDocument([
			blankProject({
				id: "ok",
				cwd: "relative",
				processes: [blankProcess({ id: "x", command: "" })],
			}),
		]);
		expect(more.join("\n")).toContain("must be an absolute path");
		expect(more.join("\n")).toContain("command");
	});
});
