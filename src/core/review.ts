import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./layout.ts";
import { type BacklogEntry, readBacklog } from "./notes.ts";

/**
 * Marks review requests. A pi session whose first prompt contains it is a
 * review agent: it must not record or start another review.
 */
export const REVIEW_MARKER = "[adr-recorder:review]";
export const REVIEW_CHILD_ENV = "ADR_REVIEW_CHILD";

export function openNotes(layout: Layout): BacklogEntry[] {
	return layout.folders
		.flatMap((f) => readBacklog(layout.root, f.backlog))
		.filter((n) => n.status === "open");
}

/** `_review-YYYY-MM-DD_HHMM.md` in the main backlog folder, local time. */
export function reviewReportPath(layout: Layout, now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
	return `${layout.backlogDir}/_review-${stamp}.md`;
}

const ROUTING = `| Target | Lands in |
| --- | --- |
| adr | {adr} (next number, from the template) |
| rfc | {rfc} |
| spec | {spec} |
| runbook | {runbook} |
| standard | {standard} |
| agents | {agents} |
| decision_log | {decision_log} (one line: date, decision, who, link) |
| readme | {readme} |
| glossary | {glossary} |
| tooling | the linter, formatter or editorconfig file that enforces it |
| discard | nothing, one-line reason |`;

export interface ReviewPromptInput {
	layout: Layout;
	notes: BacklogEntry[];
	/** Transcripts the notes came from, for context. */
	sessionFiles: string[];
	reportPath: string;
	/** Headless review: write the report only, change nothing else. */
	headless: boolean;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
	const { layout } = input;
	const routing = ROUTING.replace("{adr}", `${layout.adrDir}/`).replace(
		/\{(\w+)\}/g,
		(_, k: string) => layout.targets[k as keyof Layout["targets"]] ?? k,
	);
	const folders = layout.folders.map((f) => `- ${f.dir} (backlog ${f.backlog})`).join("\n");
	const notes =
		input.notes.map((n) => `- ${n.file}: ${n.decision.split("\n")[0]}`).join("\n") || "- (none)";
	const sessions = input.sessionFiles.map((f) => `- ${f}`).join("\n") || "- (none)";
	const template = layout.template
		? `Template: ${layout.template} (${layout.templateKind ?? "custom"}). Drafts follow it exactly.`
		: "No template found. Use Nygard sections: Status, Context, Decision, Consequences.";
	const changes = input.headless
		? `This is a headless run and nobody is there to answer questions. Write the report and nothing else. Do not edit any other file, do not change note status, do not commit. Writing this one report into the backlog folder of the current checkout is the whole task: it needs no branch, worktree or commit, so branch and worktree rules for code changes don't apply to it.`
		: `Write the report first. Then show the human the proposals and ask before changing any file outside the backlog folders. After they agree, apply each accepted proposal and update its note: status (promoted | moved | merged | discarded) and resolved_to (the file it went to). Never edit an accepted ADR; superseding means a new ADR that links the old one. Do not commit.`;
	return `${REVIEW_MARKER}
Review the ADR backlog of the repository at ${layout.root}.

ADR folders:
${folders}
Numbering: ${layout.numbering}. Statuses in use: ${layout.statuses.join(", ")}.
${template}

Open notes:
${notes}

Sessions the notes came from (JSONL transcripts, read them when a note needs context; each note's anchor field is the entry id):
${sessions}

Routing table:
${routing}

For each open note decide one of:
- promote: draft the ADR (title, number, full text from the template, status from the repo's first status, usually Proposed).
- merge: it repeats another note or an existing ADR; name which.
- move: it belongs in a lighter target; give the exact file and the exact text to add. Prefer existing files over new ones. A rule a tool can enforce goes into that tool's config.
- discard: one-line reason.

Check every note against the existing ADRs first. Several notes about the same decision become one proposal.

Report file: ${input.reportPath}
Format: a short intro line, then one "### <note file>" section per note with "Proposal:", "Target:", and the drafted text in a fenced block. Plain language, no filler, no signature or footer.

${changes}`;
}

export interface PreparedReview {
	notes: BacklogEntry[];
	prompt: string;
	reportPath: string;
	sessionFiles: string[];
}

/** Everything a reviewer needs, from the open notes in the backlog. */
export function prepareReview(
	layout: Layout,
	opts: { headless: boolean; now: Date; home: string },
): PreparedReview {
	const notes = openNotes(layout);
	const sessionFiles = [
		...new Set(
			notes
				.map((n) => n.sessionFile)
				.filter(Boolean)
				.map((f) => (f.startsWith("~/") ? join(opts.home, f.slice(2)) : f)),
		),
	];
	const reportPath = reviewReportPath(layout, opts.now);
	const prompt = buildReviewPrompt({
		layout,
		notes,
		sessionFiles,
		reportPath,
		headless: opts.headless,
	});
	return { notes, prompt, reportPath, sessionFiles };
}

/** Review reports in the main backlog folder, newest first. */
export function listReviewReports(
	layout: Layout,
): { file: string; mtimeMs: number; proposals: number }[] {
	const dir = join(layout.root, layout.backlogDir);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((n) => /^_review-.*\.md$/.test(n))
		.map((n) => {
			const abs = join(dir, n);
			const text = readFileSync(abs, "utf8");
			return {
				file: `${layout.backlogDir}/${n}`,
				mtimeMs: statSync(abs).mtimeMs,
				proposals: (text.match(/^### /gm) ?? []).length,
			};
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
