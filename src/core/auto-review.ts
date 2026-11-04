import { join } from "node:path";
import type { System } from "./launch/index.ts";
import { type Project, sessionNotes } from "./project.ts";
import { listReviewReports } from "./review.ts";
import { type StartedReview, startReview } from "./review-start.ts";
import { readJson, writeJson } from "./state.ts";

export interface ExitReviewInput {
	project: Project;
	harness: string;
	sessionId: string;
	sys: System;
	home: string;
	stateDir: string;
	/** Asked when auto_review is "ask". Without it, "ask" starts nothing. */
	confirm?: () => Promise<boolean>;
}

export type ExitReviewResult =
	| { started: StartedReview }
	| { skipped: "off" | "no-new-notes" | "declined" | "nothing-open" };

/**
 * What every adapter does when a session ends for good: review this
 * session's open notes once. Resume and quit again doesn't review them twice.
 * Throws when the launch itself fails, so the adapter can say why.
 */
export async function reviewOnExit(input: ExitReviewInput): Promise<ExitReviewResult> {
	const { project: p } = input;
	if (p.config.auto_review === "off") return { skipped: "off" };
	const file = join(input.stateDir, "launched-reviews.json");
	const key = input.harness === "pi" ? input.sessionId : `${input.harness}:${input.sessionId}`;
	const reviewed = readJson<Record<string, string[]>>(file, {});
	const done = new Set(reviewed[key] ?? []);
	const open = sessionNotes(p, input.harness, input.sessionId).filter((n) => n.status === "open");
	if (!open.some((n) => !done.has(n.id))) return { skipped: "no-new-notes" };
	if (p.config.auto_review === "ask" && !(await input.confirm?.())) return { skipped: "declined" };
	const started = await startReview({
		layout: p.layout,
		config: p.config,
		harness: input.harness,
		sys: input.sys,
		home: input.home,
		stateDir: input.stateDir,
	});
	if (!started) return { skipped: "nothing-open" };
	reviewed[key] = [...done, ...open.map((n) => n.id)];
	writeJson(file, reviewed);
	return { started };
}

/**
 * The newest review report the human hasn't been told about, if any. Marks
 * all current reports as seen, so each one is announced once.
 */
export function takeNewReviewReport(
	p: Project,
	stateDir: string,
): { file: string; proposals: number } | undefined {
	const reports = listReviewReports(p.layout);
	if (!reports.length) return undefined;
	const file = join(stateDir, "seen-reviews.json");
	const seen = readJson<Record<string, true>>(file, {});
	const fresh = reports.filter((r) => !seen[join(p.root, r.file)]);
	if (!fresh.length) return undefined;
	for (const r of fresh) seen[join(p.root, r.file)] = true;
	writeJson(file, seen);
	return fresh[0];
}

export function reviewReadyMessage(r: { file: string; proposals: number }): string {
	return `ADR review ready: ${r.proposals} proposals (${r.file})`;
}
