import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scoreExchange, toolCommand } from "../../src/core/detect.ts";
import {
	codexReviewer,
	codexSessionsDir,
	findCodexRollout,
	findCodexSessions,
	parseCodexSession,
	patchFiles,
} from "../../src/core/harness/codex.ts";
import { getHarness } from "../../src/core/harness/index.ts";
import { toExchanges } from "../../src/core/transcript.ts";
import { FIXTURES, tempRepo } from "../helpers.ts";

const fixture = join(FIXTURES, "sessions", "codex-cli-notes.jsonl");

type P = Record<string, unknown>;
const line = (type: string, payload: P, ts = "2026-01-01T00:00:00Z") =>
	JSON.stringify({ timestamp: ts, type, payload });
const meta = (cwd = "/work/x", id = "s1", ts = "2026-01-01T00:00:00Z") =>
	line("session_meta", { id, cwd, timestamp: ts });
const human = (id: string, text: string) =>
	line("event_msg", {
		type: "item_completed",
		item: { type: "UserMessage", id, content: [{ type: "text", text }] },
	});
const reply = (id: string, text: string) =>
	line("response_item", {
		type: "message",
		id,
		role: "assistant",
		content: [{ type: "output_text", text }],
	});
const parse = (...lines: string[]) => parseCodexSession(lines.join("\n"), "/s/rollout-x.jsonl");

describe("Codex sessions", () => {
	it("parse the fixture into human turns, replies and tool calls", () => {
		const s = getHarness("codex")?.sessions?.loadSession(fixture);
		expect(s).toMatchObject({ harness: "codex", cwd: "/work/cli-notes" });
		expect(s?.id).toBe("01a1a6f3-d114-70d2-8925-c4df255c06e1");
		const humans = s?.turns.filter((t) => t.role === "user").map((t) => t.text) ?? [];
		expect(humans).toHaveLength(3);
		expect(humans[0]).toMatch(/^Create index\.js .*parseArgs instead of a library like yargs/);
		expect(humans.join("\n")).not.toMatch(/AGENTS\.md/);
		const calls = s?.turns.flatMap((t) => t.toolCalls) ?? [];
		expect(calls[0]?.name).toBe("exec_command");
		expect(toolCommand(calls[0] ?? { name: "", args: {} })).toMatch(/^pwd && git rev-parse/);

		const ex = toExchanges(s?.turns ?? []);
		expect(ex).toHaveLength(3);
		expect(ex[1]?.previousAssistant).toMatch(/Is working directly in .* OK\?$/);
		expect(scoreExchange(ex[0] as never).signals).toContain("phrase:instead-of");
	});

	it("take the human's words from events, not the injected user messages", () => {
		const s = parse(
			meta(),
			line("response_item", {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "# AGENTS.md instructions\n..." }],
			}),
			line("response_item", {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Use Hono." }],
			}),
			human("u1", "Use Hono."),
			reply("a1", "Done."),
		);
		expect(s.turns.map((t) => [t.role, t.text, t.anchor])).toEqual([
			["user", "Use Hono.", "u1"],
			["assistant", "Done.", "a1"],
		]);
	});

	it("read the older user_message events", () => {
		const s = parse(
			meta(),
			line("event_msg", { type: "user_message", message: "Use Hono." }),
			reply("a1", "Done."),
		);
		expect(s.turns[0]).toMatchObject({ role: "user", text: "Use Hono.", anchor: "line-1" });
	});

	it("turn apply_patch into one write per file", () => {
		const patch =
			"*** Begin Patch\n*** Add File: package.json\n+{}\n*** Update File: src/a.ts\n@@\n*** End Patch";
		expect(patchFiles(patch)).toEqual(["package.json", "src/a.ts"]);
		const s = parse(
			meta(),
			human("u1", "Add a package.json."),
			line("response_item", {
				type: "custom_tool_call",
				id: "c1",
				name: "apply_patch",
				input: patch,
			}),
			line("response_item", {
				type: "function_call",
				id: "c2",
				name: "apply_patch",
				arguments: JSON.stringify({
					input: "*** Begin Patch\n*** Add File: biome.json\n*** End Patch",
				}),
			}),
			line("response_item", {
				type: "local_shell_call",
				id: "c3",
				action: { command: ["npm", "install", "zod"] },
			}),
		);
		const calls = s.turns.flatMap((t) => t.toolCalls);
		expect(calls.map((c) => c.args.path ?? c.args.command)).toEqual([
			"package.json",
			"src/a.ts",
			"biome.json",
			["npm", "install", "zod"],
		]);
		const signals = scoreExchange(toExchanges(s.turns)[0] as never).signals;
		expect(signals).toEqual(expect.arrayContaining(["tool:config-file", "tool:package-install"]));
	});

	it("drop rolled-back turns", () => {
		const s = parse(
			meta(),
			human("u1", "Use Hono."),
			reply("a1", "Done."),
			human("u2", "Use Express instead."),
			reply("a2", "Switched."),
			line("event_msg", { type: "thread_rolled_back", num_turns: 1 }),
			human("u3", "Keep Hono, add Zod."),
		);
		expect(s.turns.map((t) => t.anchor)).toEqual(["u1", "a1", "u3"]);
	});

	it("are found by cwd under the date folders, and since skips old days", () => {
		const root = tempRepo();
		const put = (day: string, name: string, cwd: string, ts: string) => {
			const dir = join(root, ...day.split("-"));
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, name), `${meta(cwd, name, ts)}\n`);
		};
		put("2026-10-30", "rollout-a.jsonl", "/work/app", "2026-10-30T10:00:00Z");
		put("2026-11-02", "rollout-b.jsonl", "/work/app/services/x", "2026-11-02T10:00:00Z");
		put("2026-11-02", "rollout-c.jsonl", "/work/application", "2026-11-02T11:00:00Z");
		put("2026-11-02", "notes.jsonl", "/work/app", "2026-11-02T12:00:00Z");
		expect(findCodexSessions(root, "/work/app").map((s) => s.id)).toEqual([
			"rollout-a.jsonl",
			"rollout-b.jsonl",
		]);
		expect(findCodexSessions(root, "/work/app", new Date("2026-11-01")).map((s) => s.id)).toEqual([
			"rollout-b.jsonl",
		]);
		expect(findCodexSessions(join(root, "missing"), "/work/app")).toEqual([]);
		put("2026-11-03", "rollout-2026-11-03T09-00-00-abc.jsonl", "/work/app", "2026-11-03T09:00:00Z");
		expect(findCodexRollout(root, "abc")).toMatch(/2026\/11\/03\/rollout-.*-abc\.jsonl$/);
		expect(findCodexRollout(root, "nope")).toBeUndefined();
	});

	it("live under CODEX_HOME when set", () => {
		expect(codexSessionsDir({}, "/home/u")).toBe("/home/u/.codex/sessions");
		expect(codexSessionsDir({ CODEX_HOME: "/c" }, "/home/u")).toBe("/c/sessions");
	});
});

describe("Codex reviewer", () => {
	const run = { cwd: "/r", model: "openai/gpt-5", promptFile: "/s/p.md" };

	it("is registered with both sides", () => {
		expect(getHarness("codex")?.reviewer).toBe(codexReviewer);
	});

	it("sets the recursion guard, passes the bare model and keeps headless runs in the sandbox", () => {
		expect(codexReviewer.reviewerCommand(run)).toBe(
			`cd '/r' && ADR_REVIEW_CHILD=1 codex --model 'gpt-5' -- "$(cat '/s/p.md')"`,
		);
		expect(codexReviewer.headlessReviewerCommand({ ...run, bin: "wrap codex" })).toBe(
			`cd '/r' && ADR_REVIEW_CHILD=1 wrap codex exec --model 'gpt-5' --sandbox workspace-write --skip-git-repo-check -- "$(cat '/s/p.md')"`,
		);
	});
});
