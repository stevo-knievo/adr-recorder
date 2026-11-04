import type { Launcher } from "./types.ts";
import { check } from "./util.ts";

/** herdr workspace manager: a new tab, then the command typed into its shell. */
export const herdrLauncher: Launcher = {
	name: "herdr",
	description: "new herdr tab (inside herdr)",
	detect: (env) => env.HERDR_ENV === "1",
	async launch(job, sys) {
		const created = check(
			"herdr tab create",
			await sys.run(["herdr", "tab", "create", "--cwd", job.cwd, "--label", job.title, "--focus"], {
				timeoutMs: 15_000,
			}),
		);
		let pane: string | undefined;
		try {
			pane = JSON.parse(created.stdout)?.result?.root_pane?.pane_id;
		} catch {
			// handled below
		}
		if (!pane) throw new Error(`herdr tab create: no pane id in ${created.stdout.slice(0, 200)}`);
		// The pane runs the user's interactive shell, so the command needs no wrapper.
		check(
			"herdr pane run",
			await sys.run(["herdr", "pane", "run", pane, job.command], { timeoutMs: 15_000 }),
		);
		return `herdr tab ${job.title} (${pane})`;
	},
};
