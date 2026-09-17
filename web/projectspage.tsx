import { ProjectsBuilder } from "./toolspage.tsx";

/**
 * The projects.json builder, on its own page. It used to sit in Tools
 * alongside the CA and cert panels, which is a lot of fine-grained form state
 * to render in a column squeezed next to two unrelated panels — a project
 * with several processes just doesn't fit there. Nothing here changed but the
 * home it lives in; see ProjectsBuilder in toolspage.tsx for the form itself.
 */
export function ProjectsPage() {
	return (
		<div className="wide-page">
			<header className="page-head">
				<h2>Projects</h2>
				<span className="dim">
					Built here only — nothing is sent anywhere. Blank fields take the
					node's defaults and stay out of the file. Drop the result onto a node
					at <span className="mono">/etc/stats/projects.json</span>, or as a
					file under <span className="mono">/etc/stats/projects.d/</span>.
				</span>
			</header>
			<ProjectsBuilder />
		</div>
	);
}
