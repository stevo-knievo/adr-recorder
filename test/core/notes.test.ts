import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	makeQuote,
	type Note,
	noteFileName,
	noteId,
	parseNote,
	readBacklog,
	redact,
	renderNote,
	slugify,
	writeNote,
} from "../../src/core/notes.ts";
import { tempRepo } from "../helpers.ts";

const note = (over: Partial<Note> = {}): Note => ({
	id: noteId("pi", "s1", "a1"),
	captured: "2026-11-02T16:31:00Z",
	harness: "pi",
	session: "s1",
	session_file: "~/.pi/agent/sessions/x/s1.jsonl",
	anchor: "a1",
	adr_dir: "docs/adr",
	proposed_target: "adr",
	confidence: "medium",
	decided_by: "human",
	signals: ["phrase:go-with", "tool:config-file"],
	related: [],
	status: "open",
	decision: "Use Fastify instead of Express.",
	why: "Framework choice is expensive to reverse.",
	alternatives: ["Express"],
	quote: "Let's go with Fastify instead of Express",
	...over,
});

describe("slugify", () => {
	it("drops filler words and limits length", () => {
		expect(slugify("The project will use Fastify and PostgreSQL for the API")).toBe(
			"use-fastify-postgresql-api",
		);
		expect(slugify("Ünïcode: déjà vu!")).toBe("unicode-deja-vu");
		expect(slugify("???")).toBe("decision");
		expect(slugify("We don't purge rows, it’s soft")).toBe("dont-purge-rows-its-soft");
		expect(slugify("a".repeat(80)).length).toBeLessThanOrEqual(50);
	});
});

describe("noteFileName", () => {
	it("adds -2, -3 on collision", () => {
		const d = new Date("2026-11-02T16:31:00Z");
		const taken = new Set(["2026-11-02_x.md", "2026-11-02_x-2.md"]);
		expect(noteFileName(d, "y", (n) => taken.has(n))).toBe("2026-11-02_y.md");
		expect(noteFileName(d, "x", (n) => taken.has(n))).toBe("2026-11-02_x-3.md");
	});
});

describe("renderNote / parseNote", () => {
	it("has a stable shape and round-trips", () => {
		const text = renderNote(note());
		expect(text).toBe(`---
schema: 1
id: pi:s1:a1
captured: 2026-11-02T16:31:00Z
harness: pi
session: s1
session_file: ~/.pi/agent/sessions/x/s1.jsonl
anchor: a1
adr_dir: docs/adr
proposed_target: adr
confidence: medium
decided_by: human
signals: [phrase:go-with, tool:config-file]
related: []
status: open
---
## Decision
Use Fastify instead of Express.

## Why it matters
Framework choice is expensive to reverse.

## Alternatives mentioned
- Express

## Quote
> Let's go with Fastify instead of Express
`);
		const p = parseNote(text);
		expect(p?.meta.id).toBe("pi:s1:a1");
		expect(p?.meta.signals).toEqual(["phrase:go-with", "tool:config-file"]);
		expect(p?.sections.Decision).toBe("Use Fastify instead of Express.");
	});

	it("placeholder for no alternatives; resolved_to only when set", () => {
		const t = renderNote(
			note({ alternatives: [], resolved_to: "docs/adr/0003-x.md", status: "promoted" }),
		);
		expect(t).toContain("- none mentioned");
		expect(t).toContain("resolved_to: docs/adr/0003-x.md");
		expect(renderNote(note())).not.toContain("resolved_to");
	});

	it("multi-line quotes stay quoted", () => {
		expect(renderNote(note({ quote: "one\ntwo" }))).toContain("> one\n> two\n");
	});

	it("parseNote rejects text without front matter", () => {
		expect(parseNote("# just markdown")).toBeUndefined();
	});
});

describe("redact / makeQuote", () => {
	it("redacts tokens and key=value secrets", () => {
		expect(redact("token glpat-abcdefghijklmnop123")).toBe("token [redacted]");
		expect(redact("use ghp_abcdefghijklmnopqrstuv")).toBe("use [redacted]");
		expect(redact("Authorization: Bearer abc.def.ghi123456789")).toBe(
			"Authorization: Bearer [redacted]",
		);
		expect(redact("api_key=supersecret")).toBe("api_key=[redacted]");
		expect(redact(`blob ${"aB3".repeat(15)} end`)).toBe("blob [redacted] end");
	});
	it("leaves normal text and long file names alone", () => {
		for (const s of [
			"plain text stays",
			"the skeleton_generator_for_tests helper",
			"docs/adr/_backlog/2026-11-03_use-fastify-postgresql-api-database-stack.md",
		]) {
			expect(redact(s)).toBe(s);
		}
	});
	it("quotes at most three non-empty lines", () => {
		expect(makeQuote("a\n\nb\nc\nd")).toBe("a\nb\nc");
		expect(makeQuote("x ".repeat(400)).length).toBeLessThanOrEqual(300);
	});
});

describe("writeNote / readBacklog", () => {
	it("writes once per id; dry run writes nothing", () => {
		const root = tempRepo();
		const date = new Date("2026-11-02T16:31:00Z");
		const backlog = "docs/adr/_backlog";
		expect(writeNote(root, backlog, note(), { date, dryRun: true })?.written).toBe(false);
		expect(existsSync(join(root, backlog))).toBe(false);

		const first = writeNote(root, backlog, note(), { date });
		expect(first).toEqual({
			file: `${backlog}/2026-11-02_use-fastify-instead-express.md`,
			written: true,
		});
		expect(writeNote(root, backlog, note(), { date })).toBeUndefined();

		const other = writeNote(root, backlog, note({ id: "pi:s1:a2", anchor: "a2" }), { date });
		expect(other?.file).toBe(`${backlog}/2026-11-02_use-fastify-instead-express-2.md`);

		expect(
			readBacklog(root, backlog)
				.map((b) => [b.id, b.status, b.decision])
				.sort(),
		).toEqual([
			["pi:s1:a1", "open", "Use Fastify instead of Express."],
			["pi:s1:a2", "open", "Use Fastify instead of Express."],
		]);
		expect(readdirSync(join(root, backlog))).toHaveLength(2);
		expect(readFileSync(join(root, first?.file ?? ""), "utf8")).toContain("status: open");
	});

	it("missing backlog folder reads as empty", () => {
		expect(readBacklog(tempRepo(), "nope")).toEqual([]);
	});
});
