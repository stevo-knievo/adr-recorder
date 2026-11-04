import { describe, expect, it } from "vitest";
import {
	detectNumbering,
	detectTemplateKind,
	findGitRoot,
	hasAdrFolder,
	listAdrs,
	pickFolder,
	readStatus,
	readTitle,
	resolveLayout,
} from "../../src/core/layout.ts";
import { repoFixture } from "../helpers.ts";

describe("resolveLayout", () => {
	it("docs/adr with .template.md (Nygard)", () => {
		const l = resolveLayout(repoFixture("docs-adr"));
		expect(l).toMatchObject({
			source: "known",
			adrDir: "docs/adr",
			backlogDir: "docs/adr/_backlog",
			template: "docs/adr/.template.md",
			templateKind: "nygard",
			numbering: "sequential",
			statuses: ["Proposed", "Accepted", "Superseded"],
		});
		expect(hasAdrFolder(l)).toBe(true);
	});

	it("other targets prefer existing files, else defaults", () => {
		const t = resolveLayout(repoFixture("docs-adr")).targets;
		expect(t.glossary).toBe("GLOSSARY.md");
		expect(t.agents).toBe("CLAUDE.md");
		expect(t.decision_log).toBe("docs/decision-log.md");
		expect(t.readme).toBe("README.md");
	});

	it("Docs/ADRs: case-insensitive match, date numbering, MADR, front matter statuses", () => {
		expect(resolveLayout(repoFixture("docs-adrs-case"))).toMatchObject({
			adrDir: "Docs/ADRs",
			numbering: "date",
			template: "Docs/ADRs/template.md",
			templateKind: "madr",
			statuses: ["proposed", "accepted", "rejected"],
		});
	});

	it("adr-tools .adr-dir", () => {
		expect(resolveLayout(repoFixture("adr-tools"))).toMatchObject({
			source: "adr-tools",
			adrDir: "architecture/records",
		});
	});

	it("log4brains adrFolder", () => {
		expect(resolveLayout(repoFixture("log4brains"))).toMatchObject({
			source: "log4brains",
			adrDir: "docs/decisions-l4b",
		});
	});

	it("repo config wins and overrides targets", () => {
		const l = resolveLayout(repoFixture("repo-config"), {
			adr_dir: "doc/architecture/decisions",
			backlog_dir: "doc/architecture/decisions/inbox",
			numbering: "date",
			template: "doc/architecture/decisions/tpl.md",
			targets: { glossary: "docs/terms.md" },
		});
		expect(l).toMatchObject({
			source: "config",
			backlogDir: "doc/architecture/decisions/inbox",
			numbering: "date",
			templateKind: "nygard",
		});
		expect(l.targets.glossary).toBe("docs/terms.md");
	});

	it("an empty known folder does not count", () => {
		const l = resolveLayout(repoFixture("empty-folder"));
		expect(l.source).toBe("none");
		expect(hasAdrFolder(l)).toBe(false);
	});

	it("nothing found: suggests docs/adr", () => {
		const l = resolveLayout(repoFixture("none"));
		expect(l).toMatchObject({ source: "none", adrDir: "docs/adr" });
		expect(l.folders).toHaveLength(1);
		expect(l.statuses).toEqual(["Proposed", "Accepted", "Deprecated", "Superseded"]);
		expect(hasAdrFolder(l)).toBe(false);
	});

	it("monorepo: finds package ADR folders, skips node_modules", () => {
		const l = resolveLayout(repoFixture("monorepo"));
		expect(l.folders.map((f) => [f.dir, f.scope, f.backlog])).toEqual([
			["docs/adr", "", "docs/adr/_backlog"],
			["packages/ui/doc/adrs", "packages/ui", "packages/ui/doc/adrs/_backlog"],
			["services/billing/docs/adr", "services/billing", "services/billing/docs/adr/_backlog"],
		]);
		expect(listAdrs(l).map((a) => a.title)).toEqual([
			"1. Use pnpm workspaces",
			"1. Use React",
			"1. Billing owns invoices",
		]);
	});
});

describe("pickFolder", () => {
	const l = resolveLayout(repoFixture("monorepo"));
	it("picks the package folder that most touched files belong to", () => {
		expect(pickFolder(l, ["services/billing/src/events.ts"]).dir).toBe("services/billing/docs/adr");
		expect(
			pickFolder(l, ["packages/ui/a.tsx", "packages/ui/b.tsx", "services/billing/x"]).dir,
		).toBe("packages/ui/doc/adrs");
	});
	it("falls back to the root folder", () => {
		expect(pickFolder(l, []).dir).toBe("docs/adr");
		expect(pickFolder(l, ["README.md", "services/web/src/index.ts"]).dir).toBe("docs/adr");
	});
});

describe("helpers", () => {
	it("detectNumbering", () => {
		expect(detectNumbering(["0001-a.md", "0002-b.md"])).toBe("sequential");
		expect(detectNumbering(["2026-01-01-a.md"])).toBe("date");
		expect(detectNumbering([])).toBe("sequential");
	});
	it("detectTemplateKind", () => {
		expect(detectTemplateKind("# T\n## Considered Options\n")).toBe("madr");
		expect(detectTemplateKind("## Status\n## Context\n## Decision\n## Consequences\n")).toBe(
			"nygard",
		);
		expect(detectTemplateKind("# Whatever")).toBe("custom");
	});
	it("readStatus", () => {
		expect(readStatus("---\nstatus: accepted\n---\n# T")).toBe("accepted");
		expect(readStatus("# T\n\nStatus: Superseded\n")).toBe("Superseded");
		expect(readStatus("# T\n\n## Status\n\nAccepted\n")).toBe("Accepted");
		expect(readStatus("# T")).toBeUndefined();
	});
	it("readTitle", () => {
		expect(readTitle("---\ntitle: From FM\n---\n# H", "f.md")).toBe("From FM");
		expect(readTitle("# Heading", "f.md")).toBe("Heading");
		expect(readTitle("no heading", "0001-x.md")).toBe("0001-x");
	});
	it("findGitRoot", () => {
		expect(findGitRoot(new URL(".", import.meta.url).pathname)).toMatch(/adr-recorder$/);
	});
});
