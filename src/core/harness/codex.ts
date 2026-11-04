import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { endpointModelId } from "../classifier-openai.ts";
import { REVIEW_CHILD_ENV } from "../review.ts";
import { shq } from "../shell.ts";
import type { Session, ToolCall, Turn } from "../types.ts";
import type {
	Env,
	FoundSession,
	HarnessAdapter,
	ReviewerAgent,
	ReviewerRun,
	SessionSource,
} from "./types.ts";

/**
 * Codex rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.
 * Each line is `{timestamp, type, payload}`:
 *
 * - `session_meta`: id, cwd, start time (first line).
 * - `response_item`: what the model saw and said. `message` (role user,
 *   assistant or developer), `function_call`, `custom_tool_call`,
 *   `local_shell_call`, `reasoning`, tool outputs. User messages here also
 *   carry injected context (AGENTS.md, environment), so the human's own
 *   words come from events instead.
 * - `event_msg`: UI events. The human's input is `item_completed` with a
 *   `UserMessage` item (current versions) or `user_message` (older ones).
 *   `thread_rolled_back` drops the last turns.
 */
interface CodexLine {
	timestamp?: string;
	type?: string;
	payload?: Record<string, unknown>;
}

function parseLines(text: string): CodexLine[] {
	const out: CodexLine[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as CodexLine);
		} catch {
			// The last line can be half-written while the session runs.
		}
	}
	return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function texts(content: unknown, types: string[]): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && types.includes(str((c as { type?: unknown }).type)))
		.map((c) => str((c as { text?: unknown }).text))
		.join("\n")
		.trim();
}

/** The files an apply_patch touches; that's what detection looks at. */
export function patchFiles(patch: string): string[] {
	const out: string[] = [];
	for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
		if (m[1]) out.push(m[1].trim());
	}
	return out;
}

function toolCalls(p: Record<string, unknown>): ToolCall[] {
	const name = str(p.name);
	if (p.type === "function_call") {
		let args: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(str(p.arguments) || "{}");
			if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
		} catch {
			// keep the call, without arguments
		}
		if (name === "apply_patch" && typeof args.input === "string")
			return patchFiles(args.input).map((path) => ({ name, args: { path } }));
		return [{ name, args }];
	}
	if (p.type === "custom_tool_call") {
		const input = str(p.input);
		if (name === "apply_patch") return patchFiles(input).map((path) => ({ name, args: { path } }));
		return [{ name, args: { input } }];
	}
	if (p.type === "local_shell_call") {
		const action = (p.action ?? {}) as { command?: unknown };
		return [{ name: "shell", args: { command: action.command } }];
	}
	return [];
}

/** The human's words from an event, or undefined. */
function humanInput(p: Record<string, unknown>, mode: "item" | "event"): string | undefined {
	if (mode === "item" && p.type === "item_completed") {
		const item = (p.item ?? {}) as { type?: unknown; content?: unknown };
		if (item.type !== "UserMessage") return undefined;
		return texts(item.content, ["text"]) || undefined;
	}
	if (mode === "event" && p.type === "user_message") {
		return str(p.message).trim() || undefined;
	}
	return undefined;
}

function itemId(p: Record<string, unknown>): string {
	const item = (p.item ?? {}) as { id?: unknown };
	return str(item.id) || str(p.id) || str(p.call_id);
}

/** Drop the last `n` human turns and everything after each. */
function rollBack(turns: Turn[], n: number): void {
	let cut = turns.length;
	for (let seen = 0; seen < n && cut > 0; ) {
		cut--;
		if (turns[cut]?.role === "user") seen++;
	}
	turns.length = cut;
}

export function parseCodexSession(text: string, file: string): Session {
	const lines = parseLines(text);
	const meta = lines.find((l) => l.type === "session_meta")?.payload ?? {};
	// Current versions log the human's input as items; don't count it twice
	// when the older event shape is there too.
	const mode = lines.some(
		(l) =>
			l.type === "event_msg" &&
			l.payload?.type === "item_completed" &&
			(l.payload.item as { type?: unknown })?.type === "UserMessage",
	)
		? "item"
		: "event";

	const turns: Turn[] = [];
	lines.forEach((l, i) => {
		const p = l.payload;
		if (!p) return;
		const ts = l.timestamp ?? "";
		const anchor = itemId(p) || `line-${i}`;
		if (l.type === "event_msg") {
			if (p.type === "thread_rolled_back") {
				rollBack(turns, Number(p.num_turns) || 0);
				return;
			}
			const human = humanInput(p, mode);
			if (human) turns.push({ role: "user", text: human, toolCalls: [], ts, anchor });
			return;
		}
		if (l.type !== "response_item") return;
		if (p.type === "message" && p.role === "assistant") {
			const t = texts(p.content, ["output_text"]);
			if (t) turns.push({ role: "assistant", text: t, toolCalls: [], ts, anchor });
			return;
		}
		const calls = toolCalls(p);
		if (calls.length) turns.push({ role: "assistant", text: "", toolCalls: calls, ts, anchor });
	});

	return {
		harness: "codex",
		id: str(meta.id) || str(meta.session_id) || basename(file, ".jsonl"),
		file,
		cwd: str(meta.cwd),
		started: str(meta.timestamp) || (lines[0]?.timestamp ?? ""),
		turns,
	};
}

export function codexSessionsDir(env: Env, home: string): string {
	return join(env.CODEX_HOME || join(home, ".codex"), "sessions");
}

/** session_meta from the first line. It can be long (instructions), so read enough. */
function readMeta(file: string): { cwd: string; id: string; started: string } | undefined {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(1024 * 1024);
		const n = readSync(fd, buf, 0, buf.length, 0);
		const first = buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
		const l = JSON.parse(first) as CodexLine;
		if (l.type !== "session_meta" || !l.payload) return undefined;
		const p = l.payload;
		const cwd = str(p.cwd);
		if (!cwd) return undefined;
		return {
			cwd,
			id: str(p.id) || str(p.session_id),
			started: str(p.timestamp) || (l.timestamp ?? ""),
		};
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

const within = (child: string, parent: string) =>
	child === parent || child.startsWith(parent + sep);

/** Rollout files under the date folders, skipping days before `since`. */
function rollouts(root: string, since?: Date): string[] {
	const day = since ? since.toISOString().slice(0, 10) : "";
	const out: string[] = [];
	const walk = (dir: string, parts: string[]) => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const abs = join(dir, name);
			if (name.endsWith(".jsonl")) {
				if (name.startsWith("rollout-")) out.push(abs);
				continue;
			}
			const next = [...parts, name];
			// YYYY, YYYY/MM, YYYY/MM/DD: prune whole folders older than `since`.
			if (day && next.join("-") < day.slice(0, next.join("-").length)) continue;
			try {
				if (statSync(abs).isDirectory()) walk(abs, next);
			} catch {
				// vanished
			}
		}
	};
	walk(root, []);
	return out;
}

export function findCodexSessions(
	sessionsRoot: string,
	projectPath: string,
	since?: Date,
): FoundSession[] {
	const project = resolve(projectPath);
	const out: FoundSession[] = [];
	for (const file of rollouts(sessionsRoot, since)) {
		const meta = readMeta(file);
		if (!meta || !within(resolve(meta.cwd), project)) continue;
		if (since && meta.started && new Date(meta.started) < since) continue;
		out.push({ harness: "codex", file, ...meta });
	}
	return out.sort((a, b) => a.started.localeCompare(b.started));
}

const prompt = (run: ReviewerRun) => `"$(cat ${shq(run.promptFile)})"`;
const bin = (run: ReviewerRun) => run.bin ?? "codex";
/** Codex takes the model name alone, without pi's provider part. */
const model = (run: ReviewerRun) => shq(endpointModelId(run.model));

export const codexSessions: SessionSource = {
	name: "codex",
	sessionsDir: codexSessionsDir,
	findSessions: findCodexSessions,
	loadSession: (file) => parseCodexSession(readFileSync(file, "utf8"), file),
};

export const codexReviewer: ReviewerAgent = {
	name: "codex",
	reviewerCommand: (run) =>
		`cd ${shq(run.cwd)} && ${REVIEW_CHILD_ENV}=1 ${bin(run)} --model ${model(run)} -- ${prompt(run)}`,
	// Headless: the sandbox lets it read anything (transcripts live outside the
	// repo) and write only inside the repo, where the report goes.
	headlessReviewerCommand: (run) =>
		`cd ${shq(run.cwd)} && ${REVIEW_CHILD_ENV}=1 ${bin(run)} exec --model ${model(run)} --sandbox workspace-write --skip-git-repo-check -- ${prompt(run)}`,
};

export const codexHarness: HarnessAdapter = {
	name: "codex",
	sessions: codexSessions,
	reviewer: codexReviewer,
};
