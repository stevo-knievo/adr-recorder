import type { Launcher } from "./types.ts";
import { check, interactiveShell } from "./util.ts";

export const weztermLauncher: Launcher = {
	name: "wezterm",
	description: "new WezTerm tab (inside WezTerm)",
	detect: (env) => Boolean(env.WEZTERM_PANE),
	async launch(job, sys) {
		check(
			"wezterm cli spawn",
			await sys.run(
				[
					"wezterm",
					"cli",
					"spawn",
					"--cwd",
					job.cwd,
					"--",
					...interactiveShell(sys.env, job.command),
				],
				{ timeoutMs: 15_000 },
			),
		);
		return "WezTerm tab";
	},
};
