import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
