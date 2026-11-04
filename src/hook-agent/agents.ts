/**
 * Agents that speak the Claude Code hook protocol: hook JSON on stdin with
 * session_id, transcript_path, cwd and hook_event_name, a Stop hook with
 * last_assistant_message, and a SessionEnd hook with a short time limit.
 * Claude Code and Codex both do. Everything that differs between them is
 * in this profile; the rest of this folder is shared.
 *
 * Add an agent: write its harness (src/core/harness/<name>.ts, with
 * `findSession`), add a profile here, ship its hooks file and /adr skill.
 */
export interface HookAgent {
	/** Harness name: the CLI command (`adr-recorder <name> hook`) and `harness:` in notes. */
	readonly harness: string;
	/** Shown in help text. */
	readonly label: string;
	/** SessionEnd reasons after which the human is done with the session. */
	readonly quitReasons: ReadonlySet<string>;
	/** Env var with the project folder, for hook input without a cwd. */
	readonly projectDirEnv?: string;
}

export const claudeCodeAgent: HookAgent = {
	harness: "claude-code",
	label: "Claude Code",
	// "clear" and "resume" go on in a new session; the human isn't done.
	quitReasons: new Set(["prompt_input_exit", "logout", "other"]),
	projectDirEnv: "CLAUDE_PROJECT_DIR",
};

export const codexAgent: HookAgent = {
	harness: "codex",
	label: "Codex",
	// Codex only sends "other" so far.
	quitReasons: new Set(["other"]),
};

const registry = new Map([claudeCodeAgent, codexAgent].map((a) => [a.harness, a]));

export const getHookAgent = (name: string | undefined) => (name ? registry.get(name) : undefined);
export const listHookAgents = () => [...registry.values()];
