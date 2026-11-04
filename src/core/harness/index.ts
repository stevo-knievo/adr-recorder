import { piHarness } from "./pi.ts";
import type { HarnessAdapter } from "./types.ts";

export type {
	Env,
	FoundSession,
	HarnessAdapter,
	ReviewerAgent,
	ReviewerRun,
	SessionSource,
} from "./types.ts";

const registry = new Map<string, HarnessAdapter>([[piHarness.name, piHarness]]);

/** Named in the spec, adapters not written yet. */
export const PLANNED_HARNESSES = ["claude-code", "codex"];

/** Add a harness at runtime, e.g. from a plugin or a test. */
export function registerHarness(h: HarnessAdapter): void {
	registry.set(h.name, h);
}

export function getHarness(name: string): HarnessAdapter | undefined {
	return registry.get(name);
}

export function listHarnesses(): HarnessAdapter[] {
	return [...registry.values()];
}
