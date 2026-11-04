import type { Launcher } from "./types.ts";

/** Background run with no human. Always available; the fallback for every other launcher. */
export const headlessLauncher: Launcher = {
	name: "headless",
	description: "background run that writes the review report only",
	detect: () => true,
	async launch(job, sys) {
		sys.spawnDetached(["sh", "-c", job.headlessCommand], { cwd: job.cwd, logFile: job.logFile });
		return `background run, log ${job.logFile}`;
	},
};
