// Trim a real pi session into a small, shareable test fixture.
//
//   node scripts/make-fixture.ts <session.jsonl> <name> > test/fixtures/sessions/pi-<name>.jsonl
//
// Keeps the header and user/assistant messages (text and tool calls).
// Drops system prompts, thinking, tool results, usage and signatures, relinks
// parentIds over dropped entries, rewrites the cwd to /work/<name>, replaces
// the home folder with /home/user, and redacts anything that looks like a secret.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { redact } from "../src/core/notes.ts";

const [file, name] = process.argv.slice(2);
if (!file || !name) {
	process.stderr.write("usage: make-fixture.ts <session.jsonl> <name>\n");
	process.exit(2);
}

type Json = Record<string, unknown>;
const entries: Json[] = readFileSync(file, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l));

const header = entries.find((e) => e.type === "session") as Json;
const realCwd = String(header.cwd ?? "");
const home = homedir();
const clean = (s: string) =>
	redact(s.split(realCwd).join(`/work/${name}`).split(home).join("/home/user"));
const clipArg = (v: unknown): unknown => {
	if (typeof v === "string") return clean(v.length > 400 ? `${v.slice(0, 400)}…` : v);
	if (Array.isArray(v)) return v.map(clipArg);
	if (v && typeof v === "object")
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipArg(x)]));
	return v;
};

const parentOf = new Map<string, string | null>();
for (const e of entries)
	if (typeof e.id === "string") parentOf.set(e.id, (e.parentId as string) ?? null);

const keep = new Set<string>();
const out: Json[] = [
	{
		type: "session",
		version: header.version ?? 3,
		id: header.id,
		timestamp: header.timestamp,
		cwd: `/work/${name}`,
	},
];
const kept: Json[] = [];
for (const e of entries) {
	if (e.type !== "message") continue;
	const m = e.message as Json;
	if (m.role !== "user" && m.role !== "assistant") continue;
	const content = Array.isArray(m.content)
		? (m.content as Json[])
		: [{ type: "text", text: String(m.content ?? "") }];
	const blocks = content
		.filter((b) => b.type === "text" || b.type === "toolCall")
		.map((b) =>
			b.type === "text"
				? { type: "text", text: clean(String(b.text ?? "")) }
				: { type: "toolCall", id: b.id, name: b.name, arguments: clipArg(b.arguments) },
		);
	if (!blocks.length) continue;
	keep.add(e.id as string);
	kept.push({
		type: "message",
		id: e.id,
		parentId: e.parentId,
		timestamp: e.timestamp,
		message: { role: m.role, content: blocks },
	});
}
for (const e of kept) {
	let p = (e.parentId as string | null) ?? null;
	while (p && !keep.has(p)) p = parentOf.get(p) ?? null;
	e.parentId = p;
	out.push(e);
}
process.stdout.write(`${out.map((e) => JSON.stringify(e)).join("\n")}\n`);
