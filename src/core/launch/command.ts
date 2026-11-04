import { shq } from "../shell.ts";
import type { Launcher } from "./types.ts";

export const COMMAND_PLACEHOLDERS = ["cwd", "title", "command", "headless"] as const;

/**
 * Fill a `review_command` template. Values are shell-quoted, so `{command}`
 * is one argument: `my-mux open --dir {cwd} -- sh -ic {command}`.
 */
export function fillTemplate(
	template: string,
	vars: Record<(typeof COMMAND_PLACEHOLDERS)[number], string>,
): string {
	return template.replace(/\{(cwd|title|command|headless)\}/g, (_, k: keyof typeof vars) =>
		shq(vars[k]),
	);
}

/** Any host without a built-in launcher: the user's own shell template. */
export function commandLauncher(template: string): Launcher {
	return {
		name: "command",
		description: "review_command from the user config",
		detect: () => false,
		async launch(job, sys) {
			const shell = fillTemplate(template, {
				cwd: job.cwd,
				title: job.title,
				command: job.command,
				headless: job.headlessCommand,
			});
			sys.spawnDetached(["sh", "-c", shell], { cwd: job.cwd, logFile: job.logFile });
			return "review_command";
		},
	};
}
