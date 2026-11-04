import { existsSync, renameSync, rmSync } from "node:fs";
import { reviewOnExit } from "./auto-review.ts";
import { classifierFromConfig } from "./classifier-openai.ts";
import { userConfigPath } from "./config.ts";
import type { Classifier } from "./detect.ts";
import { getHarness } from "./harness/index.ts";
import type { System } from "./launch/index.ts";
import { loadProject, type Project, projectEnablement } from "./project.ts";
import { REVIEW_CHILD_ENV, REVIEW_MARKER } from "./review.ts";
import { type ExchangeResult, scanSession } from "./scan.ts";
import {
	lockSession,
	processedFile,
	readJson,
	readOverride,
	readProcessed,
	rerunFile,
	writeJson,
	writeProcessed,
} from "./state.ts";
import { toExchanges } from "./transcript.ts";
import type { Session } from "./types.ts";

/**
 * Live capture for agents whose hooks run a fresh process per event (Claude
 * Code, and others like it). The hook starts a detached worker that calls
 * captureSession. pi keeps its state in memory and doesn't need this.
 */
export interface CaptureDeps {
	env: Record<string, string | undefined>;
	home: string;
	stateDir: string;
	sys: System;
	err: (s: string) => void;
	now?: () => Date;
	sleep?: (ms: number) => Promise<void>;
	/** Tests inject a fake classifier; otherwise model_endpoint is used. */
	classifier?: Classifier;
}

export interface CaptureJob {
	/** Registered harness with a SessionSource. */
	harness: string;
	transcript: string;
	sessionId: string;
	cwd: string;
	/** Classify every exchange, not only new ones (/adr scan). */
	all?: boolean;
	/** The session is ending: capture, then maybe review. */
	final?: boolean;
	/** With final: the human quit (not /clear or resume), so start the auto review. */
	quit?: boolean;
	/** Stop's last_assistant_message: wait until the transcript has it. */
	expect?: string;
}

export type CaptureOutcome =
	| { skipped: string }
	| { queued: true }
	| { results: ExchangeResult[]; review?: string };

const WAIT_MS = 5_000;
const POLL_MS = 250;

const lastAssistant = (s: Session) => s.turns.filter((t) => t.role === "assistant").at(-1)?.text;

/** Read the transcript; with `expect`, wait a little for the last reply to land. */
async function loadSession(
	job: CaptureJob,
	d: CaptureDeps,
): Promise<{ session: Session; complete: boolean }> {
	const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const want = job.expect?.trim().slice(-200);
	for (let waited = 0; ; waited += POLL_MS) {
		const session = source(job.harness).loadSession(job.transcript);
		if (!want || lastAssistant(session)?.trim().endsWith(want)) return { session, complete: true };
		if (waited >= WAIT_MS) return { session, complete: false };
		await sleep(POLL_MS);
	}
}

function source(harness: string) {
	const s = getHarness(harness)?.sessions;
	if (!s) throw new Error(`Harness ${harness} has no session source`);
	return s;
}

export function isReviewChild(
	d: { env: Record<string, string | undefined> },
	session: Session,
): boolean {
	return (
		d.env[REVIEW_CHILD_ENV] === "1" ||
		Boolean(session.turns.find((t) => t.role === "user")?.text.includes(REVIEW_MARKER))
	);
}

/**
 * Classify the new exchanges of one session and write notes.
 * Runs in a detached worker started by a hook, so it may take its time.
 */
export async function captureSession(job: CaptureJob, d: CaptureDeps): Promise<CaptureOutcome> {
	if (!existsSync(job.transcript)) return { skipped: "no transcript" };
	const rerun = rerunFile(d.stateDir, job.harness, job.sessionId);
	const all: ExchangeResult[] = [];
	let last: CaptureOutcome = { skipped: "nothing to do" };
	let next: CaptureJob | undefined = job;
	while (next) {
		const release = lockSession(d.stateDir, job.harness, job.sessionId);
		if (!release) {
			// Another worker runs for this session: leave the job for it.
			const queued = readJson<CaptureJob | undefined>(rerun, undefined);
			writeJson(rerun, {
				...next,
				final: next.final || queued?.final,
				quit: next.quit || queued?.quit,
			});
			return all.length ? { results: all } : { queued: true };
		}
		try {
			while (next) {
				last = await captureOnce(next, d);
				if ("results" in last) all.push(...last.results);
				next = takeJob(rerun);
			}
		} finally {
			release();
		}
		// A job queued between the last check and the release.
		next = takeJob(rerun);
	}
	// Report every pass, not only the last one.
	return "results" in last ? { ...last, results: all } : all.length ? { results: all } : last;
}

/** Take the queued job, if any. The rename makes the take atomic. */
function takeJob(file: string): CaptureJob | undefined {
	const taken = `${file}.${process.pid}.taken`;
	try {
		renameSync(file, taken);
	} catch {
		return undefined;
	}
	const job = readJson<CaptureJob | undefined>(taken, undefined);
	rmSync(taken, { force: true });
	return job;
}

async function captureOnce(job: CaptureJob, d: CaptureDeps): Promise<CaptureOutcome> {
	const cenv = { home: d.home, env: d.env };
	const project = loadProject(job.cwd, cenv);
	const { session, complete } = await loadSession(job, d);
	const reviewChild = isReviewChild(d, session);
	const en = projectEnablement(project, {
		override: readOverride(d.stateDir, job.harness, job.sessionId),
		reviewChild,
	});
	if (!en.enabled) return { skipped: en.reason };

	const file = processedFile(d.stateDir, job.harness, job.sessionId);
	const processed = readProcessed(file);
	// A reply that hasn't reached the transcript yet waits for the next pass.
	const exchanges = toExchanges(session.turns);
	const ready = new Set((complete ? exchanges : exchanges.slice(0, -1)).map((e) => e.anchor));
	const classifier =
		d.classifier ?? classifierFromConfig(project.config, d.env, userConfigPath(cenv));
	const results = await scanSession(session, {
		layout: project.layout,
		classifier,
		filter: (ex) => ready.has(ex.anchor) && (job.all || !processed.has(ex.anchor)),
		home: d.home,
		now: d.now,
	});
	for (const r of results) {
		if (r.outcome === "error") d.err(`classify ${r.anchor}: ${r.error}\n`);
		else processed.add(r.anchor);
	}
	writeProcessed(file, processed);

	if (!job.final || !job.quit) return { results };
	return { results, review: await review(project, job, d) };
}

async function review(project: Project, job: CaptureJob, d: CaptureDeps): Promise<string> {
	try {
		const r = await reviewOnExit({
			project,
			harness: job.harness,
			sessionId: job.sessionId,
			sys: d.sys,
			home: d.home,
			stateDir: d.stateDir,
			// Nobody to ask once the agent has exited; "ask" waits for /adr review.
		});
		if ("skipped" in r) return `review skipped: ${r.skipped}`;
		const s = r.started;
		return `review started: ${s.notes} note(s), ${s.launcher} (${s.where})${s.fallbackReason ? `, ${s.fallbackReason}` : ""}`;
	} catch (e) {
		return `review not started: ${(e as Error).message}`;
	}
}
