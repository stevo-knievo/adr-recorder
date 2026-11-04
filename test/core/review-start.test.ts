import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/core/config.ts";
import { registerHarness } from "../../src/core/harness/index.ts";
import { resolveLayout } from "../../src/core/layout.ts";
import { startReview } from "../../src/core/review-start.ts";
import { scanSession } from "../../src/core/scan.ts";
import { decision, fakeClassifier, fakeSystem, loadSessionFixture, tempRepo } from "../helpers.ts";

const config = (over: Partial<Config> = {}): Config => ({
	reviewer_model: "p/strong",
	enabled_paths: [],
	disabled_paths: [],
	auto_review: "on",
	review_launcher: "auto",
	repo: {},
	...over,
});

async function setup() {
	const root = tempRepo("docs-adr");
	const layout = resolveLayout(root);
	const { classifier } = fakeClassifier({}, decision());
	await scanSession(loadSessionFixture("todo-api"), { layout, classifier, home: "/h" });
	return { root, layout, stateDir: join(tempRepo(), "state") };
}

describe("startReview", () => {
	it("hands the pi reviewer to the detected launcher", async () => {
		const { layout, stateDir } = await setup();
		const { sys, runs } = fakeSystem({ REX_SESSION: "s" });
		const r = await startReview({
			layout,
			config: config(),
			sys,
			home: "/h",
			stateDir,
			now: new Date(2026, 10, 3, 12, 0),
		});
		expect(r).toMatchObject({
			launcher: "rex",
			where: "new Rex block",
			reportPath: "docs/adr/_backlog/_review-2026-11-03_1200.md",
		});
		expect(r?.notes).toBeGreaterThan(0);
		const cmd = runs[0]?.at(-1) ?? "";
		expect(cmd).toMatch(/ADR_REVIEW_CHILD=1 pi --model 'p\/strong'/);
		const prompts = readdirSync(stateDir).filter((f) => f.endsWith(".prompt.md"));
		expect(prompts).toHaveLength(2);
		const interactive = readFileSync(
			join(stateDir, prompts.find((f) => !f.includes("headless")) ?? ""),
			"utf8",
		);
		expect(interactive).toContain("ask before changing any file outside the backlog");
	});

	it("falls back to headless when the host refuses", async () => {
		const { layout, stateDir } = await setup();
		const { sys, detached } = fakeSystem(
			{ REX_SESSION: "s" },
			{ rex: { code: 2, stderr: "no rex" } },
		);
		const r = await startReview({ layout, config: config(), sys, home: "/h", stateDir });
		expect(r?.launcher).toBe("headless");
		expect(r?.fallbackReason).toBe("rex run exited 2: no rex");
		expect(detached[0]?.argv[2]).toMatch(/pi -p --model/);
		expect(readFileSync(detached[0]?.argv[2]?.match(/cat '([^']+)'/)?.[1] ?? "", "utf8")).toContain(
			"Write the report and nothing else",
		);
	});

	it("dry run builds the job and touches nothing", async () => {
		const { layout, stateDir } = await setup();
		const { sys, runs, detached } = fakeSystem();
		const r = await startReview({
			layout,
			config: config(),
			sys,
			home: "/h",
			stateDir,
			launcher: "tmux",
			dryRun: true,
		});
		expect(r?.launcher).toBe("tmux");
		expect(runs).toEqual([]);
		expect(detached).toEqual([]);
		expect(existsSync(stateDir) && readdirSync(stateDir).some((f) => f.endsWith(".md"))).toBe(
			false,
		);
	});

	it("nothing open, nothing started", async () => {
		const { sys } = fakeSystem();
		const layout = resolveLayout(tempRepo("docs-adr"));
		expect(
			await startReview({ layout, config: config(), sys, home: "/h", stateDir: tempRepo() }),
		).toBeUndefined();
	});

	it("uses review_harness, and any registered reviewer", async () => {
		registerHarness({
			name: "other-agent",
			reviewer: {
				name: "other-agent",
				reviewerCommand: (r) => `other --model ${r.model} --prompt-file ${r.promptFile}`,
				headlessReviewerCommand: (r) => `other --batch ${r.promptFile}`,
			},
		});
		const { layout, stateDir } = await setup();
		const { sys } = fakeSystem();
		const r = await startReview({
			layout,
			config: config({ review_harness: "other-agent" }),
			sys,
			home: "/h",
			stateDir,
			dryRun: true,
		});
		expect(r?.job.command).toMatch(/^other --model p\/strong --prompt-file /);
		await expect(
			startReview({
				layout,
				config: config({ review_harness: "nope" }),
				sys,
				home: "/h",
				stateDir,
			}),
		).rejects.toThrow("No reviewer for harness nope");
	});

	it("starts the agent the way agent_commands says", async () => {
		const { layout, stateDir } = await setup();
		const { sys } = fakeSystem();
		const r = await startReview({
			layout,
			config: config({
				review_harness: "claude-code",
				agent_commands: { "claude-code": "wrap claude" },
			}),
			sys,
			home: "/h",
			stateDir,
			dryRun: true,
		});
		expect(r?.job.command).toContain("ADR_REVIEW_CHILD=1 wrap claude --model 'strong'");
		expect(r?.job.headlessCommand).toContain("wrap claude -p --model");
	});

	it("uses the agent's own model from agent_models", async () => {
		const { layout, stateDir } = await setup();
		const { sys } = fakeSystem();
		const r = await startReview({
			layout,
			config: config({ review_harness: "codex", agent_models: { codex: "openai/gpt-5" } }),
			sys,
			home: "/h",
			stateDir,
			dryRun: true,
		});
		expect(r?.job.command).toContain("ADR_REVIEW_CHILD=1 codex --model 'gpt-5' -- ");
	});

	it("needs reviewer_model", async () => {
		const { layout, stateDir } = await setup();
		const { sys } = fakeSystem();
		await expect(
			startReview({
				layout,
				config: config({ reviewer_model: undefined }),
				sys,
				home: "/h",
				stateDir,
			}),
		).rejects.toThrow("reviewer_model is not set");
	});
});
