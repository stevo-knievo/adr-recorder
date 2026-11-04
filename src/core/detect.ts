import {
	CONFIDENCES,
	type Confidence,
	type DecidedBy,
	type Exchange,
	TARGETS,
	type Target,
	type ToolCall,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Stage 1: cheap trigger. No model call.
// ---------------------------------------------------------------------------

interface Rule {
	id: string;
	re: RegExp;
	weight: number;
}

export const THRESHOLD = 3;

/** Phrases in the user's own words. Weight 3 fires alone. */
export const USER_RULES: Rule[] = [
	{ id: "phrase:go-with", re: /\b(go|going|went) with\b/i, weight: 3 },
	{
		id: "phrase:we-use",
		re: /\b(let'?s|we'?ll|we will|we should|we'?re going to|we are going to) (use|adopt|pick|choose|switch to|stick with|keep using|move to)\b/i,
		weight: 3,
	},
	{ id: "phrase:decided", re: /\b(decided|we decide|decision is|the call is)\b/i, weight: 3 },
	{ id: "phrase:instead-of", re: /\binstead of\b/i, weight: 3 },
	{ id: "phrase:rather-than", re: /\brather than\b/i, weight: 3 },
	{ id: "phrase:in-favour-of", re: /\bin favou?r of\b/i, weight: 3 },
	{ id: "phrase:over", re: /\b(prefer|chose|choose|pick)\w*\s+\S+(\s+\S+)?\s+over\s/i, weight: 3 },
	{
		id: "phrase:default-to",
		re: /\b(default to|by default (we|use)|standardi[sz]e on)\b/i,
		weight: 3,
	},
	{ id: "phrase:from-now-on", re: /\b(from now on|going forward|from here on)\b/i, weight: 3 },
	{
		id: "phrase:always-never",
		re: /\b(always|never|must|must not|don'?t ever)\s+(use|call|write|put|add|commit|deploy|run|store|mean|means)\b/i,
		weight: 3,
	},
	{
		id: "phrase:convention",
		re: /\b(the rule is|convention is|our convention|we prefer)\b/i,
		weight: 3,
	},
	{ id: "phrase:we-use-plain", re: /\bwe use \S+/i, weight: 2 },
	{
		id: "phrase:switch",
		re: /\b(switch|migrate|move) (to|from|over to)\b|\breplace \S+ with\b/i,
		weight: 2,
	},
	{ id: "glossary:means", re: /\b(means|stands for|we call|is short for)\b/i, weight: 2 },
	{ id: "glossary:mix-up", re: /\b(mix|mixing|mixed) (that|this|them|these|it) up\b/i, weight: 2 },
	{ id: "runbook:on-call", re: /\bon-?call\b|\brunbook\b/i, weight: 2 },
	{
		id: "runbook:when-breaks",
		re: /\bwhen\b.{3,80}\b(backs? up|fails?|goes down|is down|breaks|alerts?|fills? up)\b/i,
		weight: 2,
	},
	{
		id: "reason:requirement",
		re: /\b(hard requirement|requirement from|non-negotiable)\b/i,
		weight: 1,
	},
	{ id: "reason:because", re: /\b(because|since|so that)\b/i, weight: 1 },
];

/** Assistant wording only adds weight, never fires alone. */
export const ASSISTANT_RULES: Rule[] = [
	{ id: "assistant:trade-off", re: /\btrade-?offs?\b|\bpros and cons\b/i, weight: 1 },
	{
		id: "assistant:alternative",
		re: /\balternatively\b|\binstead of\b|\brather than\b/i,
		weight: 1,
	},
	{
		id: "assistant:recommend",
		re: /\bi('d)? recommend\b|\bmy recommendation\b|\bopted for\b/i,
		weight: 1,
	},
];
const ASSISTANT_CAP = 2;

const CONFIRM_RE =
	/^\s*(yes|yep|yeah|y|ok|okay|go|go ahead|approved|sure|agreed|lgtm|sounds good|do it|ship it|let'?s do (it|that)|option \w+|do \d+|\d+)\b/i;
const OPTIONS_RE =
	/\boption\b|\balternatively\b|\bi('d)? recommend\b|\brecommendation\b|\btrade-?offs?\b|\bwould you (like|prefer)\b|\bshould (we|i)\b/i;
const LIST_ITEM_RE = /^\s*(\d+[.)]|[-*])\s+\S/gm;

const INSTALL_RE =
	/\b(npm|pnpm|yarn|bun)\s+(add|install|i)\s+(-\S+\s+)*[@a-z]|\b(pip3?|uv|poetry)\s+(add|install)\s+\w|\bgo get\s+\S|\bcargo add\s+\S|\bdotnet add\b.*\bpackage\b/i;
const SCAFFOLD_RE =
	/\b(npm|pnpm|yarn|bun) (init|create)\b|\bnpx create-|\bdotnet new\b|\bcargo (new|init)\b|\bgo mod init\b|\bgit init\b|\bterraform init\b|\brails new\b/i;
const CONFIG_FILE_RE =
	/^(package\.json|tsconfig(\..+)?\.json|\.editorconfig|\.prettierrc(\..+)?|prettier\.config\..+|biome\.jsonc?|\.eslintrc(\..+)?|eslint\.config\..+|\.stylelintrc.*|\.gitlab-ci\.yml|dockerfile|docker-compose.*\.ya?ml|compose\.ya?ml|.*\.tf|go\.mod|.*\.csproj|directory\.build\.props|.*\.ruleset|pyproject\.toml|cargo\.toml|vitest\.config\..+|jest\.config\..+|agents\.md|claude\.md|\.adr-recorder\.yaml)$/i;
const WRITE_TOOLS = /^(write|edit|multiedit|apply_patch|str_replace\w*|create_file|notebookedit)$/i;

export interface Trigger {
	fired: boolean;
	score: number;
	signals: string[];
}

/** Drop fenced code and quoted lines; pasted text isn't a decision. */
export function stripQuoted(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.split("\n")
		.filter((l) => !l.trimStart().startsWith(">"))
		.join("\n");
}

/** A message that is only one question ("Should we use Zod?") decides nothing yet. */
function isBareQuestion(text: string): boolean {
	const t = text.trim();
	if (!t.endsWith("?")) return false;
	return t.split(/[.!?]\s+/).filter((s) => s.trim()).length <= 1;
}

function isConfirmation(user: string, previousAssistant: string): boolean {
	const u = user.trim();
	if (u.length > 80 || !CONFIRM_RE.test(u)) return false;
	const listItems = previousAssistant.match(LIST_ITEM_RE)?.length ?? 0;
	return OPTIONS_RE.test(previousAssistant) || listItems >= 2;
}

export function toolPath(call: ToolCall): string | undefined {
	for (const k of ["path", "file_path", "filePath", "file"]) {
		const v = call.args[k];
		if (typeof v === "string" && v) return v;
	}
	return undefined;
}

export function toolCommand(call: ToolCall): string | undefined {
	for (const k of ["command", "cmd"]) {
		const v = call.args[k];
		if (typeof v === "string") return v;
		if (Array.isArray(v)) return v.join(" ");
	}
	return undefined;
}

function toolSignals(calls: ToolCall[]): string[] {
	const out = new Set<string>();
	for (const c of calls) {
		const cmd = toolCommand(c);
		if (cmd && INSTALL_RE.test(cmd)) out.add("tool:package-install");
		if (cmd && SCAFFOLD_RE.test(cmd)) out.add("tool:scaffold");
		const p = toolPath(c);
		if (p && WRITE_TOOLS.test(c.name)) {
			const base = p.split(/[\\/]/).pop() ?? "";
			if (CONFIG_FILE_RE.test(base)) out.add("tool:config-file");
		}
	}
	return [...out];
}

export function scoreExchange(ex: Exchange): Trigger {
	const signals: string[] = [];
	let score = 0;
	const user = stripQuoted(ex.user);

	if (isConfirmation(user, ex.previousAssistant)) {
		signals.push("confirm:options");
		score += THRESHOLD;
	} else if (!isBareQuestion(user)) {
		for (const r of USER_RULES) {
			if (r.re.test(user)) {
				signals.push(r.id);
				score += r.weight;
			}
		}
	}

	let assistantScore = 0;
	const assistant = stripQuoted(ex.assistant);
	for (const r of ASSISTANT_RULES) {
		if (r.re.test(assistant)) {
			signals.push(r.id);
			assistantScore += r.weight;
		}
	}
	score += Math.min(assistantScore, ASSISTANT_CAP);

	for (const s of toolSignals(ex.toolCalls)) {
		signals.push(s);
		score += THRESHOLD;
	}

	// Assistant wording alone never fires, however much of it there is.
	const fromOthers = score - Math.min(assistantScore, ASSISTANT_CAP);
	return { fired: fromOthers > 0 && score >= THRESHOLD, score, signals };
}

// ---------------------------------------------------------------------------
// Stage 2: classifier. Only called when the trigger fires.
// ---------------------------------------------------------------------------

export interface KnownDoc {
	id: string; // file path for ADRs, note id for backlog notes
	title: string;
}

export interface ClassifierInput {
	exchange: Exchange;
	signals: string[];
	adrs: KnownDoc[];
	backlog: KnownDoc[];
}

export interface Classification {
	is_decision: boolean;
	summary: string;
	proposed_target: Target;
	confidence: Confidence;
	alternatives: string[];
	duplicate_of: string | null;
	decided_by: DecidedBy;
	why: string;
	/** Short excerpt of the human's words for this decision, when it could be matched. */
	quote?: string;
}

export const MAX_DECISIONS_PER_EXCHANGE = 5;

export interface Classifier {
	/** Decisions found in the exchange, possibly none. */
	classify(input: ClassifierInput, signal?: AbortSignal): Promise<Classification[]>;
}

export interface Prompt {
	system: string;
	user: string;
}

const SYSTEM_PROMPT = `You review one exchange from a coding session between a human and a coding agent.
Find the project decisions the human made (or confirmed) that are worth writing down, and where each belongs.
One message can hold several decisions, for example answers to a list of questions. List each separately, at most ${MAX_DECISIONS_PER_EXCHANGE}. Most exchanges hold none.

Targets, pick exactly one per decision:
- adr: expensive or slow to reverse (data store, framework, runtime, auth model, API style, repo layout, hosting), deviates from a default, real alternatives were weighed, or people will ask "why" in six months.
- rfc: still being worked out, needs feedback before choosing.
- spec: how something is built (interfaces, data flow, edge cases).
- runbook: on-call or repeated ops steps.
- standard: a rule people follow (coding style, naming, MR rules).
- agents: a rule for coding agents working in the repo.
- decision_log: a small decision not worth an ADR (one line).
- readme: explains what the system is or how to run it.
- glossary: a term and its one meaning.
- tooling: a rule a linter, formatter, editorconfig or analyzer can enforce. Prefer this over a prose standard.
- discard: not worth recording.

Rules:
- Humans own decisions. If only the agent proposed it and the human did not agree, set decided_by "agent" and confidence "low".
- A plain "yes"/"ok"/"do 2" that accepts options the agent offered counts as a human decision about that option.
- A question or proposal in the agent's reply is not a decision yet: the human answers it in a later exchange. Judge only what the human said or confirmed.
- Routine implementation steps, single names, process chatter (permissions, git workflow for this session) are not decisions. Leave them out.
- If an existing ADR or backlog note already covers it, set duplicate_of to its id.
- summary: one or two plain sentences, using the words from the session. No filler.
- why: one line, which signal makes it matter.
- alternatives: options that were mentioned and not chosen. Empty list if none.
- quote: the human's own words for this decision, copied exactly, at most two lines.

Reply with JSON only, an empty list when there is nothing to record:
{"decisions": [{"summary": string, "proposed_target": string, "confidence": "low"|"medium"|"high", "alternatives": string[], "duplicate_of": string|null, "decided_by": "human"|"agent", "why": string, "quote": string}]}`;

const LIMITS = { user: 4000, assistant: 3000, previous: 1500, tools: 15, docs: 80 };

/** Keep the head and tail, they carry the question and the outcome. */
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 5) / 2);
	return `${text.slice(0, half)}\n[…]\n${text.slice(-half)}`;
}

function describeTool(c: ToolCall): string {
	const target = toolCommand(c) ?? toolPath(c) ?? "";
	return `- ${c.name} ${clip(target.replace(/\s+/g, " "), 200)}`.trimEnd();
}

export function buildClassifierPrompt(input: ClassifierInput): Prompt {
	const ex = input.exchange;
	const docs = (list: KnownDoc[]) =>
		list.length
			? list
					.slice(0, LIMITS.docs)
					.map((d) => `- ${d.id}: ${d.title}`)
					.join("\n")
			: "(none)";
	const tools = ex.toolCalls.slice(0, LIMITS.tools).map(describeTool).join("\n") || "(none)";
	const user = [
		`Existing ADRs:\n${docs(input.adrs)}`,
		`Existing backlog notes:\n${docs(input.backlog)}`,
		`Trigger signals: ${input.signals.join(", ") || "(none)"}`,
		`Previous agent message:\n${clip(ex.previousAssistant, LIMITS.previous) || "(none)"}`,
		`Human:\n${clip(ex.user, LIMITS.user)}`,
		`Agent reply:\n${clip(ex.assistant, LIMITS.assistant) || "(none)"}`,
		`Agent tool calls:\n${tools}`,
	].join("\n\n");
	return { system: SYSTEM_PROMPT, user };
}

const TARGET_ALIASES: Record<string, Target> = {
	"design doc": "rfc",
	"design-doc": "rfc",
	"tech spec": "spec",
	"tech-spec": "spec",
	runbooks: "runbook",
	convention: "standard",
	"standard (humans)": "standard",
	"standard (agents)": "agents",
	"agents.md": "agents",
	"decision log": "decision_log",
	"decision-log": "decision_log",
	"tooling config": "tooling",
	config: "tooling",
	"readme / overview": "readme",
	none: "discard",
};

export function normalizeTarget(v: unknown): Target {
	const s = String(v ?? "")
		.trim()
		.toLowerCase();
	if ((TARGETS as readonly string[]).includes(s)) return s as Target;
	return TARGET_ALIASES[s] ?? "discard";
}

function extractJson(text: string): Record<string, unknown> {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("classifier reply has no JSON object");
	return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

const squash = (s: string) =>
	s
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();

/** Every part of the quote (split at ellipses) must appear in the human's text. */
function quoteMatches(quote: string, human: string): boolean {
	const h = squash(human);
	const parts = quote
		.split(/\.\.\.|\u2026/)
		.map(squash)
		.filter((p) => p.length > 2);
	return parts.length > 0 && parts.every((p) => h.includes(p));
}

/**
 * Parse the model's reply into decisions. Tolerates code fences, prose around
 * the JSON, and a single decision object instead of a list. Quotes that don't
 * appear in the human's message are dropped, so a note never invents words.
 */
export function parseClassifications(text: string, humanText?: string): Classification[] {
	const raw = extractJson(text);
	const items = Array.isArray(raw.decisions)
		? (raw.decisions as unknown[])
		: "summary" in raw || "is_decision" in raw
			? [raw]
			: [];
	const out: Classification[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const c = toClassification({ is_decision: true, ...(item as Record<string, unknown>) });
		if (!c.is_decision || !c.summary || c.proposed_target === "discard") continue;
		if (c.quote && humanText !== undefined && !quoteMatches(c.quote, humanText)) delete c.quote;
		out.push(c);
		if (out.length >= MAX_DECISIONS_PER_EXCHANGE) break;
	}
	return out;
}

/** Parse a single decision object. */
export function parseClassification(text: string): Classification {
	return toClassification(extractJson(text));
}

function toClassification(raw: Record<string, unknown>): Classification {
	const decidedBy: DecidedBy = raw.decided_by === "agent" ? "agent" : "human";
	let confidence: Confidence = (CONFIDENCES as readonly string[]).includes(String(raw.confidence))
		? (raw.confidence as Confidence)
		: "low";
	if (decidedBy === "agent") confidence = "low";
	const dup = raw.duplicate_of;
	return {
		is_decision: raw.is_decision === true,
		summary: String(raw.summary ?? "").trim(),
		proposed_target: normalizeTarget(raw.proposed_target),
		confidence,
		alternatives: Array.isArray(raw.alternatives)
			? raw.alternatives.map(String).filter(Boolean)
			: [],
		duplicate_of: typeof dup === "string" && dup.trim() && dup !== "null" ? dup.trim() : null,
		decided_by: decidedBy,
		why: String(raw.why ?? "").trim(),
		...(typeof raw.quote === "string" && raw.quote.trim() ? { quote: raw.quote.trim() } : {}),
	};
}
