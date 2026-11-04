import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Document, isSeq, parse as parseYaml } from "yaml";
import type { Confidence, DecidedBy, Harness, NoteStatus, Target } from "./types.ts";

export const NOTE_SCHEMA = 1;

export interface Note {
	id: string;
	captured: string;
	harness: Harness;
	session: string;
	session_file: string;
	anchor: string;
	adr_dir: string;
	proposed_target: Target;
	confidence: Confidence;
	decided_by: DecidedBy;
	signals: string[];
	related: string[];
	status: NoteStatus;
	resolved_to?: string;
	decision: string;
	why: string;
	alternatives: string[];
	quote: string;
}

export function noteId(harness: Harness, session: string, anchor: string): string {
	return `${harness}:${session}:${anchor}`;
}

const SLUG_STOPWORDS = new Set(
	"a an the this that these we our us will shall should would is are be been to of and or for all in on at by with using via project repo".split(
		" ",
	),
);

export function slugify(text: string, maxWords = 6, maxLen = 50): string {
	const words = text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter((w) => w && !SLUG_STOPWORDS.has(w))
		.slice(0, maxWords);
	let slug = words.join("-");
	if (slug.length > maxLen) slug = slug.slice(0, maxLen).replace(/-[^-]*$/, "");
	return slug || "decision";
}

/** YYYY-MM-DD_slug.md, with -2, -3 on collision. */
export function noteFileName(date: Date, slug: string, taken: (name: string) => boolean): string {
	const day = date.toISOString().slice(0, 10);
	const base = `${day}_${slug}`;
	if (!taken(`${base}.md`)) return `${base}.md`;
	for (let n = 2; ; n++) {
		const name = `${base}-${n}.md`;
		if (!taken(name)) return name;
	}
}

const SECRET_PATTERNS: [RegExp, string][] = [
	[
		/\b(?:(?:glpat|ghp|gho|ghs|ghu|xox[abprs]|sk|sk-ant|sk-proj)[-_][A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{30,})/g,
		"[redacted]",
	],
	[/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, "Bearer [redacted]"],
	[
		/\b((?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*)["']?[^\s"']{4,}["']?/gi,
		"$1[redacted]",
	],
	// Long base64 or hex runs; hyphens and underscores excluded so file names survive.
	[/(?<![\w/-])(?=[A-Za-z+/]*\d)[A-Za-z0-9+/]{40,}={0,2}(?![\w-])/g, "[redacted]"],
];

/** Notes are committed, so strip anything that looks like a credential. */
export function redact(text: string): string {
	let out = text;
	for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
	return out;
}

/** Short excerpt of the human's words, at most 3 lines. */
export function makeQuote(text: string, maxLines = 3, maxLen = 300): string {
	const lines = redact(text)
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, maxLines);
	let q = lines.join("\n");
	if (q.length > maxLen) q = `${q.slice(0, maxLen - 1).trimEnd()}…`;
	return q;
}

export function renderNote(n: Note): string {
	const fm: Record<string, unknown> = {
		schema: NOTE_SCHEMA,
		id: n.id,
		captured: n.captured,
		harness: n.harness,
		session: n.session,
		session_file: n.session_file,
		anchor: n.anchor,
		adr_dir: n.adr_dir,
		proposed_target: n.proposed_target,
		confidence: n.confidence,
		decided_by: n.decided_by,
		signals: n.signals,
		related: n.related,
		status: n.status,
	};
	if (n.resolved_to) fm.resolved_to = n.resolved_to;
	const doc = new Document(fm);
	for (const key of ["signals", "related"]) {
		const node = doc.get(key, true);
		if (isSeq(node)) node.flow = true;
	}
	const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
	const alts = n.alternatives.length
		? n.alternatives.map((a) => `- ${a}`).join("\n")
		: "- none mentioned";
	const quote = n.quote
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
	return `---\n${yaml}---\n## Decision\n${n.decision}\n\n## Why it matters\n${n.why}\n\n## Alternatives mentioned\n${alts}\n\n## Quote\n${quote}\n`;
}

export interface ParsedNote {
	meta: Record<string, unknown>;
	sections: Record<string, string>;
}

export function parseNote(text: string): ParsedNote | undefined {
	const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!m) return undefined;
	let meta: Record<string, unknown>;
	try {
		meta = (parseYaml(m[1] ?? "") as Record<string, unknown>) ?? {};
	} catch {
		return undefined;
	}
	const sections: Record<string, string> = {};
	const body = m[2] ?? "";
	for (const part of body.split(/^## /m).slice(1)) {
		const nl = part.indexOf("\n");
		const head = (nl < 0 ? part : part.slice(0, nl)).trim();
		sections[head] = nl < 0 ? "" : part.slice(nl + 1).trim();
	}
	return { meta, sections };
}

export interface BacklogEntry {
	file: string; // relative to repo root
	id: string;
	status: string;
	decision: string;
}

/** Notes in one backlog folder. Files starting with "_" are reports, not notes. */
export function readBacklog(root: string, backlogDir: string): BacklogEntry[] {
	const abs = join(root, backlogDir);
	let names: string[];
	try {
		names = readdirSync(abs);
	} catch {
		return [];
	}
	const out: BacklogEntry[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".md") || name.startsWith("_")) continue;
		const parsed = parseNote(readFileSync(join(abs, name), "utf8"));
		if (!parsed) continue;
		out.push({
			file: `${backlogDir}/${name}`,
			id: String(parsed.meta.id ?? ""),
			status: String(parsed.meta.status ?? ""),
			decision: parsed.sections.Decision ?? "",
		});
	}
	return out;
}

/** Write a note unless one with the same id exists. Returns the file name, or undefined when skipped. */
export function writeNote(
	root: string,
	backlogDir: string,
	note: Note,
	opts: { date: Date; dryRun?: boolean; existingIds?: Set<string> },
): { file: string; written: boolean } | undefined {
	const ids = opts.existingIds ?? new Set(readBacklog(root, backlogDir).map((e) => e.id));
	if (ids.has(note.id)) return undefined;
	const abs = join(root, backlogDir);
	const name = noteFileName(opts.date, slugify(note.decision), (n) => existsSync(join(abs, n)));
	const file = `${backlogDir}/${name}`;
	if (opts.dryRun) return { file, written: false };
	mkdirSync(abs, { recursive: true });
	writeFileSync(join(abs, name), renderNote(note), { flag: "wx" });
	ids.add(note.id);
	return { file, written: true };
}
