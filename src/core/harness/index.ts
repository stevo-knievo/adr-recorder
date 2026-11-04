import { claudeCodeHarness } from "./claude-code.ts";
import { codexHarness } from "./codex.ts";
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

const registry = new Map<string, HarnessAdapter>(
	[piHarness, claudeCodeHarness, codexHarness].map((h) => [h.name, h]),
);

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
