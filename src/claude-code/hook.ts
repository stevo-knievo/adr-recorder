import { join } from "node:path";
import { reviewReadyMessage, takeNewReviewReport } from "../core/auto-review.ts";
import { loadProject, projectEnablement } from "../core/project.ts";
import { REVIEW_CHILD_ENV } from "../core/review.ts";
import { type Deps, type HookInput, readOverride } from "./context.ts";

/** Room for the end of the last reply; enough to recognise it in the transcript. */
const EXPECT_CHARS = 200;

/** Where detached workers write their output. */
export const captureLog = (d: Deps) => join(d.stateDir, "claude-code", "capture.log");

/**
 * Entry point for every hook. It must return fast (SessionEnd gets 1.5s in
 * total), so it only checks cheap things and hands the model work to a
 * detached `claude-code capture` worker.
 */
export function handleHook(input: HookInput, d: Deps): void {
	if (d.env[REVIEW_CHILD_ENV] === "1") return;
	const { session_id: sessionId, transcript_path: transcript } = input;
	const cwd = input.cwd || d.env.CLAUDE_PROJECT_DIR;
	if (!sessionId || !cwd) return;
	const project = loadProject(cwd, { home: d.home, env: d.env });

	if (input.hook_event_name === "SessionStart") {
		const report = takeNewReviewReport(project, d.stateDir);
		if (report) d.out(`${JSON.stringify({ systemMessage: reviewReadyMessage(report) })}\n`);
		return;
	}
	if (!transcript) return;
	if (!projectEnablement(project, { override: readOverride(d, sessionId) }).enabled) return;

	const argv = [...d.self, "claude-code", "capture"];
	argv.push("--transcript", transcript, "--session", sessionId, "--cwd", cwd);
	switch (input.hook_event_name) {
		case "Stop":
			if (input.stop_hook_active) return;
			if (input.last_assistant_message)
				// "=" form: the text may start with "-".
				argv.push(`--expect=${input.last_assistant_message.trim().slice(-EXPECT_CHARS)}`);
			break;
		case "PreCompact":
			break;
		case "SessionEnd":
			argv.push("--final", "--reason", input.reason ?? "other");
			break;
		default:
			return;
	}
	d.sys.spawnDetached(argv, { cwd, logFile: captureLog(d) });
}
