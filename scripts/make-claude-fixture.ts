// Trim a real Claude Code session into a small, shareable test fixture.
//
//   node scripts/make-claude-fixture.ts <session.jsonl> <name> [--rename Old=New ...] \
//     > test/fixtures/sessions/claude-code-<name>.jsonl
//
// Keeps user and assistant entries on all branches (text, tool calls, a stub
// for each tool result). Drops thinking, attachments, API bookkeeping and
// usage, relinks parentUuid over dropped entries, rewrites the cwd to
// /work/<name>, replaces the home folder with /home/user, applies --rename
// pairs (names in the text), and redacts anything that looks like a secret.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { redact } from "../src/core/notes.ts";

const [file, name, ...rest] = process.argv.slice(2);
if (!file || !name) {
	process.stderr.write(
		"usage: make-claude-fixture.ts <session.jsonl> <name> [--rename Old=New ...]\n",
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
const entries: Json[] = readFileSync(file, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l));

const realCwd = String(entries.find((e) => typeof e.cwd === "string")?.cwd ?? "");
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

const parentOf = new Map<string, string | null>();
for (const e of entries) {
	if (typeof e.uuid === "string")
		parentOf.set(e.uuid, (e.parentUuid as string) ?? (e.logicalParentUuid as string) ?? null);
}

const kept: Json[] = [];
for (const e of entries) {
	if ((e.type !== "user" && e.type !== "assistant") || e.isSidechain) continue;
	const m = e.message as Json;
	const content =
		typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Json[]);
	const blocks = content
		.map((b): Json | undefined => {
			if (b.type === "text") return { type: "text", text: clean(String(b.text ?? "")) };
			if (b.type === "tool_use")
				return { type: "tool_use", id: b.id, name: b.name, input: clip(b.input) };
			if (b.type === "tool_result")
				return { type: "tool_result", tool_use_id: b.tool_use_id, content: "(trimmed)" };
			return undefined;
		})
		.filter((b): b is Json => Boolean(b));
	if (!blocks.length) continue;
	const out: Json = {
		type: e.type,
		uuid: e.uuid,
		parentUuid: e.parentUuid ?? null,
		isSidechain: false,
		sessionId: e.sessionId,
		cwd: `/work/${name}`,
		timestamp: e.timestamp,
		message: {
			role: m.role,
			content: typeof m.content === "string" ? clean(m.content) : blocks,
		},
	};
	if (e.isMeta) out.isMeta = true;
	if (e.origin) out.origin = e.origin;
	kept.push(out);
}
const keep = new Set(kept.map((e) => e.uuid as string));
for (const e of kept) {
	let p = (e.parentUuid as string | null) ?? null;
	while (p && !keep.has(p)) p = parentOf.get(p) ?? null;
	e.parentUuid = p;
}
process.stdout.write(`${kept.map((e) => JSON.stringify(e)).join("\n")}\n`);
