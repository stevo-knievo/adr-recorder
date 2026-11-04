import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Classification, Classifier, ClassifierInput } from "../src/core/detect.ts";
import { parsePiSession } from "../src/core/transcript.ts";
import type { Session } from "../src/core/types.ts";

export const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
export const repoFixture = (name: string) => join(FIXTURES, "repos", name);
export const sessionFixturePath = (name: string) => join(FIXTURES, "sessions", `pi-${name}.jsonl`);

export function loadSessionFixture(name: string): Session {
	const file = sessionFixturePath(name);
	return parsePiSession(readFileSync(file, "utf8"), file);
}

/** Copy a fixture repo to a temp dir so tests can write into it. */
export function tempRepo(name?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "adr-rec-"));
	if (name) cpSync(repoFixture(name), dir, { recursive: true });
	return dir;
}

export function decision(over: Partial<Classification> = {}): Classification {
	return {
		is_decision: true,
		summary: "Use Fastify instead of Express.",
		proposed_target: "adr",
		confidence: "high",
		alternatives: ["Express"],
		duplicate_of: null,
		decided_by: "human",
		why: "Framework choice is expensive to reverse.",
		...over,
	};
}

/** Fake classifier: answers by anchor, records every call. */
type Answer = Classification | Classification[] | Error;

export function fakeClassifier(answers: Record<string, Answer>, fallback?: Answer) {
	const calls: ClassifierInput[] = [];
	const classifier: Classifier = {
		async classify(input) {
			calls.push(input);
			const a = answers[input.exchange.anchor] ?? fallback ?? [];
			if (a instanceof Error) throw a;
			return Array.isArray(a) ? a : a.is_decision ? [a] : [];
		},
	};
	return { classifier, calls };
}
