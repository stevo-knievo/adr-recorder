// Trim a real Codex rollout into a small, shareable test fixture.
//
//   node scripts/make-codex-fixture.ts <rollout.jsonl> <name> [--rename Old=New ...] \
//     > test/fixtures/sessions/codex-<name>.jsonl
//
// Keeps session_meta (id, cwd, start), the human's input events, assistant
// messages, tool calls with a stub for each output, and rollbacks. Injected
// user context (AGENTS.md, environment) stays as one short stub, so tests
// can check it is ignored. Drops developer messages, reasoning, token and
// settings records. Rewrites the cwd to /work/<name>, replaces the home
// folder with /home/user, applies --rename pairs and redacts secrets.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { redact } from "../src/core/notes.ts";

const [file, name, ...rest] = process.argv.slice(2);
if (!file || !name) {
	process.stderr.write(
		"usage: make-codex-fixture.ts <rollout.jsonl> <name> [--rename Old=New ...]\n",
	);
	process.exit(2);
}
const renames: [string, string][] = [];
for (let i = 0; i < rest.length; i++) {
	if (rest[i] === "--rename" && rest[i + 1]) {
		const [a, b = ""] = String(rest[++i]).split("=");
		if (a) renames.push([a, b]);
	}
}

type Json = Record<string, unknown>;
const lines: Json[] = readFileSync(file, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l));

const meta = (lines.find((l) => l.type === "session_meta")?.payload ?? {}) as Json;
const realCwd = String(meta.cwd ?? "");
const home = homedir();
const clean = (s: string) => {
	let out = s.split(realCwd).join(`/work/${name}`).split(home).join("/home/user");
	for (const [a, b] of renames) out = out.split(a).join(b);
	return redact(out);
};
const clip = (v: unknown): unknown => {
	if (typeof v === "string") return clean(v.length > 400 ? `${v.slice(0, 400)}…` : v);
	if (Array.isArray(v)) return v.map(clip);
	if (v && typeof v === "object")
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]));
	return v;
};
const textOnly = (content: unknown, type: string) =>
	(Array.isArray(content) ? content : [])
		.filter((c: Json) => c.type === type)
		.map((c: Json) => ({ type, text: clean(String(c.text ?? "")) }));

const out: Json[] = [];
const push = (l: Json, payload: Json) =>
	out.push({ timestamp: l.timestamp, type: l.type, payload });
let injected = false;

for (const l of lines) {
	const p = (l.payload ?? {}) as Json;
	if (l.type === "session_meta") {
		push(l, {
			id: p.id,
			timestamp: p.timestamp,
			cwd: `/work/${name}`,
			originator: p.originator,
			cli_version: p.cli_version,
		});
	} else if (l.type === "event_msg") {
		if (p.type === "item_completed" && (p.item as Json)?.type === "UserMessage") {
			const item = p.item as Json;
			push(l, {
				type: p.type,
				item: { type: "UserMessage", id: item.id, content: textOnly(item.content, "text") },
			});
		} else if (p.type === "user_message") {
			push(l, { type: p.type, message: clean(String(p.message ?? "")) });
		} else if (p.type === "thread_rolled_back") {
			push(l, { type: p.type, num_turns: p.num_turns });
		}
	} else if (l.type === "response_item") {
		if (p.type === "message" && p.role === "assistant") {
			push(l, {
				type: "message",
				id: p.id,
				role: "assistant",
				content: textOnly(p.content, "output_text"),
			});
		} else if (p.type === "message" && p.role === "user") {
			const content = textOnly(p.content, "input_text");
			const first = content[0]?.text ?? "";
			const isInjected = /^(# AGENTS\.md|<environment_context>|<user_instructions>)/.test(first);
			if (isInjected && injected) continue;
			injected ||= isInjected;
			const text = isInjected ? `${first.split("\n")[0]}\n(trimmed)` : first;
			push(l, { type: "message", id: p.id, role: "user", content: [{ type: "input_text", text }] });
		} else if (p.type === "function_call") {
			let args: unknown = {};
			try {
				args = JSON.parse(String(p.arguments ?? "{}"));
			} catch {}
			push(l, {
				type: p.type,
				id: p.id,
				call_id: p.call_id,
				name: p.name,
				arguments: JSON.stringify(clip(args)),
			});
		} else if (p.type === "custom_tool_call") {
			push(l, { type: p.type, id: p.id, call_id: p.call_id, name: p.name, input: clip(p.input) });
		} else if (p.type === "local_shell_call") {
			push(l, { type: p.type, id: p.id, call_id: p.call_id, action: clip(p.action) });
		} else if (String(p.type).endsWith("_output")) {
			push(l, { type: p.type, call_id: p.call_id, output: "(trimmed)" });
		}
	}
}
process.stdout.write(`${out.map((l) => JSON.stringify(l)).join("\n")}\n`);
