import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RepoConfig } from "./config.ts";
import type { DocTarget } from "./types.ts";

/** Checked in order when nothing is configured. Matching ignores case. */
export const KNOWN_ADR_DIRS = [
	"docs/adr",
	"docs/adrs",
	"doc/adr",
	"doc/adrs",
	"docs/decisions",
	"doc/decisions",
	"docs/architecture/decisions",
	"doc/architecture/decisions",
	"docs/architecture-decisions",
	"adr",
	"adrs",
	"architecture/decisions",
];

export const DEFAULT_ADR_DIR = "docs/adr";
export const DEFAULT_STATUSES = ["Proposed", "Accepted", "Deprecated", "Superseded"];
const TEMPLATE_NAMES = [
	".template.md",
	"template.md",
	"0000-template.md",
	"adr-template.md",
	"_template.md",
];
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"vendor",
	"target",
	".venv",
	"bin",
	"obj",
	// Test data often holds sample ADR folders; they are not the repo's own.
	"fixtures",
	"__fixtures__",
	"testdata",
]);
const MAX_DEPTH = 6;

export type LayoutSource = "config" | "adr-tools" | "log4brains" | "known" | "none";
export type Numbering = "sequential" | "date";
export type TemplateKind = "madr" | "nygard" | "custom";

export interface AdrFolder {
	/** Relative to the repo root, forward slashes. */
	dir: string;
	backlog: string;
	/** Package folder the ADR folder belongs to ("" for the repo root). */
	scope: string;
}

export interface Layout {
	root: string;
	source: LayoutSource;
	/** Main ADR folder. Set even when source is "none" (the default suggestion). */
	adrDir: string;
	backlogDir: string;
	/** Main folder first, then nested package folders (monorepos). */
	folders: AdrFolder[];
	numbering: Numbering;
	template?: string;
	templateKind?: TemplateKind;
	statuses: string[];
	targets: Record<DocTarget, string>;
}

const posix = (p: string) => p.split(sep).join("/");

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function hasMarkdown(dir: string): boolean {
	try {
		return readdirSync(dir).some((f) => f.toLowerCase().endsWith(".md"));
	} catch {
		return false;
	}
}

/** Resolve a relative path segment by segment, ignoring case. Returns the real spelling. */
function findCaseInsensitive(root: string, rel: string): string | undefined {
	let cur = root;
	const parts: string[] = [];
	for (const seg of rel.split("/")) {
		let names: string[];
		try {
			names = readdirSync(cur);
		} catch {
			return undefined;
		}
		const hit = names.find((n) => n.toLowerCase() === seg.toLowerCase());
		if (!hit) return undefined;
		parts.push(hit);
		cur = join(cur, hit);
	}
	return isDir(cur) ? parts.join("/") : undefined;
}

function readAdrToolsDir(root: string): string | undefined {
	const f = join(root, ".adr-dir");
	if (!existsSync(f)) return undefined;
	const v = readFileSync(f, "utf8").trim();
	return v ? posix(v).replace(/^\.\//, "").replace(/\/$/, "") : undefined;
}

function readLog4brainsDir(root: string): string | undefined {
	for (const name of [".log4brains.yml", ".log4brains.yaml"]) {
		const f = join(root, name);
		if (!existsSync(f)) continue;
		try {
			const y = parseYaml(readFileSync(f, "utf8")) as { project?: { adrFolder?: string } } | null;
			const v = y?.project?.adrFolder;
			if (v) return posix(v).replace(/^\.\//, "").replace(/\/$/, "");
		} catch {
			// unreadable config, fall through to known folders
		}
	}
	return undefined;
}

function findMainAdrDir(root: string, cfg: RepoConfig): { dir: string; source: LayoutSource } {
	if (cfg.adr_dir) return { dir: posix(cfg.adr_dir).replace(/^\.\//, ""), source: "config" };
	const tools = readAdrToolsDir(root);
	if (tools) return { dir: tools, source: "adr-tools" };
	const l4b = readLog4brainsDir(root);
	if (l4b) return { dir: l4b, source: "log4brains" };
	for (const known of KNOWN_ADR_DIRS) {
		const hit = findCaseInsensitive(root, known);
		if (hit && hasMarkdown(join(root, hit))) return { dir: hit, source: "known" };
	}
	return { dir: DEFAULT_ADR_DIR, source: "none" };
}

/** ADR folders inside packages, e.g. services/billing/docs/adr. */
function findNestedAdrDirs(root: string, mainDir: string, ignore: string[] = []): AdrFolder[] {
	const out: AdrFolder[] = [];
	const suffixes = KNOWN_ADR_DIRS.map((k) => k.toLowerCase());
	const walk = (abs: string, depth: number) => {
		if (depth > MAX_DEPTH) return;
		let entries: string[];
		try {
			entries = readdirSync(abs);
		} catch {
			return;
		}
		for (const name of entries) {
			if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
			const child = join(abs, name);
			if (!isDir(child)) continue;
			const rel = posix(relative(root, child));
			if (ignore.some((g) => rel === g || matchesGlob(rel, g))) continue;
			const lower = rel.toLowerCase();
			const suffix = suffixes.find((s) => lower.endsWith(`/${s}`));
			if (suffix && rel !== mainDir && hasMarkdown(child)) {
				const scope = rel.slice(0, rel.length - suffix.length - 1);
				out.push({ dir: rel, backlog: `${rel}/_backlog`, scope });
				continue; // don't descend into an ADR folder
			}
			if (rel === mainDir) continue;
			walk(child, depth + 1);
		}
	};
	walk(root, 0);
	return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

export function adrFiles(absDir: string): string[] {
	try {
		return readdirSync(absDir)
			.filter((f) => f.toLowerCase().endsWith(".md"))
			.filter(
				(f) =>
					!TEMPLATE_NAMES.includes(f.toLowerCase()) &&
					!f.startsWith("_") &&
					f.toLowerCase() !== "readme.md",
			)
			.sort();
	} catch {
		return [];
	}
}

export function detectNumbering(files: string[]): Numbering {
	const date = files.filter((f) => /^\d{4}-\d{2}-\d{2}-/.test(f)).length;
	const seq = files.filter((f) => /^\d{3,5}-/.test(f) && !/^\d{4}-\d{2}-\d{2}-/.test(f)).length;
	return date > seq ? "date" : "sequential";
}

export function detectTemplateKind(text: string): TemplateKind {
	if (/considered options|decision outcome|decision drivers/i.test(text)) return "madr";
	const nygard = ["status", "context", "decision", "consequences"].every((h) =>
		new RegExp(`^#{1,3}\\s*${h}\\b`, "im").test(text),
	);
	return nygard ? "nygard" : "custom";
}

/** Status of one ADR: front matter "status:", "Status: X", or the line after "## Status". */
export function readStatus(text: string): string | undefined {
	const fm = text.match(/^---\n[\s\S]*?^status:\s*["']?([\w -]+?)["']?\s*$/im);
	if (fm?.[1]) return fm[1].trim();
	const inline = text.match(/^\**status\**:\s*\**([A-Za-z][\w -]*?)\**\s*$/im);
	if (inline?.[1]) return inline[1].trim();
	const section = text.match(/^#{1,3}\s*status\s*\n+\s*([A-Za-z][\w-]*)/im);
	return section?.[1]?.trim();
}

export function readTitle(text: string, file: string): string {
	const fm = text.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/im);
	if (fm?.[1]) return fm[1].trim();
	const h = text.match(/^#\s+(.+)$/m);
	if (h?.[1]) return h[1].trim();
	return file.replace(/\.md$/i, "");
}

function findTemplate(root: string, dir: string, cfg: RepoConfig): string | undefined {
	if (cfg.template) return posix(cfg.template);
	const abs = join(root, dir);
	let names: string[] = [];
	try {
		names = readdirSync(abs);
	} catch {
		return undefined;
	}
	for (const t of TEMPLATE_NAMES) {
		const hit = names.find((n) => n.toLowerCase() === t);
		if (hit) return `${dir}/${hit}`;
	}
	return undefined;
}

function firstExisting(root: string, candidates: string[]): string | undefined {
	for (const c of candidates) {
		const parent = dirname(c) === "." ? "" : dirname(c);
		const base = c.split("/").pop() ?? c;
		const dirAbs = join(root, parent);
		let names: string[];
		try {
			names = readdirSync(dirAbs);
		} catch {
			continue;
		}
		const hit = names.find((n) => n.toLowerCase() === base.toLowerCase());
		if (hit) return parent ? `${parent}/${hit}` : hit;
	}
	return undefined;
}

function resolveTargets(root: string, cfg: RepoConfig): Record<DocTarget, string> {
	const pick = (key: DocTarget, candidates: string[]) =>
		cfg.targets?.[key] ?? firstExisting(root, candidates) ?? (candidates[0] as string);
	return {
		rfc: pick("rfc", ["docs/rfc", "docs/rfcs", "rfc", "rfcs", "docs/design"]),
		spec: pick("spec", ["docs/spec", "docs/specs"]),
		runbook: pick("runbook", ["docs/runbooks", "runbooks", "docs/runbook"]),
		standard: pick("standard", ["docs/standards", "docs/conventions", "CONTRIBUTING.md"]),
		agents: pick("agents", ["AGENTS.md", "CLAUDE.md"]),
		decision_log: pick("decision_log", [
			"docs/decision-log.md",
			"docs/DECISIONS.md",
			"DECISIONS.md",
			"docs/decisions.md",
		]),
		readme: pick("readme", ["README.md"]),
		glossary: pick("glossary", [
			"docs/glossary.md",
			"GLOSSARY.md",
			"docs/GLOSSARY.md",
			"glossary.md",
		]),
	};
}

export function resolveLayout(root: string, cfg: RepoConfig = {}): Layout {
	const abs = resolve(root);
	const { dir, source } = findMainAdrDir(abs, cfg);
	const backlogDir = cfg.backlog_dir ? posix(cfg.backlog_dir) : `${dir}/_backlog`;
	const main: AdrFolder = { dir, backlog: backlogDir, scope: "" };
	const nested = findNestedAdrDirs(abs, dir, cfg.ignore);
	const files = adrFiles(join(abs, dir));
	const template = findTemplate(abs, dir, cfg);
	let templateKind: TemplateKind | undefined;
	if (template && existsSync(join(abs, template))) {
		templateKind = detectTemplateKind(readFileSync(join(abs, template), "utf8"));
	}
	const statuses = new Set<string>();
	if (template && existsSync(join(abs, template))) {
		const s = readStatus(readFileSync(join(abs, template), "utf8"));
		if (s) statuses.add(s); // usually the initial status, e.g. Proposed
	}
	for (const f of files) {
		const s = readStatus(readFileSync(join(abs, dir, f), "utf8"));
		if (s) statuses.add(s);
	}
	const numbering: Numbering = cfg.numbering ?? detectNumbering(files);
	return {
		root: abs,
		source,
		adrDir: dir,
		backlogDir,
		folders: [main, ...nested],
		numbering,
		template,
		templateKind,
		statuses: statuses.size ? [...statuses] : DEFAULT_STATUSES,
		targets: resolveTargets(abs, cfg),
	};
}

/** The repo uses ADRs when an ADR folder was found (configured, tool convention, or known folder). */
export function hasAdrFolder(layout: Layout): boolean {
	return layout.source !== "none" || layout.folders.length > 1;
}

/**
 * Pick the ADR folder closest to the files a decision touched. Paths are
 * relative to the repo root. Falls back to the main folder.
 */
export function pickFolder(layout: Layout, paths: string[]): AdrFolder {
	const main = layout.folders[0] as AdrFolder;
	const nested = layout.folders.slice(1);
	if (!nested.length || !paths.length) return main;
	const votes = new Map<AdrFolder, number>();
	for (const p of paths) {
		const norm = posix(p).replace(/^\.\//, "");
		const best = nested
			.filter((f) => norm === f.scope || norm.startsWith(`${f.scope}/`))
			.sort((a, b) => b.scope.length - a.scope.length)[0];
		if (best) votes.set(best, (votes.get(best) ?? 0) + 1);
	}
	if (!votes.size) return main;
	return (
		[...votes.entries()].sort(
			(a, b) => b[1] - a[1] || b[0].scope.length - a[0].scope.length,
		)[0]?.[0] ?? main
	);
}

export interface AdrEntry {
	file: string; // relative to repo root
	title: string;
	status?: string;
}

export function listAdrs(layout: Layout): AdrEntry[] {
	const out: AdrEntry[] = [];
	for (const f of layout.folders) {
		for (const name of adrFiles(join(layout.root, f.dir))) {
			const text = readFileSync(join(layout.root, f.dir, name), "utf8");
			out.push({
				file: `${f.dir}/${name}`,
				title: readTitle(text, name),
				status: readStatus(text),
			});
		}
	}
	return out;
}

/** Walk up from start until a folder with .git (dir or file). */
export function findGitRoot(start: string): string | undefined {
	let cur = resolve(start);
	for (;;) {
		if (existsSync(join(cur, ".git"))) return cur;
		const up = dirname(cur);
		if (up === cur) return undefined;
		cur = up;
	}
}
