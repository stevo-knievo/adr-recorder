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
 * Claude Code transcripts: `~/.claude/projects/<encoded cwd>/<session id>.jsonl`.
 * Every line has a `type`. Messages (`user`, `assistant`) and bookkeeping
 * entries (`attachment`, `system`, ...) share one tree through `uuid` and
 * `parentUuid`; rewinding starts a new branch, and compaction restarts the
 * chain with `parentUuid: null` plus `logicalParentUuid`.
 */
interface CcBlock {
	type?: string;
	text?: string;
	name?: string;
	input?: unknown;
}

interface CcEntry {
	type?: string;
	uuid?: string;
	parentUuid?: string | null;
	logicalParentUuid?: string | null;
	isSidechain?: boolean;
	isMeta?: boolean;
	sessionId?: string;
	cwd?: string;
	timestamp?: string;
	origin?: { kind?: string };
	message?: { role?: string; content?: string | CcBlock[] };
}

function parseLines(text: string): CcEntry[] {
	const out: CcEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as CcEntry);
		} catch {
			// The last line can be half-written while the session runs.
		}
	}
	return out;
}

const isMessage = (e: CcEntry) => (e.type === "user" || e.type === "assistant") && !e.isSidechain;

/** Entries on the branch that ends at the last message, oldest first. */
export function activeBranch(entries: CcEntry[]): CcEntry[] {
	const byId = new Map<string, CcEntry>();
	for (const e of entries) if (e.uuid) byId.set(e.uuid, e);
	let leaf: CcEntry | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.uuid && isMessage(e)) {
			leaf = e;
			break;
		}
	}
	const chain: CcEntry[] = [];
	const seen = new Set<string>();
	for (let e = leaf; e?.uuid && !seen.has(e.uuid); ) {
		seen.add(e.uuid);
		chain.push(e);
		const parent = e.parentUuid ?? e.logicalParentUuid;
		e = parent ? byId.get(parent) : undefined;
	}
	return chain.reverse();
}

const SYSTEM_PREFIXES = [
	"<local-command-stdout>",
	"<local-command-stderr>",
	"<local-command-caveat>",
	"<system-reminder>",
	"<task-notification>",
	"<bash-stdout>",
	"<bash-stderr>",
	"[Request interrupted by user",
];

/**
 * What the human typed, or undefined for tool results, hook output, command
 * echoes and other entries the client writes as `user`. `/cmd args` becomes
 * the command plus its arguments, so `/adr note ...` stays visible.
 */
export function humanText(e: CcEntry): string | undefined {
	if (e.type !== "user" || e.isMeta || e.isSidechain) return undefined;
	if (e.origin?.kind && e.origin.kind !== "human") return undefined;
	const c = e.message?.content;
	let text: string;
	if (typeof c === "string") text = c;
	else if (Array.isArray(c)) {
		if (c.some((b) => b.type === "tool_result")) return undefined;
		text = c
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("\n");
	} else return undefined;
	text = text.trim();
	const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
	if (cmd) {
		const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? "";
		text = `${cmd[1]?.trim() ?? ""} ${args.trim()}`.trim();
	}
	if (!text || SYSTEM_PREFIXES.some((p) => text.startsWith(p))) return undefined;
	return text;
}

function assistantTurn(e: CcEntry): Turn | undefined {
	const c = e.message?.content;
	const blocks: CcBlock[] = typeof c === "string" ? [{ type: "text", text: c }] : (c ?? []);
	const text = blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n")
		.trim();
	const toolCalls: ToolCall[] = blocks
		.filter((b) => b.type === "tool_use" && b.name)
		.map((b) => ({
			name: b.name ?? "",
			args: b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {},
		}));
	if (!text && !toolCalls.length) return undefined;
	return { role: "assistant", text, toolCalls, ts: e.timestamp ?? "", anchor: e.uuid ?? "" };
}

export function parseClaudeSession(text: string, file: string): Session {
	const entries = parseLines(text);
	const first = entries.find((e) => e.sessionId && e.cwd);
	const turns: Turn[] = [];
	for (const e of activeBranch(entries)) {
		if (e.type === "assistant") {
			const t = assistantTurn(e);
			if (t) turns.push(t);
			continue;
		}
		const human = humanText(e);
		if (human !== undefined) {
			turns.push({
				role: "user",
				text: human,
				toolCalls: [],
				ts: e.timestamp ?? "",
				anchor: e.uuid ?? "",
			});
		}
	}
	return {
		harness: "claude-code",
		id: first?.sessionId ?? basename(file, ".jsonl"),
		file,
		cwd: first?.cwd ?? "",
		started: entries.find((e) => e.timestamp)?.timestamp ?? "",
		turns,
	};
}

export function claudeSessionsDir(env: Env, home: string): string {
	return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
}

/** Claude Code's folder name for a cwd: every character but [A-Za-z0-9] becomes "-". */
export function encodeClaudeProjectDir(cwd: string): string {
	return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** cwd, session id and start time from the first lines that carry them. */
function readMeta(file: string): { cwd: string; id: string; started: string } | undefined {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(256 * 1024);
		const n = readSync(fd, buf, 0, buf.length, 0);
		let started = "";
		for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
			if (!line.includes('"cwd"') && !line.includes('"timestamp"')) continue;
			try {
				const e = JSON.parse(line) as CcEntry;
				started ||= e.timestamp ?? "";
				if (e.cwd && e.sessionId)
					return { cwd: e.cwd, id: e.sessionId, started: started || e.timestamp || "" };
			} catch {
				// partial line at the end of the buffer
			}
		}
		return undefined;
	} finally {
		closeSync(fd);
	}
}

const within = (child: string, parent: string) =>
	child === parent || child.startsWith(parent + sep);

export function findClaudeSessions(
	sessionsRoot: string,
	projectPath: string,
	since?: Date,
): FoundSession[] {
	const project = resolve(projectPath);
	// The folder name is lossy, but a session in the project or below always
	// starts with the project's encoded name. Confirm with the cwd inside.
	const prefix = encodeClaudeProjectDir(project);
	let dirs: string[];
	try {
		dirs = readdirSync(sessionsRoot).filter((d) => d.startsWith(prefix));
	} catch {
		return [];
	}
	const out: FoundSession[] = [];
	for (const d of dirs) {
		const abs = join(sessionsRoot, d);
		let files: string[];
		try {
			if (!statSync(abs).isDirectory()) continue;
			// Top level only: subagents/ holds sidechains, not human sessions.
			files = readdirSync(abs).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const file = join(abs, f);
			const meta = readMeta(file);
			if (!meta || !within(resolve(meta.cwd), project)) continue;
			if (since && meta.started && new Date(meta.started) < since) continue;
			out.push({ harness: "claude-code", file, ...meta });
		}
	}
	return out.sort((a, b) => a.started.localeCompare(b.started));
}

const prompt = (run: ReviewerRun) => `"$(cat ${shq(run.promptFile)})"`;
const bin = (run: ReviewerRun) => run.bin ?? "claude";
/** Claude Code takes the model name alone, without pi's provider part. */
const model = (run: ReviewerRun) => shq(endpointModelId(run.model));

export const claudeSessions: SessionSource = {
	name: "claude-code",
	sessionsDir: claudeSessionsDir,
	findSessions: findClaudeSessions,
	loadSession: (file) => parseClaudeSession(readFileSync(file, "utf8"), file),
};

export const claudeReviewer: ReviewerAgent = {
	name: "claude-code",
	reviewerCommand: (run) =>
		`cd ${shq(run.cwd)} && ${REVIEW_CHILD_ENV}=1 ${bin(run)} --model ${model(run)} ${prompt(run)}`,
	// Headless: may read anything (transcripts live outside the repo) and
	// write the report in the repo, nothing else runs without a human.
	headlessReviewerCommand: (run) =>
		`cd ${shq(run.cwd)} && ${REVIEW_CHILD_ENV}=1 ${bin(run)} -p --model ${model(run)} --permission-mode acceptEdits --allowedTools Read Glob Grep Write -- ${prompt(run)}`,
};

export const claudeCodeHarness: HarnessAdapter = {
	name: "claude-code",
	sessions: claudeSessions,
	reviewer: claudeReviewer,
};
