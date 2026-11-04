import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { getHarness } from "./harness/index.ts";
import {
	headlessLauncher,
	type Launcher,
	type LaunchJob,
	pickLauncher,
	type System,
} from "./launch/index.ts";
import type { Layout } from "./layout.ts";
import { prepareReview } from "./review.ts";

export interface StartReviewInput {
	layout: Layout;
	config: Config;
	/**
	 * Harness the session ran in. The reviewer uses review_harness if set,
	 * else this, else the harness most open notes came from, else pi.
	 */
	harness?: string;
	sys: System;
	home: string;
	/** Prompt files and logs go here. */
	stateDir: string;
	now?: Date;
	/** Override review_launcher, e.g. from `adr-recorder review --launcher`. */
	launcher?: string;
	/** Build the job but don't open anything. */
	dryRun?: boolean;
}

export interface StartedReview {
	launcher: string;
	where: string;
	reportPath: string;
	notes: number;
	job: LaunchJob;
	/** Set when the chosen launcher failed and the headless run took over. */
	fallbackReason?: string;
}

/**
 * Open a reviewer for the open backlog notes: build both prompts, ask the
 * harness for the agent command, and hand it to a launcher. Falls back to a
 * headless run when the launcher fails. Undefined when nothing is open.
 */
export async function startReview(input: StartReviewInput): Promise<StartedReview | undefined> {
	const { layout, config, sys } = input;
	const model = config.reviewer_model;
	if (!model) throw new Error("reviewer_model is not set");
	const launcher: Launcher = pickLauncher(
		input.launcher ?? config.review_launcher,
		sys.env,
		config.review_command,
	);
	const now = input.now ?? new Date();
	const interactive = prepareReview(layout, { headless: false, now, home: input.home });
	if (!interactive.notes.length) return undefined;
	const agentName =
		config.review_harness ??
		input.harness ??
		mostCommon(interactive.notes.map((n) => n.harness)) ??
		"pi";
	const agent = getHarness(agentName)?.reviewer;
	if (!agent) throw new Error(`No reviewer for harness ${agentName}`);
	const bin = config.agent_commands?.[agentName];
	const headless = prepareReview(layout, { headless: true, now, home: input.home });

	const stamp = now.getTime().toString(36);
	mkdirSync(input.stateDir, { recursive: true });
	const promptFile = join(input.stateDir, `review-${stamp}.prompt.md`);
	const headlessPromptFile = join(input.stateDir, `review-${stamp}.headless.prompt.md`);
	const job: LaunchJob = {
		cwd: layout.root,
		title: "adr-review",
		command: agent.reviewerCommand({ cwd: layout.root, model, promptFile, bin }),
		headlessCommand: agent.headlessReviewerCommand({
			cwd: layout.root,
			model,
			promptFile: headlessPromptFile,
			bin,
		}),
		logFile: join(input.stateDir, `review-${stamp}.log`),
	};
	const base = { reportPath: headless.reportPath, notes: interactive.notes.length, job };
	if (input.dryRun) return { ...base, launcher: launcher.name, where: "(dry run)" };

	writeFileSync(promptFile, interactive.prompt);
	writeFileSync(headlessPromptFile, headless.prompt);
	try {
		const where = await launcher.launch(job, sys);
		return { ...base, launcher: launcher.name, where };
	} catch (e) {
		if (launcher === headlessLauncher) throw e;
		const where = await headlessLauncher.launch(job, sys);
		return {
			...base,
			launcher: headlessLauncher.name,
			where,
			fallbackReason: (e as Error).message,
		};
	}
}

function mostCommon(xs: string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const x of xs) if (x) counts.set(x, (counts.get(x) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
