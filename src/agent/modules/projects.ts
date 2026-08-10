import { MODULES } from "../../modules/manifest.ts";
import { RemoteError } from "../../proto/link.ts";
import type {
	ProjectActionParams,
	ProjectsListResult,
} from "../../proto/messages.ts";
import type { NodeModule } from "./mod.ts";
import { requireControl } from "./mod.ts";

/**
 * The projects file, and the supervisor that runs what it declares.
 *
 * The supervisor itself lives on the agent rather than in here: a node keeps
 * running what it was told to run whether or not the dashboard is watching, so
 * turning this module off hides the projects — it does not stop them.
 */
export const projectsModule: NodeModule = {
	manifest: MODULES.projects,

	async collect(ctx) {
		return { projects: await ctx.supervisor.status() };
	},

	actions: {
		"projects.list": async (_req, ctx) => {
			const { projects, sources, errors } = ctx.supervisor.definitions;
			return { projects, sources, errors } satisfies ProjectsListResult;
		},

		"projects.reload": async (_req, ctx) => {
			requireControl(ctx);
			const loaded = await ctx.supervisor.load();
			return {
				projects: loaded.projects,
				sources: loaded.sources,
				errors: loaded.errors,
			} satisfies ProjectsListResult;
		},

		"project.action": async (req, ctx) => {
			requireControl(ctx);
			const p = (req.params ?? {}) as unknown as ProjectActionParams;
			const { supervisor } = ctx;
			if (p.verb === "start") await supervisor.start(p.projectId, p.processId);
			else if (p.verb === "stop")
				await supervisor.stop(p.projectId, p.processId);
			else if (p.verb === "restart")
				await supervisor.restart(p.projectId, p.processId);
			else throw new RemoteError("bad_request", `unknown verb '${p.verb}'`);
			return { ok: true, projects: await supervisor.status() };
		},
	},
};
