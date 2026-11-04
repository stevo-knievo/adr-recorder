import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reviewOnExit, reviewReadyMessage, takeNewReviewReport } from "../core/auto-review.ts";
import {
	missingSettings,
	REPO_CONFIG_FILE,
	stateDir as stateDirFor,
	userConfigPath,
} from "../core/config.ts";
import type { Classifier } from "../core/detect.ts";
import { piSessionFromBranch } from "../core/harness/pi.ts";
import { nodeSystem } from "../core/launch/system.ts";
import { hasAdrFolder } from "../core/layout.ts";
import {
	loadProject,
	type Project,
	projectEnablement,
	sessionNotes,
	setRepoAdrDir,
	statusReport,
	writeManualNote,
} from "../core/project.ts";
import { prepareReview, REVIEW_CHILD_ENV, REVIEW_MARKER } from "../core/review.ts";
import { type ExchangeResult, scanSession, summarizeResults, tildify } from "../core/scan.ts";
import { statusText } from "../core/status.ts";
import { toExchanges } from "../core/transcript.ts";
import type { Session } from "../core/types.ts";
import { createPiClassifier } from "./classifier.ts";

const KEY = "adr-recorder";
const SHUTDOWN_WAIT_MS = 10_000;

interface State {
	project: Project;
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
	const session = branchSession(ctx);
	const exchanges = toExchanges(session.turns);
	return {
		project: loadProject(ctx.cwd, configEnv()),
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

const enablement = (st: State) =>
	projectEnablement(st.project, { override: st.override, reviewChild: st.reviewChild });
const notesOf = (st: State) => sessionNotes(st.project, "pi", st.sessionId);

function warnOnce(st: State, ctx: ExtensionContext, key: string, msg: string) {
	if (st.warned.has(key) || !ctx.hasUI) return;
	st.warned.add(key);
	ctx.ui.notify(msg, "warning");
}

function getClassifier(st: State, ctx: ExtensionContext): Classifier | undefined {
	if (st.classifier) return st.classifier;
	const { config } = st.project;
	const missing = missingSettings(config, { needEndpoint: false });
	if (missing.length || !config.classifier_model) {
		warnOnce(
			st,
			ctx,
			"config",
			`ADR recorder: set ${missing.join(", ")} in ${userConfigPath(configEnv())}`,
		);
		return undefined;
	}
	try {
		st.classifier = createPiClassifier(ctx, config.classifier_model);
	} catch (e) {
		warnOnce(st, ctx, "model", `ADR recorder: ${(e as Error).message}`);
	}
	return st.classifier;
}

function refreshStatus(st: State | undefined, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	if (!st) return ctx.ui.setStatus(KEY, undefined);
	const on = enablement(st).enabled;
	ctx.ui.setStatus(KEY, statusText(on, on ? notesOf(st).length : 0));
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
		layout: st.project.layout,
		classifier,
		filter: opts.all ? undefined : (ex) => !seen.has(ex.anchor),
		home,
	});
	const failed = results.find((r) => r.outcome === "error");
	if (failed) warnOnce(st, ctx, "classify", `ADR recorder: classifier failed: ${failed.error}`);
	return results;
}

function notifyReviews(st: State, ctx: ExtensionContext) {
	if (!ctx.hasUI || st.reviewChild) return;
	const report = takeNewReviewReport(st.project, stateDir());
	if (report) ctx.ui.notify(reviewReadyMessage(report), "info");
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
		try {
			await reviewOnExit({
				project: s.project,
				harness: "pi",
				sessionId: s.sessionId,
				sys: nodeSystem(),
				home,
				stateDir: stateDir(),
				confirm: ctx.hasUI
					? () =>
							ctx.ui.confirm("ADR review", "Start a review of the ADR backlog?", {
								timeout: 15_000,
							})
					: undefined,
			});
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
					say(
						statusReport(
							s.project,
							enablement(s),
							{ harness: "pi", id: s.sessionId },
							{ needEndpoint: false },
						),
					);
					return;
				case "on": {
					if (!hasAdrFolder(s.project.layout) && !s.project.config.repo.adr_dir) {
						let dir = "docs/adr";
						if (ctx.hasUI) {
							const answer = await ctx.ui.input("Where should ADRs live?", "docs/adr");
							if (answer === undefined) return;
							dir = answer.trim() || "docs/adr";
						}
						setRepoAdrDir(s.project.root, dir);
						s.project = loadProject(s.project.root, configEnv());
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
					const file = writeManualNote(s.project, {
						harness: "pi",
						sessionId: s.sessionId,
						sessionFile: tildify(sessionFilePath(ctx) ?? "", home),
						anchor: ctx.sessionManager.getLeafId() ?? "manual",
						text: rest,
					});
					refreshStatus(s, ctx);
					say(file ? `ADR note: ${file}` : "ADR note already exists");
					return;
				}
				case "scan": {
					const results = await track(s, capture(s, ctx, { all: true }));
					refreshStatus(s, ctx);
					say(summarizeResults(results));
					return;
				}
				case "review": {
					const { config, root, layout } = s.project;
					if (!config.reviewer_model) {
						return say(
							`ADR recorder: set reviewer_model in ${userConfigPath(configEnv())}`,
							"warning",
						);
					}
					const { notes, prompt } = prepareReview(layout, {
						headless: false,
						now: new Date(),
						home,
					});
					if (!notes.length) return say("ADR backlog has no open notes");
					s.reviewRequested = true;
					const ask = [
						`Start a sub-agent with your sub-agent tool to review the ADR backlog. Name it "adr-review", use model ${config.reviewer_model}, set working directory ${root}, and keep it open so the human can answer its questions. Pass the task below unchanged.`,
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
