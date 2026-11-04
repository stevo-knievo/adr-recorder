import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Small JSON files under the state dir. Missing or broken files read as `fallback`. */
export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** Write through a temp file, so a reader never sees half a file. */
export function writeJson(file: string, data: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	renameSync(tmp, file);
}

/** File-safe form of a session key such as "claude-code:1234-abcd". */
export function stateKey(...parts: string[]): string {
	return parts.join("-").replace(/[^\w.-]/g, "_");
}

/**
 * Exchanges a session has already classified, for adapters that run in a
 * fresh process per turn (hooks). pi keeps this in memory instead.
 */
export function processedFile(stateDir: string, harness: string, sessionId: string): string {
	return join(stateDir, "processed", `${stateKey(harness, sessionId)}.json`);
}

export function readProcessed(file: string): Set<string> {
	return new Set(readJson<string[]>(file, []));
}

export function writeProcessed(file: string, anchors: Set<string>): void {
	writeJson(file, [...anchors]);
}

const overridesFile = (stateDir: string, harness: string) =>
	join(stateDir, harness, "overrides.json");

/**
 * /adr on (true) or /adr off (false) for one session, for adapters whose
 * host can't store it in the session (pi can, and does).
 */
export function readOverride(
	stateDir: string,
	harness: string,
	sessionId: string,
): boolean | undefined {
	return readJson<Record<string, boolean>>(overridesFile(stateDir, harness), {})[sessionId];
}

export function writeOverride(
	stateDir: string,
	harness: string,
	sessionId: string,
	on: boolean,
): void {
	const file = overridesFile(stateDir, harness);
	const all = readJson<Record<string, boolean>>(file, {});
	all[sessionId] = on;
	writeJson(file, all);
}

const LOCK_STALE_MS = 10 * 60_000;
const lockBase = (stateDir: string, harness: string, sessionId: string) =>
	join(stateDir, harness, "locks", stateKey(sessionId));

/**
 * One capture worker per session at a time: a hook fires every turn, and a
 * slow classifier call can outlast a turn. Returns a release function, or
 * undefined when another worker holds the lock.
 */
export function lockSession(
	stateDir: string,
	harness: string,
	sessionId: string,
): (() => void) | undefined {
	const file = `${lockBase(stateDir, harness, sessionId)}.lock`;
	mkdirSync(dirname(file), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(file, "wx");
			writeFileSync(fd, String(process.pid));
			closeSync(fd);
			return () => rmSync(file, { force: true });
		} catch {
			try {
				if (Date.now() - statSync(file).mtimeMs < LOCK_STALE_MS) return undefined;
				rmSync(file, { force: true });
			} catch {
				// gone already: try again
			}
		}
	}
	return undefined;
}

/** Where a worker leaves its job when another worker holds the lock. */
export function rerunFile(stateDir: string, harness: string, sessionId: string): string {
	return `${lockBase(stateDir, harness, sessionId)}.rerun.json`;
}
