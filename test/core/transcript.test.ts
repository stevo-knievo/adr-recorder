import { describe, expect, it } from "vitest";
import { parsePiSession, readPiHeader, toExchanges } from "../../src/core/transcript.ts";
import { loadSessionFixture } from "../helpers.ts";

const line = (o: unknown) => JSON.stringify(o);
const header = {
	type: "session",
	version: 3,
	id: "s1",
	timestamp: "2026-11-01T10:00:00Z",
	cwd: "/work/x",
};
const msg = (id: string, parentId: string | null, role: string, content: unknown) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-11-01T10:00:00Z",
	message: { role, content },
});

describe("parsePiSession", () => {
	it("reads the real todo-api fixture", () => {
		const s = loadSessionFixture("todo-api");
		expect(s.harness).toBe("pi");
		expect(s.cwd).toBe("/work/todo-api");
		const ex = toExchanges(s.turns);
		expect(ex).toHaveLength(6);
		expect(ex[1]?.anchor).toBe("6adcfdf9");
		expect(ex[1]?.user).toMatch(/Fastify instead of Express/);
		expect(ex[1]?.toolCalls.map((c) => c.name)).toContain("write");
		expect(ex[5]?.user).toMatch(/^ok, go with your recommendation/);
		expect(ex[5]?.previousAssistant).toMatch(/TypeBox/);
	});

	it("follows the active branch only", () => {
		const text = [
			line(header),
			line(msg("u1", null, "user", "first")),
			line(msg("a1", "u1", "assistant", [{ type: "text", text: "reply" }])),
			line(msg("u2", "a1", "user", "abandoned branch")),
			line(msg("u3", "a1", "user", "active branch")),
		].join("\n");
		expect(parsePiSession(text, "f").turns.map((t) => t.text)).toEqual([
			"first",
			"reply",
			"active branch",
		]);
	});

	it("skips system, tool results, thinking and custom entries", () => {
		const text = [
			line(header),
			line(msg("sys", null, "system", "")),
			line(msg("u1", "sys", "user", [{ type: "text", text: "hi" }])),
			line(
				msg("a1", "u1", "assistant", [
					{ type: "thinking", thinking: "secret plan" },
					{ type: "toolCall", id: "t", name: "bash", arguments: { command: "npm i zod" } },
				]),
			),
			line(msg("r1", "a1", "toolResult", [{ type: "text", text: "ok" }])),
			line({ type: "custom", id: "c1", parentId: "r1", customType: "x", data: {} }),
		].join("\n");
		const turns = parsePiSession(text, "f").turns;
		expect(turns).toHaveLength(2);
		expect(turns[1]?.text).toBe("");
		expect(turns[1]?.toolCalls).toEqual([{ name: "bash", args: { command: "npm i zod" } }]);
	});

	it("tolerates a half-written last line", () => {
		const text = `${line(header)}\n${line(msg("u1", null, "user", "hi"))}\n{"type":"mess`;
		expect(parsePiSession(text, "f").turns).toHaveLength(1);
	});

	it("rejects files without a session header", () => {
		expect(() => parsePiSession(line(msg("u1", null, "user", "hi")), "f")).toThrow(
			/not a pi session/,
		);
	});

	it("readPiHeader reads only the header", () => {
		expect(readPiHeader(line(header))).toEqual({
			id: "s1",
			cwd: "/work/x",
			timestamp: header.timestamp,
		});
		expect(readPiHeader("garbage")).toBeUndefined();
	});
});

describe("toExchanges", () => {
	it("groups agent turns under the user message and keeps the previous final text", () => {
		const ex = toExchanges(loadSessionFixture("mono-repo").turns);
		expect(ex).toHaveLength(7);
		expect(ex.every((e) => e.user.length > 0)).toBe(true);
		expect(ex[0]?.previousAssistant).toBe("");
		expect(ex[1]?.previousAssistant).not.toBe("");
	});
});
