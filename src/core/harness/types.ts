import type { Session } from "../types.ts";

export type Env = Record<string, string | undefined>;

export interface FoundSession {
	harness: string;
	file: string;
	id: string;
	cwd: string;
	started: string;
}

/** What a reviewer run needs. The prompt sits in a file because it is long. */
export interface ReviewerRun {
	cwd: string;
	model: string;
	promptFile: string;
	/** How to start the agent, from `agent_commands`. Each harness has a default. */
	bin?: string;
}

/** Reads one agent's past sessions. Needed for `scan` and live capture. */
export interface SessionSource {
	/** Stored in notes as `harness:`. Lowercase, no spaces. */
	readonly name: string;
	/** Default folder with this agent's session files. */
	sessionsDir(env: Env, home: string): string;
	/** Sessions whose working folder is `project` or a folder inside it. */
	findSessions(sessionsDir: string, project: string, since?: Date): FoundSession[];
	/** Parse a session file into turns on its active branch. */
	loadSession(file: string): Session;
	/** The file of one session by id, for agents that give hooks only the id. */
	findSession?(sessionsDir: string, sessionId: string, cwd: string): string | undefined;
}

/** Starts one agent as a reviewer. Needed for `review`. */
export interface ReviewerAgent {
	readonly name: string;
	/**
	 * Shell command that starts the agent interactively with the prompt from
	 * `run.promptFile`. Runs in a POSIX shell inside a new pane or window, and
	 * must set ADR_REVIEW_CHILD=1 for the agent.
	 */
	reviewerCommand(run: ReviewerRun): string;
	/** Same, but non-interactive: prints its answer and exits. */
	headlessReviewerCommand(run: ReviewerRun): string;
}

/**
 * One coding agent (pi, Claude Code, Codex, ...). A harness may implement only
 * one side: a new agent can be scanned before it can review, or the other way
 * round. Add one by writing a file in this folder and registering it in
 * index.ts (or at runtime with registerHarness).
 */
export interface HarnessAdapter {
	readonly name: string;
	sessions?: SessionSource;
	reviewer?: ReviewerAgent;
}
