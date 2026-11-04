import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scoreExchange } from "../../src/core/detect.ts";
import {
	claudeReviewer,
	claudeSessionsDir,
	encodeClaudeProjectDir,
	findClaudeSessions,
	parseClaudeSession,
} from "../../src/core/harness/claude-code.ts";
import { getHarness } from "../../src/core/harness/index.ts";
import { toExchanges } from "../../src/core/transcript.ts";
import { FIXTURES, tempRepo } from "../helpers.ts";

const fixture = join(FIXTURES, "sessions", "claude-code-cc-notes.jsonl");

type E = Record<string, unknown>;
const user = (uuid: string, parentUuid: string | null, content: unknown, extra: E = {}) => ({
	type: "user",
	uuid,
	parentUuid,
	sessionId: "s1",
	cwd: "/work/x",
	timestamp: `2026-01-01T00:00:0${uuid.length}Z`,
	message: { role: "user", content },
	...extra,
});
const asst = (uuid: string, parentUuid: string | null, content: unknown, extra: E = {}) => ({
	type: "assistant",
	uuid,
	parentUuid,
	sessionId: "s1",
	cwd: "/work/x",
	timestamp: "2026-01-01T00:00:01Z",
	message: { role: "assistant", content },
	...extra,
});
const jsonl = (entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n");
const parse = (entries: unknown[]) => parseClaudeSession(jsonl(entries), "/t/s1.jsonl");
const texts = (entries: unknown[]) => parse(entries).turns.map((t) => `${t.role}:${t.text}`);

describe("Claude Code sessions", () => {
	it("parse the fixture into human turns, replies and tool calls", () => {
		const s = parseClaudeSession(readFileSync(fixture, "utf8"), fixture);
		expect(s).toMatchObject({ harness: "claude-code", cwd: "/work/cc-notes" });
		expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
		const users = s.turns.filter((t) => t.role === "user").map((t) => t.text);
		expect(users).toHaveLength(3);
		expect(users[0]).toContain("SQLite");
		expect(users[2]).toContain("ESM");
		const tools = s.turns.flatMap((t) => t.toolCalls.map((c) => c.name));
		expect(tools).toEqual(expect.arrayContaining(["Write", "Edit", "Bash", "Read"]));
		const ex = toExchanges(s.turns);
		expect(ex).toHaveLength(3);
		// The same detector as for pi: Claude's tool names and args fit it.
		const fired = ex.map((e) => scoreExchange(e));
		expect(fired[0]?.fired).toBe(true);
		expect(fired[2]?.signals).toContain("tool:config-file");
	});

	it("skip tool results, meta, sidechains, thinking and client echoes", () => {
		const out = texts([
			user("u1", null, "pick postgres"),
			asst("a1", "u1", [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "ok" },
			]),
			user("u2", "a1", [{ type: "tool_result", tool_use_id: "t", content: "done" }]),
			user("u3", "u2", "Caveat: generated", { isMeta: true }),
			user("u4", "u3", "<local-command-stdout>x</local-command-stdout>"),
			user("u5", "u4", "from a hook", { origin: { kind: "hook" } }),
			user("u6", "u5", "sub task", { isSidechain: true }),
			user("u7", "u5", [{ type: "text", text: "and use pg-boss" }], { origin: { kind: "human" } }),
		]);
		expect(out).toEqual(["user:pick postgres", "assistant:ok", "user:and use pg-boss"]);
	});

	it("turn slash command echoes into the command and its arguments", () => {
		const out = texts([
			user(
				"u1",
				null,
				"<command-message>adr</command-message>\n<command-name>/adr</command-name>\n<command-args>note use SQLite</command-args>",
			),
		]);
		expect(out).toEqual(["user:/adr note use SQLite"]);
	});

	it("follow the newest branch after a rewind", () => {
		const out = texts([
			user("u1", null, "start"),
			asst("a1", "u1", "first try"),
			user("u2", "a1", "use mongo"),
			asst("a2", "u2", "mongo it is"),
			user("u3", "a1", "use postgres"),
			asst("a3", "u3", "postgres it is"),
		]);
		expect(out).toEqual([
			"user:start",
			"assistant:first try",
			"user:use postgres",
			"assistant:postgres it is",
		]);
	});

	it("walk across bookkeeping entries and compaction", () => {
		const out = texts([
			user("u1", null, "before"),
			{ type: "attachment", uuid: "x1", parentUuid: "u1" },
			asst("a1", "x1", "reply"),
			{
				type: "system",
				subtype: "compact_boundary",
				uuid: "c1",
				parentUuid: null,
				logicalParentUuid: "a1",
			},
			user("u2", "c1", "after"),
			"not json {",
		]);
		expect(out).toEqual(["user:before", "assistant:reply", "user:after"]);
	});

	it("are found by cwd, including subfolders, and not in subagents/", () => {
		const root = tempRepo();
		const project = "/work/my.app";
		const dir = join(root, encodeClaudeProjectDir(project));
		const sub = join(root, encodeClaudeProjectDir(`${project}/pkg`));
		const other = join(root, encodeClaudeProjectDir("/work/my-app"));
		for (const d of [dir, sub, other, join(dir, "s1", "subagents")])
			mkdirSync(d, { recursive: true });
		writeFileSync(
			join(dir, "s1.jsonl"),
			jsonl([{ type: "mode" }, user("u1", null, "hi", { cwd: project })]),
		);
		writeFileSync(
			join(sub, "s2.jsonl"),
			jsonl([user("u1", null, "hi", { cwd: `${project}/pkg`, sessionId: "s2" })]),
		);
		// Encodes the same as /work/my.app, but is a different folder.
		writeFileSync(
			join(other, "s3.jsonl"),
			jsonl([user("u1", null, "hi", { cwd: "/work/my-app", sessionId: "s3" })]),
		);
		writeFileSync(
			join(dir, "s1", "subagents", "agent-1.jsonl"),
			jsonl([user("u1", null, "x", { cwd: project })]),
		);
		const found = findClaudeSessions(root, project);
		expect(found.map((f) => f.id).sort()).toEqual(["s1", "s2"]);
		expect(found[0]?.harness).toBe("claude-code");
		expect(findClaudeSessions(root, project, new Date("2030-01-01"))).toEqual([]);
	});

	it("live under CLAUDE_CONFIG_DIR when set", () => {
		expect(claudeSessionsDir({}, "/h")).toBe("/h/.claude/projects");
		expect(claudeSessionsDir({ CLAUDE_CONFIG_DIR: "/c" }, "/h")).toBe("/c/projects");
	});
});

describe("Claude Code reviewer", () => {
	const run = { cwd: "/repo", model: "opus", promptFile: "/s/p.md" };

	it("is registered with both sides", () => {
		expect(getHarness("claude-code")?.sessions?.name).toBe("claude-code");
		expect(getHarness("claude-code")?.reviewer?.name).toBe("claude-code");
	});

	it("sets the recursion guard and keeps headless runs to read and write", () => {
		expect(claudeReviewer.reviewerCommand(run)).toBe(
			`cd '/repo' && ADR_REVIEW_CHILD=1 claude --model 'opus' "$(cat '/s/p.md')"`,
		);
		const headless = claudeReviewer.headlessReviewerCommand({ ...run, bin: "wrap claude" });
		expect(headless).toContain("ADR_REVIEW_CHILD=1 wrap claude -p --model 'opus'");
		expect(headless).toContain("--allowedTools Read Glob Grep Write --");
		expect(headless).not.toContain("Bash");
	});
});
