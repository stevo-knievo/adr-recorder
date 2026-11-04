import type { Env } from "../harness/types.ts";
import { commandLauncher } from "./command.ts";
import { headlessLauncher } from "./headless.ts";
import { herdrLauncher } from "./herdr.ts";
import { kittyLauncher } from "./kitty.ts";
import { rexLauncher } from "./rex.ts";
import { tmuxLauncher } from "./tmux.ts";
import type { Launcher } from "./types.ts";
import { weztermLauncher } from "./wezterm.ts";
import { zellijLauncher } from "./zellij.ts";

export type { Launcher, LaunchJob, RunResult, System } from "./types.ts";

/**
 * Checked in this order for `review_launcher: auto`. Multiplexers come before
 * terminals: inside tmux running in WezTerm, a tmux window is the closer fit.
 */
const registry: Launcher[] = [
	tmuxLauncher,
	zellijLauncher,
	herdrLauncher,
	rexLauncher,
	weztermLauncher,
	kittyLauncher,
];

/** Add a launcher at runtime. It is tried before the built-in ones. */
export function registerLauncher(l: Launcher): void {
	const i = registry.findIndex((x) => x.name === l.name);
	if (i >= 0) registry.splice(i, 1);
	registry.unshift(l);
}

export function listLaunchers(): Launcher[] {
	return [...registry, headlessLauncher];
}

/**
 * Turn `review_launcher` into a launcher. "auto" picks the first host that
 * detects itself and falls back to headless; "command" uses review_command.
 */
export function pickLauncher(name: string, env: Env, template?: string): Launcher {
	if (name === "auto") return registry.find((l) => l.detect(env)) ?? headlessLauncher;
	if (name === "command") {
		if (!template) throw new Error("review_launcher: command needs review_command");
		return commandLauncher(template);
	}
	const l = listLaunchers().find((x) => x.name === name);
	if (!l) {
		const names = [...listLaunchers().map((x) => x.name), "auto", "command"].join(", ");
		throw new Error(`Unknown review_launcher: ${name} (one of ${names})`);
	}
	return l;
}

export { headlessLauncher };
