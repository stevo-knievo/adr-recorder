import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLayout } from "../../src/core/layout.ts";
import {
	buildReviewLaunch,
	buildReviewPrompt,
	listReviewReports,
	openNotes,
	REVIEW_MARKER,
	reviewReportPath,
	shq,
} from "../../src/core/review.ts";
import { scanSession } from "../../src/core/scan.ts";
import { piSessionFromBranch, toExchanges } from "../../src/core/transcript.ts";
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

describe("buildReviewLaunch", () => {
	const base = { cwd: "/repo it's", model: "p/m", promptFile: "/tmp/p.md", logFile: "/tmp/l.log" };

	it("runs pi headless by default with the recursion guard", () => {
		const l = buildReviewLaunch(base);
		expect(l.env).toEqual({ ADR_REVIEW_CHILD: "1" });
		expect(l.shell).toBe(
			`cd '/repo it'\\''s' && ADR_REVIEW_CHILD=1 pi -p --model 'p/m' "$(cat '/tmp/p.md')" > '/tmp/l.log' 2>&1`,
		);
	});

	it("fills a template with quoted values", () => {
		const l = buildReviewLaunch({
			...base,
			template: "rex run --cwd {cwd} -- $SHELL -ic {command}",
		});
		expect(l.shell).toBe(
			`rex run --cwd '/repo it'\\''s' -- $SHELL -ic ${shq(`ADR_REVIEW_CHILD=1 pi --model 'p/m' "$(cat '/tmp/p.md')"`)}`,
		);
	});

	it("offers the headless run as a template fallback", () => {
		const l = buildReviewLaunch({
			...base,
			headlessPromptFile: "/tmp/h.md",
			template: 'if [ -n "$REX_SESSION" ]; then rex run -- {command}; else {headless}; fi',
		});
		expect(l.shell).toContain(`else { cd '/repo it'\\''s' && ADR_REVIEW_CHILD=1 pi -p`);
		expect(l.shell).toContain(`"$(cat '/tmp/h.md')"`);
		expect(l.shell).toContain(shq(`ADR_REVIEW_CHILD=1 pi --model 'p/m' "$(cat '/tmp/p.md')"`));
	});

	it("survives a real shell round trip", () => {
		const dir = tempRepo("none");
		const promptFile = join(dir, "prompt.md");
		writeFileSync(promptFile, `Say "hi" and it's $HOME \`x\``);
		const bin = join(dir, "bin");
		mkdirSync(bin);
		const stub = join(bin, "pi");
		writeFileSync(stub, `#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n`, { mode: 0o755 });
		const l = buildReviewLaunch({
			cwd: dir,
			model: "p/m",
			promptFile,
			logFile: join(dir, "out.log"),
			piBin: stub,
		});
		execFileSync("sh", ["-c", l.shell]);
		expect(readFileSync(join(dir, "out.log"), "utf8")).toBe(
			'[-p]\n[--model]\n[p/m]\n[Say "hi" and it\'s $HOME `x`]\n',
		);
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
