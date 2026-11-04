import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CaptureDeps } from "../core/capture.ts";
import { claudeSessionsDir, encodeClaudeProjectDir } from "../core/harness/claude-code.ts";
import {
	readOverride as readOverrideFor,
	writeOverride as writeOverrideFor,
} from "../core/state.ts";

export const HARNESS = "claude-code";

/** Fields Claude Code sends on stdin to every hook (plus a few per event). */
export interface HookInput {
	hook_event_name?: string;
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	/** SessionEnd: clear, resume, logout, prompt_input_exit, other. */
	reason?: string;
	/** Stop: true when a Stop hook already made Claude continue. */
	stop_hook_active?: boolean;
	/** Stop: the reply just finished; the transcript can lag behind it. */
	last_assistant_message?: string;
}

/** Everything the adapter touches, so tests can swap it. */
export interface Deps extends CaptureDeps {
	/** argv that starts this CLI again, for detached workers. */
	self: string[];
	out: (s: string) => void;
}

/** SessionEnd reasons after which the human is done with the session. */
export const QUIT_REASONS = new Set(["prompt_input_exit", "logout", "other"]);

export const readOverride = (d: Deps, sessionId: string) =>
	readOverrideFor(d.stateDir, HARNESS, sessionId);
export const writeOverride = (d: Deps, sessionId: string, on: boolean) =>
	writeOverrideFor(d.stateDir, HARNESS, sessionId, on);

/** The transcript of a session, from the project folder or, failing that, any folder. */
export function findTranscript(d: Deps, sessionId: string, cwd: string): string | undefined {
	const root = claudeSessionsDir(d.env, d.home);
	const direct = join(root, encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
	if (existsSync(direct)) return direct;
	try {
		for (const dir of readdirSync(root)) {
			const f = join(root, dir, `${sessionId}.jsonl`);
			if (existsSync(f)) return f;
		}
	} catch {
		// no sessions folder yet
	}
	return undefined;
}
