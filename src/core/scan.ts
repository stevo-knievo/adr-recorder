import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	type Classification,
	type Classifier,
	type KnownDoc,
	scoreExchange,
	toolPath,
} from "./detect.ts";
import { type Layout, listAdrs, pickFolder } from "./layout.ts";
import { makeQuote, type Note, noteId, readBacklog, writeNote } from "./notes.ts";
import { REVIEW_MARKER } from "./review.ts";
import { toExchanges } from "./transcript.ts";
import type { Exchange, Session } from "./types.ts";

const within = (child: string, parent: string) =>
	child === parent || child.startsWith(parent + sep);

/** Repo-relative paths a decision is about: files the agent touched or the human named. */
export function touchedPaths(ex: Exchange, sessionCwd: string, root: string): string[] {
	const out = new Set<string>();
	const add = (p: string) => {
		const abs = isAbsolute(p) ? p : resolve(sessionCwd || root, p);
		if (!within(abs, root)) return;
		const rel = relative(root, abs).split(sep).join("/");
		if (rel) out.add(rel);
	};
	for (const c of ex.toolCalls) {
		const p = toolPath(c);
		if (p) add(p);
	}
	for (const m of ex.user.matchAll(/(?:^|[\s`'"(])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+)/g)) {
		if (m[1]) add(m[1]);
	}
	if (!out.size && sessionCwd && within(resolve(sessionCwd), root)) {
		const rel = relative(root, resolve(sessionCwd)).split(sep).join("/");
		if (rel) out.add(rel);
	}
	return [...out];
}

export type Outcome =
	| "no-trigger"
	| "exists"
	| "not-decision"
	| "duplicate"
	| "written"
	| "would-write"
	| "error";

export interface ExchangeResult {
	anchor: string;
	ts: string;
	user: string;
	signals: string[];
	outcome: Outcome;
	file?: string;
	summary?: string;
	target?: string;
	confidence?: string;
	duplicateOf?: string;
	error?: string;
}

export interface ScanContext {
	layout: Layout;
	classifier: Classifier;
	dryRun?: boolean;
	now?: () => Date;
	signal?: AbortSignal;
	/** Only look at exchanges this returns true for (live capture: the new ones). */
	filter?: (ex: Exchange) => boolean;
	/** Called after each note is written. */
	onNote?: (file: string) => void;
	/** Shown as ~ in session_file, so committed notes don't carry a home path. */
	home?: string;
}

export function tildify(p: string, home?: string): string {
	if (!home) return p;
	return p === home ? "~" : p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p;
}

/** Run both detection stages over one session and write backlog notes. */
export async function scanSession(session: Session, ctx: ScanContext): Promise<ExchangeResult[]> {
	const { layout } = ctx;
	const now = ctx.now ?? (() => new Date());
	const adrs: KnownDoc[] = listAdrs(layout).map((a) => ({ id: a.file, title: a.title }));
	const backlog = layout.folders.flatMap((f) => readBacklog(layout.root, f.backlog));
	const ids = new Set(backlog.map((b) => b.id));
	const known: KnownDoc[] = backlog.map((b) => ({
		id: b.id,
		title: b.decision.split("\n")[0] ?? "",
	}));

	const results: ExchangeResult[] = [];
	for (const ex of toExchanges(session.turns)) {
		if (ctx.filter && !ctx.filter(ex)) continue;
		if (ex.user.includes(REVIEW_MARKER)) continue; // our own review request
		if (/^\/adr(\s|$)/.test(ex.user.trim())) continue; // our own command; /adr note writes its note
		const trigger = scoreExchange(ex);
		const base: ExchangeResult = {
			anchor: ex.anchor,
			ts: ex.ts,
			user: ex.user,
			signals: trigger.signals,
			outcome: "no-trigger",
		};
		if (!trigger.fired) {
			results.push(base);
			continue;
		}
		const baseId = noteId(session.harness, session.id, ex.anchor);
		if ([...ids].some((i) => i === baseId || i.startsWith(`${baseId}#`))) {
			results.push({ ...base, outcome: "exists" });
			continue;
		}
		let found: Classification[];
		try {
			found = await ctx.classifier.classify(
				{ exchange: ex, signals: trigger.signals, adrs, backlog: [...known] },
				ctx.signal,
			);
		} catch (e) {
			results.push({ ...base, outcome: "error", error: (e as Error).message });
			continue;
		}
		// Classifiers outside detect.ts may not filter; never write a discard.
		found = found.filter((c) => c.is_decision && c.summary && c.proposed_target !== "discard");
		if (!found.length) {
			results.push({ ...base, outcome: "not-decision" });
			continue;
		}
		const folder = pickFolder(layout, touchedPaths(ex, session.cwd, layout.root));
		const date = ex.ts ? new Date(ex.ts) : now();
		for (const [i, c] of found.entries()) {
			const id = i === 0 ? baseId : `${baseId}#${i + 1}`;
			const info = { summary: c.summary, target: c.proposed_target, confidence: c.confidence };
			if (c.duplicate_of) {
				results.push({ ...base, ...info, outcome: "duplicate", duplicateOf: c.duplicate_of });
				continue;
			}
			const note: Note = {
				id,
				captured: date.toISOString().replace(/\.\d{3}Z$/, "Z"),
				harness: session.harness,
				session: session.id,
				session_file: tildify(session.file, ctx.home),
				anchor: ex.anchor,
				adr_dir: folder.dir,
				proposed_target: c.proposed_target,
				confidence: c.confidence,
				decided_by: c.decided_by,
				signals: trigger.signals,
				related: [],
				status: "open",
				decision: c.summary,
				why: c.why || "Matched decision wording in the session.",
				alternatives: c.alternatives,
				quote: c.quote ? makeQuote(c.quote) : makeQuote(ex.user),
			};
			const w = writeNote(layout.root, folder.backlog, note, {
				date,
				dryRun: ctx.dryRun,
				existingIds: ids,
			});
			if (!w) {
				results.push({ ...base, ...info, outcome: "exists" });
				continue;
			}
			ids.add(id);
			known.push({ id, title: c.summary });
			results.push({
				...base,
				...info,
				outcome: w.written ? "written" : "would-write",
				file: w.file,
			});
		}
	}
	return results;
}

/** One line per written note, for chat replies. */
export function summarizeResults(results: ExchangeResult[]): string {
	const written = results.filter((r) => r.outcome === "written");
	if (!written.length) return "ADR recorder: no new decisions found";
	return `ADR recorder: ${written.length} note(s)\n${written.map((r) => `- ${r.file}`).join("\n")}`;
}
