import type { Launcher } from "./types.ts";
import { check, interactiveShell } from "./util.ts";

export const zellijLauncher: Launcher = {
	name: "zellij",
	description: "new zellij pane (inside zellij)",
	detect: (env) => Boolean(env.ZELLIJ),
	async launch(job, sys) {
		check(
			"zellij run",
			await sys.run(
				[
					"zellij",
					"run",
					"--cwd",
					job.cwd,
					"--name",
					job.title,
					"--",
					...interactiveShell(sys.env, job.command),
				],
				{ timeoutMs: 15_000 },
			),
		);
		return `zellij pane ${job.title}`;
	},
};
