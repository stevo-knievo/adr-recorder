import type { Launcher } from "./types.ts";
import { check, interactiveShell } from "./util.ts";

export const tmuxLauncher: Launcher = {
	name: "tmux",
	description: "new tmux window (inside tmux)",
	detect: (env) => Boolean(env.TMUX),
	async launch(job, sys) {
		check(
			"tmux new-window",
			await sys.run(
				[
					"tmux",
					"new-window",
					"-c",
					job.cwd,
					"-n",
					job.title,
					...interactiveShell(sys.env, job.command),
				],
				{ timeoutMs: 15_000 },
			),
		);
		return `tmux window ${job.title}`;
	},
};
