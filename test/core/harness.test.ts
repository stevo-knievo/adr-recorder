import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getHarness,
	type HarnessAdapter,
	listHarnesses,
	registerHarness,
} from "../../src/core/harness/index.ts";
import { piReviewer } from "../../src/core/harness/pi.ts";
import { tempRepo } from "../helpers.ts";

describe("harness registry", () => {
	it("ships pi with both sides", () => {
		const pi = getHarness("pi");
		expect(pi?.sessions?.name).toBe("pi");
		expect(pi?.reviewer?.name).toBe("pi");
		expect(getHarness("nope")).toBeUndefined();
	});

	it("takes a harness that only implements one side", () => {
		const scanOnly: HarnessAdapter = {
			name: "scan-only",
			sessions: {
				name: "scan-only",
				sessionsDir: () => "/x",
				findSessions: () => [],
				loadSession: (file) => ({
					harness: "scan-only",
					id: file,
					file,
					cwd: "",
					started: "",
					turns: [],
				}),
			},
		};
		registerHarness(scanOnly);
		expect(listHarnesses().map((h) => h.name)).toContain("scan-only");
		expect(getHarness("scan-only")?.reviewer).toBeUndefined();
	});
});

describe("pi reviewer commands", () => {
	const run = { cwd: "/repo it's", model: "p/m", promptFile: "/s/p.md" };

	it("set the recursion guard and read the prompt from the file", () => {
		expect(piReviewer.reviewerCommand(run)).toBe(
			`cd '/repo it'\\''s' && ADR_REVIEW_CHILD=1 pi --model 'p/m' "$(cat '/s/p.md')"`,
		);
		expect(piReviewer.headlessReviewerCommand(run)).toContain(
			"ADR_REVIEW_CHILD=1 pi -p --model 'p/m'",
		);
	});

	it("pass the prompt as one argument through a real shell", () => {
		const dir = tempRepo("none");
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "pi"),
			`#!/bin/sh\n{ echo "child=$ADR_REVIEW_CHILD"; for a in "$@"; do echo "[$a]"; done; } > "${dir}/out"\n`,
			{ mode: 0o755 },
		);
		const promptFile = join(dir, "p.md");
		writeFileSync(promptFile, `Say "hi" and it's $HOME \`x\``);
		const cmd = piReviewer.headlessReviewerCommand({ cwd: dir, model: "p/m", promptFile });
		execFileSync("sh", ["-c", cmd], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		});
		expect(readFileSync(join(dir, "out"), "utf8")).toBe(
			'child=1\n[-p]\n[--model]\n[p/m]\n[Say "hi" and it\'s $HOME `x`]\n',
		);
	});
});
