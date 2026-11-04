import type { Exchange, Session, ToolCall, Turn } from "./types.ts";

interface PiEntry {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	cwd?: string;
	message?: { role?: string; content?: unknown };
}

interface Block {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
}

function parseLines(text: string): PiEntry[] {
	const out: PiEntry[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t));
		} catch {
			// The last line can be half-written while pi is still running.
		}
	}
	return out;
}

/** Entries on the active branch: walk parentId back from the last entry. */
function activeBranch(entries: PiEntry[]): PiEntry[] {
	const body = entries.filter((e) => e.type !== "session");
	const byId = new Map<string, PiEntry>();
	for (const e of body) if (e.id) byId.set(e.id, e);
	const last = [...body].reverse().find((e) => e.id);
	if (!last) return body; // v1 sessions have no ids
	const branch: PiEntry[] = [];
	const seen = new Set<string>();
	let cur: PiEntry | undefined = last;
	while (cur?.id && !seen.has(cur.id)) {
		seen.add(cur.id);
		branch.push(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return branch.reverse();
}

function toTurn(e: PiEntry, index: number): Turn | undefined {
	if (e.type !== "message" || !e.message) return undefined;
	const role = e.message.role;
	if (role !== "user" && role !== "assistant") return undefined;
	const content = e.message.content;
	const blocks: Block[] =
		typeof content === "string"
			? [{ type: "text", text: content }]
			: Array.isArray(content)
				? content
				: [];
	const text = blocks
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n")
		.trim();
	const toolCalls: ToolCall[] = blocks
		.filter((b) => b.type === "toolCall" && typeof b.name === "string")
		.map((b) => ({ name: b.name as string, args: asArgs(b.arguments) }));
	if (role === "user" && !text) return undefined;
	return { role, text, toolCalls, ts: e.timestamp ?? "", anchor: e.id ?? `#${index}` };
}

function asArgs(v: unknown): Record<string, unknown> {
	if (typeof v === "string") {
		try {
			return asArgs(JSON.parse(v));
		} catch {
			return { raw: v };
		}
	}
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function parsePiSession(text: string, file: string): Session {
	const entries = parseLines(text);
	const header = entries.find((e) => e.type === "session");
	if (!header) throw new Error(`not a pi session file: ${file}`);
	const turns = activeBranch(entries)
		.map(toTurn)
		.filter((t): t is Turn => t !== undefined);
	return {
		harness: "pi",
		id: header.id ?? file,
		file,
		cwd: header.cwd ?? "",
		started: header.timestamp ?? "",
		turns,
	};
}

/** Header only, without parsing the whole file. */
export function readPiHeader(
	firstLine: string,
): { id: string; cwd: string; timestamp: string } | undefined {
	try {
		const h = JSON.parse(firstLine) as PiEntry;
		if (h.type !== "session") return undefined;
		return { id: h.id ?? "", cwd: h.cwd ?? "", timestamp: h.timestamp ?? "" };
	} catch {
		return undefined;
	}
}

export function toExchanges(turns: Turn[]): Exchange[] {
	const out: Exchange[] = [];
	let cur: Exchange | undefined;
	let lastText = "";
	let prevFinal = "";
	for (const t of turns) {
		if (t.role === "user") {
			if (cur) {
				out.push(cur);
				prevFinal = lastText;
			}
			lastText = "";
			cur = {
				anchor: t.anchor,
				ts: t.ts,
				user: t.text,
				assistant: "",
				previousAssistant: prevFinal,
				toolCalls: [],
			};
			continue;
		}
		if (!cur) continue; // assistant text before any user message
		if (t.text) {
			cur.assistant = cur.assistant ? `${cur.assistant}\n\n${t.text}` : t.text;
			lastText = t.text;
		}
		cur.toolCalls.push(...t.toolCalls);
	}
	if (cur) out.push(cur);
	return out;
}
