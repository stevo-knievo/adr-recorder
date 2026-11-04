import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { piSessionFromBranch } from "../../src/core/harness/pi.ts";
import { resolveLayout } from "../../src/core/layout.ts";
import {
	buildReviewPrompt,
	listReviewReports,
	openNotes,
	REVIEW_MARKER,
	reviewReportPath,
} from "../../src/core/review.ts";
import { scanSession } from "../../src/core/scan.ts";
import { toExchanges } from "../../src/core/transcript.ts";
import {
	decision,
	fakeClassifier,
	loadSessionFixture,
	sessionFixturePath,
	tempRepo,
} from "../helpers.ts";

async function repoWithNotes() {
	const root = tempRepo("docs-adr");
	const layout = resolveLayout(root);
	const { classifier } = fakeClassifier({}, decision());
	await scanSession(loadSessionFixture("todo-api"), {
		layout,
		classifier,
		now: () => new Date("2026-11-03T12:00:00Z"),
	});
	return { root, layout };
}

describe("buildReviewPrompt", () => {
	it("names folders, notes, sessions, routing and the report", async () => {
		const { layout } = await repoWithNotes();
		const notes = openNotes(layout);
		expect(notes.length).toBeGreaterThan(0);
		const prompt = buildReviewPrompt({
			layout,
			notes,
			sessionFiles: ["/s/one.jsonl"],
			reportPath: "docs/adr/_backlog/_review-2026-11-03_1200.md",
			headless: false,
		});
		expect(prompt.startsWith(REVIEW_MARKER)).toBe(true);
		expect(prompt).toContain("- docs/adr (backlog docs/adr/_backlog)");
		expect(prompt).toContain(notes[0]?.file);
		expect(prompt).toContain("- /s/one.jsonl");
		expect(prompt).toContain("| adr | docs/adr/ (next number, from the template) |");
		expect(prompt).toContain("| glossary | GLOSSARY.md |");
		expect(prompt).toContain("| agents | CLAUDE.md |");
		expect(prompt).toContain("Report file: docs/adr/_backlog/_review-2026-11-03_1200.md");
		expect(prompt).toContain("ask before changing any file outside the backlog");
		expect(prompt).not.toMatch(/\{\w+\}/);
	});

	it("headless runs only write the report", async () => {
		const { layout } = await repoWithNotes();
		const prompt = buildReviewPrompt({
			layout,
			notes: openNotes(layout),
			sessionFiles: [],
			reportPath: "r.md",
			headless: true,
		});
		expect(prompt).toContain("Write the report and nothing else");
		expect(prompt).not.toContain("After they agree");
	});
});

describe("reviewReportPath", () => {
	it("uses local time in the main backlog", () => {
		const layout = resolveLayout(tempRepo("docs-adr"));
		expect(reviewReportPath(layout, new Date(2026, 10, 3, 9, 5))).toBe(
			"docs/adr/_backlog/_review-2026-11-03_0905.md",
		);
	});
});

describe("listReviewReports", () => {
	it("counts proposals and ignores notes", async () => {
		const { root, layout } = await repoWithNotes();
		const dir = join(root, layout.backlogDir);
		writeFileSync(join(dir, "_review-2026-11-03_1200.md"), "Intro\n\n### a.md\nx\n\n### b.md\ny\n");
		const reports = listReviewReports(layout);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({
			file: "docs/adr/_backlog/_review-2026-11-03_1200.md",
			proposals: 2,
		});
		// Review reports are not notes.
		expect(openNotes(layout).some((n) => n.file.includes("_review-"))).toBe(false);
	});

	it("returns nothing without a backlog", () => {
		expect(listReviewReports(resolveLayout(tempRepo("none")))).toEqual([]);
	});
});

describe("live capture helpers", () => {
	it("piSessionFromBranch matches the file parser", () => {
		const file = sessionFixturePath("todo-api");
		const lines = readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const [header, ...entries] = lines;
		const live = piSessionFromBranch(header, entries, file);
		expect(live.turns).toEqual(loadSessionFixture("todo-api").turns);
		expect(live.id).toBe(header.id);
	});

	it("scanSession honours the filter and skips review requests", async () => {
		const root = tempRepo("docs-adr");
		const session = loadSessionFixture("todo-api");
		const exchanges = toExchanges(session.turns);
		const last = exchanges.at(-1);
		const { classifier, calls } = fakeClassifier({}, decision());
		await scanSession(session, {
			layout: resolveLayout(root),
			classifier,
			filter: (ex) => ex.anchor === last?.anchor,
		});
		expect(calls.every((c) => c.exchange.anchor === last?.anchor)).toBe(true);

		const reviewTurn = { ...session.turns[0], text: `${REVIEW_MARKER} we'll go with Postgres` };
		const review = { ...session, turns: [reviewTurn as (typeof session.turns)[0]] };
		const r = await scanSession(review, { layout: resolveLayout(root), classifier });
		expect(r).toEqual([]);
	});
});
