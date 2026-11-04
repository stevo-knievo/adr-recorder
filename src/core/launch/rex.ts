import type { Launcher } from "./types.ts";
import { check, interactiveShell } from "./util.ts";

/** Rex terminal: a new block. https://rex.dev */
export const rexLauncher: Launcher = {
	name: "rex",
	description: "new Rex block (inside Rex)",
	detect: (env) => Boolean(env.REX_SESSION),
	async launch(job, sys) {
		check(
			"rex run",
			await sys.run(
				["rex", "run", "--cwd", job.cwd, "--", ...interactiveShell(sys.env, job.command)],
				{
					timeoutMs: 15_000,
				},
			),
		);
		return "new Rex block";
	},
};
