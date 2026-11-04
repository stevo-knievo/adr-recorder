import type { Env } from "../harness/types.ts";
import type { RunResult } from "./types.ts";

/**
 * argv that runs `command` in the user's interactive shell, so tokens and
 * PATH from their shell config are there. Hosts that start commands directly
 * (not by typing into a shell) need this.
 */
export function interactiveShell(env: Env, command: string): string[] {
	return [env.SHELL || "/bin/sh", "-ic", command];
}

/** Throw with the host's own message when a command failed. */
export function check(what: string, r: RunResult): RunResult {
	if (r.code !== 0) {
		const msg = (r.stderr || r.stdout).trim().split("\n")[0] ?? "";
		throw new Error(`${what} exited ${r.code}${msg ? `: ${msg}` : ""}`);
	}
	return r;
}
