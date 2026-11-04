import type { CaptureDeps } from "../core/capture.ts";
import { getHarness } from "../core/harness/index.ts";
import {
	readOverride as readOverrideFor,
	writeOverride as writeOverrideFor,
} from "../core/state.ts";
import type { HookAgent } from "./agents.ts";

/** Fields the agent sends on stdin to every hook (plus a few per event). */
export interface HookInput {
	hook_event_name?: string;
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	/** SessionEnd: why the session ended; see HookAgent.quitReasons. */
	reason?: string;
	/** Stop: true when a Stop hook already made the agent continue. */
	stop_hook_active?: boolean;
	/** Stop: the reply just finished; the transcript can lag behind it. */
	last_assistant_message?: string;
}

/** Everything the adapter touches, so tests can swap it. */
export interface Deps extends CaptureDeps {
	agent: HookAgent;
	/** argv that starts this CLI again, for detached workers. */
	self: string[];
	out: (s: string) => void;
}

export const readOverride = (d: Deps, sessionId: string) =>
	readOverrideFor(d.stateDir, d.agent.harness, sessionId);
export const writeOverride = (d: Deps, sessionId: string, on: boolean) =>
	writeOverrideFor(d.stateDir, d.agent.harness, sessionId, on);

/** The transcript of a session, found by its id. */
export function findTranscript(d: Deps, sessionId: string, cwd: string): string | undefined {
	const src = getHarness(d.agent.harness)?.sessions;
	return src?.findSession?.(src.sessionsDir(d.env, d.home), sessionId, cwd);
}
