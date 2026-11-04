import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Document, parseDocument } from "yaml";
import {
	type Config,
	decideEnablement,
	loadConfig,
	missingSettings,
	REPO_CONFIG_FILE,
	stateDir as stateDirFor,
	userConfigPath,
} from "../core/config.ts";
import type { Classifier } from "../core/detect.ts";
import { piSessionFromBranch } from "../core/harness/pi.ts";
import { nodeSystem } from "../core/launch/system.ts";
import { findGitRoot, hasAdrFolder, type Layout, resolveLayout } from "../core/layout.ts";
import { type Note, noteId, readBacklog, writeNote } from "../core/notes.ts";
import {
	listReviewReports,
	openNotes,
	prepareReview,
	REVIEW_CHILD_ENV,
	REVIEW_MARKER,
} from "../core/review.ts";
import { startReview } from "../core/review-start.ts";
import { type ExchangeResult, scanSession, tildify } from "../core/scan.ts";
import { statusText } from "../core/status.ts";
import { toExchanges } from "../core/transcript.ts";
import type { Session } from "../core/types.ts";
import { createPiClassifier } from "./classifier.ts";

const KEY = "adr-recorder";
const SHUTDOWN_WAIT_MS = 10_000;

interface State {
	root: string;
	config: Config;
	configErrors: string[];
	layout: Layout;
	sessionId: string;
	/** /adr on (true), /adr off (false), or unset. Stored in the session. */
	override?: boolean;
	reviewChild: boolean;
	/** Exchanges already looked at, so a settled run only classifies new ones. */
	processed: Set<string>;
	pending: Set<Promise<unknown>>;
	reviewRequested: boolean;
	warned: Set<string>;
	classifier?: Classifier;
}

const home = homedir();

const configEnv = () => ({ home, env: process.env });
const stateDir = () => stateDirFor(configEnv());

function branchSession(ctx: ExtensionContext): Session {
	const sm = ctx.sessionManager;
	const header = sm.getHeader() ?? undefined;
	return piSessionFromBranch(
		header ? { id: header.id, cwd: header.cwd, timestamp: header.timestamp } : undefined,
		sm.getBranch(),
		sessionFilePath(ctx) ?? `ephemeral:${sm.getSessionId()}`,
	);
}

function sessionFilePath(ctx: ExtensionContext): string | undefined {
	const f = ctx.sessionManager.getSessionFile();
	return f ? resolve(f) : undefined;
}

function readOverride(ctx: ExtensionContext): boolean | undefined {
	let v: boolean | undefined;
	for (const e of ctx.sessionManager.getBranch() as {
		type?: string;
		customType?: string;
		data?: unknown;
	}[]) {
		if (e.type === "custom" && e.customType === KEY) {
			const d = e.data as { enabled?: unknown } | undefined;
			if (typeof d?.enabled === "boolean") v = d.enabled;
		}
	}
	return v;
}

function load(ctx: ExtensionContext): State {
	const root = findGitRoot(ctx.cwd) ?? ctx.cwd;
	const loaded = loadConfig({ home, env: process.env }, root);
	const session = branchSession(ctx);
	const exchanges = toExchanges(session.turns);
	return {
		root,
		config: loaded.config,
		configErrors: loaded.errors,
		layout: resolveLayout(root, loaded.config.repo),
		sessionId: session.id,
		override: readOverride(ctx),
		reviewChild:
			process.env[REVIEW_CHILD_ENV] === "1" || Boolean(exchanges[0]?.user.includes(REVIEW_MARKER)),
		processed: new Set(exchanges.map((e) => e.anchor)),
		pending: new Set(),
		reviewRequested: false,
		warned: new Set(),
	};
}

function enablement(st: State) {
	return decideEnablement({
		cwd: st.root,
		config: st.config,
		hasAdrFolder: hasAdrFolder(st.layout),
		sessionOverride: st.override,
		reviewChild: st.reviewChild,
	});
}

function sessionNotes(st: State) {
	const prefix = `pi:${st.sessionId}:`;
	return st.layout.folders
		.flatMap((f) => readBacklog(st.root, f.backlog))
		.filter((n) => n.id.startsWith(prefix));
}

function warnOnce(st: State, ctx: ExtensionContext, key: string, msg: string) {
	if (st.warned.has(key) || !ctx.hasUI) return;
	st.warned.add(key);
	ctx.ui.notify(msg, "warning");
}

function getClassifier(st: State, ctx: ExtensionContext): Classifier | undefined {
	if (st.classifier) return st.classifier;
	const missing = missingSettings(st.config, { needEndpoint: false });
	if (missing.length || !st.config.classifier_model) {
		warnOnce(
			st,
			ctx,
			"config",
			`ADR recorder: set ${missing.join(", ")} in ${userConfigPath({ home, env: process.env })}`,
		);
		return undefined;
	}
	try {
		st.classifier = createPiClassifier(ctx, st.config.classifier_model);
	} catch (e) {
		warnOnce(st, ctx, "model", `ADR recorder: ${(e as Error).message}`);
	}
	return st.classifier;
}

function refreshStatus(st: State | undefined, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	if (!st) return ctx.ui.setStatus(KEY, undefined);
	const on = enablement(st).enabled;
	ctx.ui.setStatus(KEY, statusText(on, on ? sessionNotes(st).length : 0));
}

function track<T>(st: State, p: Promise<T>): Promise<T> {
	st.pending.add(p);
	p.finally(() => st.pending.delete(p)).catch(() => {});
	return p;
}

async function capture(
	st: State,
	ctx: ExtensionContext,
	opts: { all: boolean },
): Promise<ExchangeResult[]> {
	const classifier = getClassifier(st, ctx);
	if (!classifier) return [];
	const session = branchSession(ctx);
	const seen = new Set(st.processed);
	for (const ex of toExchanges(session.turns)) st.processed.add(ex.anchor);
	const results = await scanSession(session, {
		layout: st.layout,
		classifier,
		filter: opts.all ? undefined : (ex) => !seen.has(ex.anchor),
		home,
	});
	const failed = results.find((r) => r.outcome === "error");
	if (failed) warnOnce(st, ctx, "classify", `ADR recorder: classifier failed: ${failed.error}`);
	return results;
}

function writeRepoAdrDir(root: string, dir: string) {
	const file = join(root, REPO_CONFIG_FILE);
	const doc = existsSync(file) ? parseDocument(readFileSync(file, "utf8")) : undefined;
	if (doc?.contents) {
		doc.set("adr_dir", dir);
		writeFileSync(file, doc.toString());
	} else writeFileSync(file, new Document({ adr_dir: dir }).toString());
}

function seenFile() {
	return join(stateDir(), "seen-reviews.json");
}

function launchedFile() {
	return join(stateDir(), "launched-reviews.json");
}

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(file: string, data: unknown) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function notifyReviews(st: State, ctx: ExtensionContext) {
	if (!ctx.hasUI || st.reviewChild) return;
	const reports = listReviewReports(st.layout);
	if (!reports.length) return;
	const seen = readJson<Record<string, true>>(seenFile(), {});
	const fresh = reports.filter((r) => !seen[join(st.root, r.file)]);
	if (!fresh.length) return;
	const latest = fresh[0];
	if (latest)
		ctx.ui.notify(`ADR review ready: ${latest.proposals} proposals (${latest.file})`, "info");
	for (const r of fresh) seen[join(st.root, r.file)] = true;
	writeJson(seenFile(), seen);
}

function statusReport(st: State): string {
	const en = enablement(st);
	const notes = sessionNotes(st);
	const open = openNotes(st.layout).length;
	const missing = missingSettings(st.config, { needEndpoint: false });
	return [
		`ADR recorder: ${en.enabled ? "on" : "off"} (${en.reason})`,
		`adr_dir: ${st.layout.adrDir} (${st.layout.source}), backlog ${st.layout.backlogDir}`,
		`notes this session: ${notes.length}, open in repo: ${open}`,
		`models: classifier=${st.config.classifier_model ?? "-"} reviewer=${st.config.reviewer_model ?? "-"}`,
		`auto_review: ${st.config.auto_review}`,
		...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
		...st.configErrors.map((e) => `config error: ${e}`),
	].join("\n");
}

function summarize(results: ExchangeResult[]): string {
	const written = results.filter((r) => r.outcome === "written");
	if (!written.length) return "ADR recorder: no new decisions found";
	return `ADR recorder: ${written.length} note(s)\n${written.map((r) => `- ${r.file}`).join("\n")}`;
}

const SUBCOMMANDS = ["on", "off", "status", "note", "scan", "review"];

export default function adrRecorder(pi: ExtensionAPI) {
	let st: State | undefined;

	pi.on("session_start", async (_event, ctx) => {
		st = load(ctx);
		refreshStatus(st, ctx);
		notifyReviews(st, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!st) return;
		if (
			event.messageType === "user" &&
			event.prompt?.includes(REVIEW_MARKER) &&
			!st.reviewRequested
		) {
			// Started with a review task: this pi is the review agent.
			st.reviewChild = true;
			refreshStatus(st, ctx);
		}
		st.reviewRequested = false;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const s = st;
		if (!s || !enablement(s).enabled) return;
		await track(s, capture(s, ctx, { all: false }));
		refreshStatus(s, ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const s = st;
		if (!s) return;
		if (s.pending.size) {
			await Promise.race([
				Promise.allSettled([...s.pending]),
				new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS)),
			]);
		}
		if (event.reason !== "quit" || s.reviewChild || !enablement(s).enabled) return;
		if (s.config.auto_review === "off") return;
		const open = sessionNotes(s).filter((n) => n.status === "open");
		const reviewed = readJson<Record<string, string[]>>(launchedFile(), {});
		const done = new Set(reviewed[s.sessionId] ?? []);
		// Quit, resume, quit again: don't review the same notes twice.
		if (!open.some((n) => !done.has(n.id))) return;
		if (s.config.auto_review === "ask") {
			if (!ctx.hasUI) return;
			const ok = await ctx.ui.confirm("ADR review", "Start a review of the ADR backlog?", {
				timeout: 15_000,
			});
			if (!ok) return;
		}
		try {
			const started = await startReview({
				layout: s.layout,
				config: s.config,
				harness: "pi",
				sys: nodeSystem(),
				home,
				stateDir: stateDir(),
			});
			if (started) {
				reviewed[s.sessionId] = [...done, ...open.map((n) => n.id)];
				writeJson(launchedFile(), reviewed);
			}
		} catch (e) {
			if (ctx.hasUI) ctx.ui.notify(`ADR review not started: ${(e as Error).message}`, "warning");
		}
	});

	pi.registerCommand("adr", {
		description: "ADR recorder: on | off | status | note <text> | scan | review",
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((c) => c.startsWith(prefix.trim())).map((c) => ({ value: c, label: c })),
		handler: async (args, ctx) => {
			if (!st) st = load(ctx);
			const s = st;
			const [sub = "status", ...restParts] = args.trim().split(/\s+/);
			const rest = args.trim().slice(sub.length).trim() || restParts.join(" ");
			const say = (msg: string, type: "info" | "warning" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, type);
				else process.stdout.write(`${msg}\n`);
			};
			switch (sub) {
				case "status":
					say(statusReport(s));
					return;
				case "on": {
					if (!hasAdrFolder(s.layout) && !s.config.repo.adr_dir) {
						let dir = "docs/adr";
						if (ctx.hasUI) {
							const answer = await ctx.ui.input("Where should ADRs live?", "docs/adr");
							if (answer === undefined) return;
							dir = answer.trim() || "docs/adr";
						}
						writeRepoAdrDir(s.root, dir);
						const loaded = loadConfig({ home, env: process.env }, s.root);
						s.config = loaded.config;
						s.layout = resolveLayout(s.root, s.config.repo);
						say(`ADR folder set to ${dir} in ${REPO_CONFIG_FILE}`);
					}
					s.override = true;
					pi.appendEntry(KEY, { enabled: true });
					refreshStatus(s, ctx);
					if (s.reviewChild) say("This is a review session; the recorder stays off.", "warning");
					return;
				}
				case "off":
					s.override = false;
					pi.appendEntry(KEY, { enabled: false });
					refreshStatus(s, ctx);
					return;
				case "note": {
					if (!rest) return say("Usage: /adr note <decision>", "warning");
					const anchor = ctx.sessionManager.getLeafId() ?? "manual";
					const now = new Date();
					const note: Note = {
						id: noteId("pi", s.sessionId, `manual-${now.getTime().toString(36)}`),
						captured: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
						harness: "pi",
						session: s.sessionId,
						session_file: tildify(sessionFilePath(ctx) ?? "", home),
						anchor,
						adr_dir: s.layout.adrDir,
						proposed_target: "adr",
						confidence: "high",
						decided_by: "human",
						signals: ["manual"],
						related: [],
						status: "open",
						decision: rest,
						why: "Recorded by hand.",
						alternatives: [],
						quote: rest,
					};
					const w = writeNote(s.root, s.layout.backlogDir, note, { date: now });
					refreshStatus(s, ctx);
					say(w ? `ADR note: ${w.file}` : "ADR note already exists");
					return;
				}
				case "scan": {
					const results = await track(s, capture(s, ctx, { all: true }));
					refreshStatus(s, ctx);
					say(summarize(results));
					return;
				}
				case "review": {
					if (!s.config.reviewer_model) {
						return say(
							`ADR recorder: set reviewer_model in ${userConfigPath({ home, env: process.env })}`,
							"warning",
						);
					}
					const { notes, prompt } = prepareReview(s.layout, {
						headless: false,
						now: new Date(),
						home,
					});
					if (!notes.length) return say("ADR backlog has no open notes");
					s.reviewRequested = true;
					const ask = [
						`Start a sub-agent with your sub-agent tool to review the ADR backlog. Name it "adr-review", use model ${s.config.reviewer_model}, set working directory ${s.root}, and keep it open so the human can answer its questions. Pass the task below unchanged.`,
						"If you have no sub-agent tool, do the review yourself.",
						"",
						"Task:",
						prompt,
					].join("\n");
					pi.sendUserMessage(ask, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
					return;
				}
				default:
					say(`Unknown: /adr ${sub}. Use ${SUBCOMMANDS.join(" | ")}`, "warning");
			}
		},
	});
}
