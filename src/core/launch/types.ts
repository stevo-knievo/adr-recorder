import type { Env } from "../harness/types.ts";

/** A review agent to open somewhere. Built by startReview. */
export interface LaunchJob {
	/** Project root; the agent starts here. */
	cwd: string;
	/** Short label for the tab, pane or window. */
	title: string;
	/** POSIX shell command that runs the agent interactively. */
	command: string;
	/** POSIX shell command for a run with no human, that exits when done. */
	headlessCommand: string;
	/** Where a headless run's output goes. */
	logFile: string;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Side effects launchers may use. Injected, so launchers are testable without any host. */
export interface System {
	env: Env;
	/** Run a short command and wait for it. */
	run(
		argv: string[],
		opts?: { cwd?: string; timeoutMs?: number; stdin?: string },
	): Promise<RunResult>;
	/** Start a long command and don't wait. Output goes to logFile, or nowhere. */
	spawnDetached(argv: string[], opts?: { cwd?: string; logFile?: string }): void;
}

/**
 * A place a review agent can open: a terminal multiplexer, a terminal with
 * remote control, a background process. Add one by writing a file in this
 * folder and registering it in index.ts (or at runtime with registerLauncher).
 */
export interface Launcher {
	/** Used in `review_launcher:`. Lowercase, no spaces. */
	readonly name: string;
	readonly description: string;
	/** True when this process runs inside the host, judged from the environment. */
	detect(env: Env): boolean;
	/**
	 * Open the agent. Resolves with a short note on where it went, rejects when
	 * the host refused, so the caller can fall back.
	 */
	launch(job: LaunchJob, sys: System): Promise<string>;
}
