import { describe, expect, it } from "vitest";
import {
	buildClassifierPrompt,
	clip,
	normalizeTarget,
	parseClassification,
	parseClassifications,
	scoreExchange,
	stripQuoted,
} from "../../src/core/detect.ts";
import { toExchanges } from "../../src/core/transcript.ts";
import type { Exchange, ToolCall } from "../../src/core/types.ts";
import { loadSessionFixture } from "../helpers.ts";

const ex = (user: string, over: Partial<Exchange> = {}): Exchange => ({
	anchor: "a",
	ts: "",
	user,
	assistant: "",
	previousAssistant: "",
	toolCalls: [],
	...over,
});
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ name, args });
const fired = (e: Exchange) => scoreExchange(e).fired;

describe("scoreExchange: user phrases", () => {
	it.each([
		"Let's go with Fastify.",
		"We'll use Postgres for this.",
		"We decided to keep the monolith.",
		"Use pnpm instead of npm.",
		"Store dates as UTC rather than local time.",
		"From now on, run lint before every commit.",
		"Never use var in C#.",
		"Drop Moment in favour of date-fns.",
	])("fires: %s", (text) => expect(fired(ex(text))).toBe(true));

	it.each([
		"List the files in this repo.",
		"Add src/server.ts with a GET /health route that returns ok.",
		"Fix the typo if there is one in README.md, otherwise say nothing to fix.",
		"Should we use Zod or TypeBox?",
		"Rename x to count.",
	])("stays quiet: %s", (text) => expect(fired(ex(text))).toBe(false));

	it("ignores phrases inside code blocks and quotes", () => {
		expect(fired(ex("Look at this:\n```\nlet's go with X instead of Y\n```"))).toBe(false);
		expect(fired(ex("> we decided to use X instead of Y\nwhat does this mean"))).toBe(false);
	});

	it("never fires on assistant wording alone", () => {
		const r = scoreExchange(
			ex("thanks", { assistant: "I recommend X instead of Y. Alternatively Z." }),
		);
		expect(r.fired).toBe(false);
	});
});

describe("scoreExchange: confirmation", () => {
	const options = "Two options:\n1. Fastify\n2. Express\nI recommend Fastify.";
	it.each(["yes", "ok", "go", "approved", "2", "sounds good"])(
		'"%s" after options fires',
		(reply) => {
			const r = scoreExchange(ex(reply, { previousAssistant: options }));
			expect(r.fired).toBe(true);
			expect(r.signals).toContain("confirm:options");
		},
	);
	it('"yes" without options before it does not fire', () => {
		expect(fired(ex("yes", { previousAssistant: "Done, the file is written." }))).toBe(false);
	});
});

describe("scoreExchange: tool calls", () => {
	it.each(["npm install zod", "pnpm add -D vitest", "uv add httpx", "go get github.com/x/y"])(
		"package install: %s",
		(command) => {
			const r = scoreExchange(ex("do it", { toolCalls: [call("bash", { command })] }));
			expect(r.signals).toContain("tool:package-install");
			expect(r.fired).toBe(true);
		},
	);
	it("scaffolding fires", () => {
		const r = scoreExchange(
			ex("start", { toolCalls: [call("bash", { command: "npx create-next-app web" })] }),
		);
		expect(r.signals).toContain("tool:scaffold");
	});
	it("writing a config file fires, writing source or reading config does not", () => {
		const w = (name: string, args: Record<string, unknown>) =>
			scoreExchange(ex("go on", { toolCalls: [call(name, args)] }));
		expect(w("write", { path: "a/.editorconfig" }).signals).toContain("tool:config-file");
		expect(w("Edit", { file_path: "/x/tsconfig.json" }).signals).toContain("tool:config-file");
		expect(w("write", { path: "src/server.ts" }).fired).toBe(false);
		expect(w("read", { path: "package.json" }).fired).toBe(false);
	});
});

describe("scoreExchange on real sessions", () => {
	const hits = (name: string) =>
		toExchanges(loadSessionFixture(name).turns)
			.filter(fired)
			.map((e) => e.anchor);
	it("todo-api: framework, indentation, validation choice", () => {
		expect(hits("todo-api")).toEqual(["6adcfdf9", "effa498d", "48439c79"]);
	});
	it("plain-chores: nothing", () => expect(hits("plain-chores")).toEqual([]));
	it("mono-repo: event sourcing, runbook, glossary, test runner; not the git permission chat", () => {
		expect(hits("mono-repo")).toEqual(["cf435ef5", "16e7163e", "48221acd", "bf416023"]);
	});
});

describe("stripQuoted / clip", () => {
	it("stripQuoted removes fences and quote lines", () => {
		expect(stripQuoted("a\n```\nb\n```\n> c\nd").replace(/\s+/g, " ").trim()).toBe("a d");
	});
	it("clip keeps head and tail", () => {
		const c = clip(`HEAD${"x".repeat(100)}TAIL`, 40);
		expect(c.length).toBeLessThanOrEqual(45);
		expect(c.startsWith("HEAD")).toBe(true);
		expect(c.endsWith("TAIL")).toBe(true);
	});
});

describe("buildClassifierPrompt", () => {
	it("includes ADR titles, backlog notes, signals and the exchange", () => {
		const p = buildClassifierPrompt({
			exchange: ex("Let's go with Fastify", {
				assistant: "Done.",
				previousAssistant: "Options: Fastify or Express",
				toolCalls: [call("write", { path: "package.json" })],
			}),
			signals: ["phrase:go-with"],
			adrs: [{ id: "docs/adr/0001-x.md", title: "1. Use ADRs" }],
			backlog: [{ id: "pi:s:a0", title: "Use Postgres" }],
		});
		for (const s of [
			"docs/adr/0001-x.md",
			"1. Use ADRs",
			"pi:s:a0",
			"Use Postgres",
			"phrase:go-with",
			"Let's go with Fastify",
			"package.json",
		]) {
			expect(p.user).toContain(s);
		}
		expect(p.system).toMatch(/JSON/);
	});
	it("clips very long messages", () => {
		const p = buildClassifierPrompt({
			exchange: ex("y".repeat(20_000)),
			signals: [],
			adrs: [],
			backlog: [],
		});
		expect(p.user.length).toBeLessThan(8000);
	});
});

describe("parseClassification", () => {
	const good = {
		is_decision: true,
		summary: " Use Fastify. ",
		proposed_target: "adr",
		confidence: "high",
		alternatives: ["Express"],
		duplicate_of: null,
		decided_by: "human",
		why: "framework",
	};
	const parse = (o: unknown) => parseClassification(JSON.stringify(o));
	it("parses plain JSON", () => {
		expect(parse(good)).toMatchObject({
			is_decision: true,
			summary: "Use Fastify.",
			proposed_target: "adr",
		});
	});
	it("tolerates fences and prose", () => {
		expect(
			parseClassification(`Sure:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``).is_decision,
		).toBe(true);
	});
	it("caps agent-only decisions at low confidence", () => {
		expect(parse({ ...good, decided_by: "agent" }).confidence).toBe("low");
	});
	it("normalizes odd values", () => {
		expect(parse({ ...good, proposed_target: "Decision Log" }).proposed_target).toBe(
			"decision_log",
		);
		expect(parse({ ...good, confidence: "very" }).confidence).toBe("low");
		expect(parse({ ...good, duplicate_of: "null" }).duplicate_of).toBeNull();
	});
	it("parseClassifications: lists, single objects, empty, discards, invented quotes", () => {
		const human = "Use Fastify. And \u2019tenant\u2019 means   customer account.";
		const list = parseClassifications(
			JSON.stringify({
				decisions: [
					{ ...good, quote: "Use Fastify." },
					{
						...good,
						summary: "Tenant means customer account.",
						proposed_target: "glossary",
						quote: "'tenant' means customer account",
					},
					{ ...good, summary: "Made up.", quote: "words nobody said" },
					{ ...good, proposed_target: "discard" },
					{ ...good, summary: "" },
				],
			}),
			human,
		);
		expect(list.map((c) => [c.summary, c.quote])).toEqual([
			["Use Fastify.", "Use Fastify."],
			["Tenant means customer account.", "'tenant' means customer account"],
			["Made up.", undefined],
		]);
		expect(parseClassifications(JSON.stringify({ decisions: [] }))).toEqual([]);
		expect(parseClassifications(JSON.stringify(good))).toHaveLength(1);
		expect(parseClassifications(JSON.stringify({ ...good, is_decision: false }))).toEqual([]);
		const six = Array.from({ length: 6 }, (_, i) => ({ ...good, summary: `D${i}` }));
		expect(parseClassifications(JSON.stringify({ decisions: six }))).toHaveLength(5);
	});
	it("quotes with ellipses match by parts", () => {
		const [c] = parseClassifications(
			JSON.stringify({ decisions: [{ ...good, quote: "Use Fastify … customer account" }] }),
			"Use Fastify. Tenant means customer account.",
		);
		expect(c?.quote).toBe("Use Fastify … customer account");
	});
	it("throws without JSON", () => expect(() => parseClassification("no idea")).toThrow());
	it("normalizeTarget falls back to discard", () => {
		expect(normalizeTarget("ADR")).toBe("adr");
		expect(normalizeTarget("wiki")).toBe("discard");
	});
});
