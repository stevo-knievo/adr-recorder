import type { Launcher } from "./types.ts";
import { check, interactiveShell } from "./util.ts";

/** Needs kitty remote control (allow_remote_control and listen_on). */
export const kittyLauncher: Launcher = {
	name: "kitty",
	description: "new kitty tab (kitty with remote control on)",
	detect: (env) => Boolean(env.KITTY_LISTEN_ON),
	async launch(job, sys) {
		check(
			"kitty @ launch",
			await sys.run(
				[
					"kitty",
					"@",
					"launch",
					"--type=tab",
					"--cwd",
					job.cwd,
					"--tab-title",
					job.title,
					...interactiveShell(sys.env, job.command),
				],
				{ timeoutMs: 15_000 },
			),
		);
		return `kitty tab ${job.title}`;
	},
};
