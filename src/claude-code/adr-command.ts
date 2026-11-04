import { readFileSync } from "node:fs";
import { captureSession, isReviewChild } from "../core/capture.ts";
import { REPO_CONFIG_FILE } from "../core/config.ts";
import { parseClaudeSession } from "../core/harness/claude-code.ts";
import { hasAdrFolder } from "../core/layout.ts";
import {
	loadProject,
	projectEnablement,
	setRepoAdrDir,
	statusReport,
	writeManualNote,
} from "../core/project.ts";
import { startReview } from "../core/review-start.ts";
import { summarizeResults, tildify } from "../core/scan.ts";
import { type Deps, findTranscript, HARNESS, readOverride, writeOverride } from "./context.ts";

export const SUBCOMMANDS = ["on", "off", "status", "note", "scan", "review"];

/**
 * Backend of the `/adr` skill. Claude runs it with its Bash tool and shows
 * the output, so everything here prints plain text and returns an exit code.
 */
export async function adrCommand(
	session: { id: string; cwd: string },
	args: string[],
	d: Deps,
): Promise<number> {
	const cenv = { home: d.home, env: d.env };
	let project = loadProject(session.cwd, cenv);
	const [sub = "status", ...restParts] = args.join(" ").trim().split(/\s+/).filter(Boolean);
	const rest = restParts.join(" ");
	const transcript = findTranscript(d, session.id, session.cwd);
	const say = (s: string) => d.out(`${s}\n`);
	const reviewChild = () =>
		transcript
			? isReviewChild(d, parseClaudeSession(readFileSync(transcript, "utf8"), transcript))
			: d.env.ADR_REVIEW_CHILD === "1";
	const enablement = () =>
		projectEnablement(project, {
			override: readOverride(d, session.id),
			reviewChild: reviewChild(),
		});

	switch (sub) {
		case "status":
			say(
				statusReport(
					project,
					enablement(),
					{ harness: HARNESS, id: session.id },
					{ needEndpoint: true },
				),
			);
			return 0;
		case "on": {
			if (!hasAdrFolder(project.layout) && !project.config.repo.adr_dir) {
				const dir = rest || "docs/adr";
				setRepoAdrDir(project.root, dir);
				project = loadProject(project.root, cenv);
				say(`ADR folder set to ${dir} in ${REPO_CONFIG_FILE}`);
			}
			writeOverride(d, session.id, true);
			const en = enablement();
			say(`ADR recorder: ${en.enabled ? "on" : "off"} (${en.reason})`);
			return 0;
		}
		case "off":
			writeOverride(d, session.id, false);
			say("ADR recorder: off (/adr off)");
			return 0;
		case "note": {
			if (!rest) {
				say("Usage: /adr note <decision>");
				return 2;
			}
			const file = writeManualNote(project, {
				harness: HARNESS,
				sessionId: session.id,
				sessionFile: transcript ? tildify(transcript, d.home) : "",
				anchor: "manual",
				text: rest,
				now: d.now?.(),
			});
			say(file ? `ADR note: ${file}` : "ADR note already exists");
			return 0;
		}
		case "scan": {
			if (!transcript) {
				say(`No transcript found for session ${session.id}`);
				return 1;
			}
			const r = await captureSession(
				{ harness: HARNESS, transcript, sessionId: session.id, cwd: session.cwd, all: true },
				d,
			);
			if ("results" in r) say(summarizeResults(r.results));
			else if ("queued" in r) say("ADR recorder: a capture is running; it will pick this up");
			else say(`ADR recorder: ${r.skipped}`);
			return 0;
		}
		case "review": {
			const started = await startReview({
				layout: project.layout,
				config: project.config,
				harness: HARNESS,
				sys: d.sys,
				home: d.home,
				stateDir: d.stateDir,
			});
			if (!started) say("ADR backlog has no open notes");
			else {
				say(`ADR review: ${started.notes} open note(s), ${started.launcher} (${started.where})`);
				if (started.fallbackReason)
					say(`launcher failed (${started.fallbackReason}); running headless`);
				say(`report: ${started.reportPath}`);
			}
			return 0;
		}
		default:
			say(`Unknown: /adr ${sub}. Use ${SUBCOMMANDS.join(" | ")}`);
			return 2;
	}
}
