import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenAIClassifier, endpointModelId } from "../../src/core/classifier-openai.ts";
import { findPiSessions } from "../../src/core/harness/pi.ts";
import { resolveLayout } from "../../src/core/layout.ts";
import { parseNote } from "../../src/core/notes.ts";
import { scanSession, tildify, touchedPaths } from "../../src/core/scan.ts";
import {
	decision,
	fakeClassifier,
	loadSessionFixture,
	sessionFixturePath,
	tempRepo,
} from "../helpers.ts";

const now = () => new Date("2026-11-03T12:00:00Z");

describe("scanSession", () => {
	it("classifies only triggered exchanges and writes notes", async () => {
		const root = tempRepo("docs-adr");
		const session = loadSessionFixture("todo-api");
		const { classifier, calls } = fakeClassifier({
			"6adcfdf9": decision(),
			effa498d: decision({
				summary: "Use 2-space indentation in JSON and TS.",
				proposed_target: "tooling",
			}),
			"48439c79": decision({ is_decision: false }),
		});
		const results = await scanSession(session, { layout: resolveLayout(root), classifier, now });
		expect(calls.map((c) => c.exchange.anchor)).toEqual(["6adcfdf9", "effa498d", "48439c79"]);
		expect(calls[0]?.adrs.map((a) => a.id)).toEqual([
			"docs/adr/0001-record-architecture-decisions.md",
			"docs/adr/0002-use-postgres.md",
		]);
		// Later calls see notes written earlier in the same run, for dedupe.
		expect(calls[1]?.backlog.map((b) => b.title)).toEqual(["Use Fastify instead of Express."]);
		expect(results.map((r) => r.outcome)).toEqual([
			"no-trigger",
			"written",
			"written",
			"no-trigger",
			"no-trigger",
			"not-decision",
		]);
		const dir = join(root, "docs/adr/_backlog");
		const files = readdirSync(dir).sort();
		expect(files).toEqual([
			"2026-11-03_use-2-space-indentation-json-ts.md",
			"2026-11-03_use-fastify-instead-express.md",
		]);
		const parsed = parseNote(readFileSync(join(dir, files[1] as string), "utf8"));
		expect(parsed?.meta).toMatchObject({
			id: `pi:${session.id}:6adcfdf9`,
			anchor: "6adcfdf9",
			adr_dir: "docs/adr",
			status: "open",
			captured: "2026-11-03T20:29:33Z",
		});
		expect(parsed?.sections.Quote).toMatch(/^> Let's go with Fastify/);
	});

	it("is idempotent: a second run makes no model calls and writes nothing", async () => {
		const root = tempRepo("docs-adr");
		const layout = resolveLayout(root);
		const session = loadSessionFixture("todo-api");
		await scanSession(session, {
			layout,
			classifier: fakeClassifier({}, decision()).classifier,
			now,
		});
		const before = readdirSync(join(root, "docs/adr/_backlog")).length;
		const second = fakeClassifier({}, decision());
		const results = await scanSession(session, { layout, classifier: second.classifier, now });
		expect(second.calls).toHaveLength(0);
		expect(results.filter((r) => r.outcome === "exists")).toHaveLength(3);
		expect(readdirSync(join(root, "docs/adr/_backlog"))).toHaveLength(before);
	});

	it("dry run writes nothing", async () => {
		const root = tempRepo("docs-adr");
		const results = await scanSession(loadSessionFixture("todo-api"), {
			layout: resolveLayout(root),
			classifier: fakeClassifier({}, decision()).classifier,
			dryRun: true,
			now,
		});
		expect(results.filter((r) => r.outcome === "would-write")).toHaveLength(3);
		expect(readdirSync(join(root, "docs/adr"))).not.toContain("_backlog");
	});

	it("duplicates, discards and classifier errors write nothing and don't throw", async () => {
		const root = tempRepo("docs-adr");
		const { classifier } = fakeClassifier({
			"6adcfdf9": decision({ duplicate_of: "docs/adr/0002-use-postgres.md" }),
			effa498d: new Error("HTTP 500"),
			"48439c79": decision({ proposed_target: "discard" }),
		});
		const results = await scanSession(loadSessionFixture("todo-api"), {
			layout: resolveLayout(root),
			classifier,
			now,
		});
		const hits = results.filter((r) => r.outcome !== "no-trigger");
		expect(hits.map((r) => r.outcome)).toEqual(["duplicate", "error", "not-decision"]);
		expect(hits[0]?.duplicateOf).toBe("docs/adr/0002-use-postgres.md");
		expect(hits[1]?.error).toBe("HTTP 500");
		expect(readdirSync(join(root, "docs/adr"))).not.toContain("_backlog");
	});

	it("one exchange with several decisions writes one note each, and re-runs skip the exchange", async () => {
		const root = tempRepo("docs-adr");
		const layout = resolveLayout(root);
		const session = loadSessionFixture("todo-api");
		const many = {
			"6adcfdf9": [
				decision({
					summary: "Use Fastify instead of Express.",
					quote: "Fastify instead of Express",
				}),
				decision({
					summary: "Use Postgres rather than SQLite.",
					quote: "Postgres rather than SQLite",
				}),
				decision({ summary: "Already covered.", duplicate_of: "docs/adr/0002-use-postgres.md" }),
			],
		};
		const results = await scanSession(session, {
			layout,
			classifier: fakeClassifier(many).classifier,
			now,
		});
		const hits = results.filter((r) => r.anchor === "6adcfdf9");
		expect(hits.map((r) => r.outcome)).toEqual(["written", "written", "duplicate"]);
		const dir = join(root, "docs/adr/_backlog");
		const notes = readdirSync(dir).map((f) => parseNote(readFileSync(join(dir, f), "utf8")));
		const byId = Object.fromEntries(notes.map((n) => [n?.meta.id, n]));
		expect(byId[`pi:${session.id}:6adcfdf9#2`]?.sections.Quote).toBe(
			"> Postgres rather than SQLite",
		);

		const again = fakeClassifier(many);
		await scanSession(session, { layout, classifier: again.classifier, now });
		expect(again.calls.map((c) => c.exchange.anchor)).not.toContain("6adcfdf9");
	});

	it("monorepo: a decision about services/billing lands in that package's backlog", async () => {
		const root = tempRepo("monorepo");
		const session = { ...loadSessionFixture("mono-repo"), cwd: root };
		const { classifier } = fakeClassifier({
			cf435ef5: decision({ summary: "Billing uses event sourcing rather than CRUD tables." }),
			"48221acd": decision({
				summary: "Tenant means customer account.",
				proposed_target: "glossary",
			}),
		});
		await scanSession(session, { layout: resolveLayout(root), classifier, now });
		expect(readdirSync(join(root, "services/billing/docs/adr/_backlog"))).toEqual([
			"2026-11-03_billing-uses-event-sourcing-rather-than.md",
		]);
		expect(readdirSync(join(root, "docs/adr/_backlog"))).toEqual([
			"2026-11-03_tenant-means-customer-account.md",
		]);
	});

	it("stores session_file with ~ instead of the home folder", async () => {
		const root = tempRepo("docs-adr");
		const session = {
			...loadSessionFixture("todo-api"),
			file: "/home/u/.pi/agent/sessions/x/s.jsonl",
		};
		await scanSession(session, {
			layout: resolveLayout(root),
			classifier: fakeClassifier({}, decision()).classifier,
			now,
			home: "/home/u",
		});
		const dir = join(root, "docs/adr/_backlog");
		const text = readFileSync(join(dir, readdirSync(dir)[0] as string), "utf8");
		expect(text).toContain("session_file: ~/.pi/agent/sessions/x/s.jsonl");
	});
});

describe("touchedPaths", () => {
	it("collects tool paths and paths the human named, inside the repo only", () => {
		const paths = touchedPaths(
			{
				anchor: "a",
				ts: "",
				user: "Create services/billing/src/events.ts and look at /etc/hosts",
				assistant: "",
				previousAssistant: "",
				toolCalls: [{ name: "write", args: { path: "/repo/packages/ui/a.tsx" } }],
			},
			"/repo",
			"/repo",
		);
		expect(paths.sort()).toEqual(["packages/ui/a.tsx", "services/billing/src/events.ts"]);
	});
	it("falls back to the session folder inside the repo", () => {
		const ex = {
			anchor: "a",
			ts: "",
			user: "use X",
			assistant: "",
			previousAssistant: "",
			toolCalls: [],
		};
		expect(touchedPaths(ex, "/repo/services/billing", "/repo")).toEqual(["services/billing"]);
	});
});

describe("findPiSessions", () => {
	it("matches by header cwd (project and subfolders) and --since", () => {
		const dir = tempRepo();
		const put = (sub: string, name: string, cwd: string, ts: string) => {
			mkdirSync(join(dir, sub), { recursive: true });
			writeFileSync(
				join(dir, sub, name),
				`${JSON.stringify({ type: "session", id: name, timestamp: ts, cwd })}\n`,
			);
		};
		put("a", "1", "/p/app", "2026-10-01T00:00:00Z");
		put("b", "2", "/p/app/services/x", "2026-11-01T00:00:00Z");
		put("c", "3", "/p/app-other", "2026-11-01T00:00:00Z");
		put("a", "1.jsonl", "/p/app", "2026-10-01T00:00:00Z");
		put("b", "2.jsonl", "/p/app/services/x", "2026-11-01T00:00:00Z");
		put("c", "3.jsonl", "/p/app-other", "2026-11-01T00:00:00Z");
		mkdirSync(join(dir, "d"));
		copyFileSync(sessionFixturePath("todo-api"), join(dir, "d", "4.jsonl"));
		expect(findPiSessions(dir, "/p/app").map((s) => s.id)).toEqual(["1.jsonl", "2.jsonl"]);
		expect(findPiSessions(dir, "/p/app", new Date("2026-10-15")).map((s) => s.id)).toEqual([
			"2.jsonl",
		]);
		expect(findPiSessions(join(dir, "missing"), "/p/app")).toEqual([]);
	});

	it("tildify", () => {
		expect(tildify("/home/u/.pi/x", "/home/u")).toBe("~/.pi/x");
		expect(tildify("/home/user2/x", "/home/u")).toBe("/home/user2/x");
		expect(tildify("/x", undefined)).toBe("/x");
	});
});

describe("OpenAI-compatible classifier", () => {
	it("posts a JSON-mode chat request and parses the reply", async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const fetchFake = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response(
				JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision()) } }] }),
			);
		}) as unknown as typeof fetch;
		const c = createOpenAIClassifier({
			baseUrl: "https://x.test/v1",
			apiKey: "k",
			model: "m",
			fetch: fetchFake,
		});
		const ex = {
			anchor: "a",
			ts: "",
			user: "go with X",
			assistant: "",
			previousAssistant: "",
			toolCalls: [],
		};
		const r = await c.classify({ exchange: ex, signals: [], adrs: [], backlog: [] });
		expect(r[0]?.summary).toBe("Use Fastify instead of Express.");
		if (!seen) throw new Error("fetch not called");
		expect(seen.url).toBe("https://x.test/v1/chat/completions");
		expect((seen.init.headers as Record<string, string>).authorization).toBe("Bearer k");
		const body = JSON.parse(String(seen.init.body));
		expect(body).toMatchObject({
			model: "m",
			temperature: 0,
			response_format: { type: "json_object" },
		});
	});

	it("surfaces HTTP errors", async () => {
		const fetchFake = (async () =>
			new Response("nope", { status: 401 })) as unknown as typeof fetch;
		const c = createOpenAIClassifier({
			baseUrl: "https://x.test",
			apiKey: "k",
			model: "m",
			fetch: fetchFake,
		});
		const ex = {
			anchor: "a",
			ts: "",
			user: "x",
			assistant: "",
			previousAssistant: "",
			toolCalls: [],
		};
		await expect(c.classify({ exchange: ex, signals: [], adrs: [], backlog: [] })).rejects.toThrow(
			/401/,
		);
	});

	it("endpointModelId strips the provider", () => {
		expect(endpointModelId("openai/gpt-5-mini")).toBe("gpt-5-mini");
		expect(endpointModelId("plain")).toBe("plain");
	});
});
