import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EXT = new URL("../../src/pi/index.ts", import.meta.url).pathname;
const skip = process.env.SKIP_PI_TESTS === "1";
const skipModel = skip || process.env.SKIP_MODEL_TESTS === "1";
const PI = skip ? "pi" : execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();

interface Sandbox {
	repo: string;
	bin: string;
	calls: string;
	run: (
		prompt: string,
		env?: Record<string, string>,
		args?: string[],
	) => { stdout: string; stderr: string };
	notes: () => string[];
	waitForCall: (name: string) => Promise<string | undefined>;
}

/**
 * Temp git repo with an ADR folder, a temp user config, and stub `pi` and
 * `rex` first on PATH. The real pi runs by absolute path; any review it
 * launches hits the stubs, which only log their arguments.
 */
function sandbox(config: string): Sandbox {
	const base = mkdtempSync(join(tmpdir(), "adr-smoke-"));
	const repo = join(base, "repo");
	const bin = join(base, "bin");
	const calls = join(base, "calls");
	mkdirSync(join(repo, "docs", "adr"), { recursive: true });
	mkdirSync(bin);
	mkdirSync(calls);
	writeFileSync(join(repo, "docs", "adr", "0001-record-decisions.md"), "# 1. Record decisions\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	writeFileSync(join(base, "config.yaml"), config);
	for (const name of ["pi", "rex"]) {
		const stub = join(bin, name);
		writeFileSync(
			stub,
			`#!/bin/sh\n{ echo "ADR_REVIEW_CHILD=$ADR_REVIEW_CHILD"; echo "PWD=$PWD"; for a in "$@"; do echo "ARG:$a"; done; } > "${calls}/${name}.txt"\n[ -n "$STUB_FAIL" ] && { echo "stub failed" >&2; exit 3; }\nexit 0\n`,
		);
		chmodSync(stub, 0o755);
	}
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		ADR_RECORDER_CONFIG: join(base, "config.yaml"),
		XDG_STATE_HOME: join(base, "state"),
	};
	// Tests run inside real hosts; hide them so `auto` sees a plain terminal.
	for (const k of [
		"ADR_REVIEW_CHILD",
		"REX_SESSION",
		"HERDR_ENV",
		"TMUX",
		"ZELLIJ",
		"WEZTERM_PANE",
		"KITTY_LISTEN_ON",
	]) {
		delete env[k];
	}
	return {
		repo,
		bin,
		calls,
		run(prompt, extra = {}, args = []) {
			const r = spawnSync(
				PI,
				["-p", "--no-tools", "--session-dir", join(base, "sessions"), "-e", EXT, ...args, prompt],
				{ cwd: repo, encoding: "utf8", env: { ...env, ...extra }, timeout: 120_000 },
			);
			// pi moves extension output to stderr in print mode; read both.
			return { stdout: `${r.stdout}${r.stderr}`, stderr: r.stderr };
		},
		notes() {
			const dir = join(repo, "docs", "adr", "_backlog");
			return existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith("_")) : [];
		},
		async waitForCall(name) {
			const f = join(calls, `${name}.txt`);
			for (let i = 0; i < 50; i++) {
				if (existsSync(f)) return readFileSync(f, "utf8");
				await new Promise((r) => setTimeout(r, 100));
			}
			return undefined;
		},
	};
}

const MODELS = "classifier_model: test/classifier\nreviewer_model: test/reviewer\n";

describe.skipIf(skip)("pi extension", () => {
	it("loads without errors", () => {
		const r = spawnSync(PI, ["-e", EXT, "--list-models", "nomatch-xyz"], { encoding: "utf8" });
		expect(r.error).toBeUndefined();
		expect(`${r.stdout}${r.stderr}`).not.toMatch(/Failed to load extension/);
	});

	it("the check catches a broken extension", () => {
		const r = spawnSync(
			PI,
			["-e", new URL("./fixtures/broken-ext.ts", import.meta.url).pathname, "--list-models", "x"],
			{ encoding: "utf8" },
		);
		expect(r.stderr).toMatch(/Failed to load extension/);
	});

	it("/adr status reports the layout", () => {
		const sb = sandbox(MODELS);
		const r = sb.run("/adr status");
		expect(r.stdout).toMatch(/ADR recorder: on \(repo has an ADR folder\)/);
		expect(r.stdout).toMatch(/adr_dir: docs\/adr/);
	});

	it("/adr note writes a note and quitting hands the review to headless pi", async () => {
		const sb = sandbox(MODELS);
		const r = sb.run("/adr note We use Postgres for storage");
		expect(r.stdout).toMatch(/ADR note: docs\/adr\/_backlog\/.*\.md/);
		expect(sb.notes()).toHaveLength(1);
		const call = await sb.waitForCall("pi");
		expect(call).toBeDefined();
		expect(call).toMatch(/ADR_REVIEW_CHILD=1/);
		expect(call).toMatch(/ARG:-p/);
		expect(call).toMatch(/ARG:test\/reviewer/);
		expect(call).toMatch(/\[adr-recorder:review\]/);
		expect(call).toMatch(/headless run/);
	});

	it("inside Rex, quitting opens the reviewer in a new block", async () => {
		const sb = sandbox(MODELS);
		sb.run("/adr note We use Postgres for storage", { REX_SESSION: "test" });
		const call = await sb.waitForCall("rex");
		expect(call).toMatch(/ARG:run\nARG:--cwd/);
		expect(call).toMatch(new RegExp(`ARG:${sb.repo}`));
		expect(call).toMatch(/ARG:-ic\nARG:cd .* && ADR_REVIEW_CHILD=1 pi --model 'test\/reviewer'/);
		expect(existsSync(join(sb.calls, "pi.txt"))).toBe(false);
	});

	it("falls back to headless when the host fails", async () => {
		const sb = sandbox(`${MODELS}review_launcher: rex\n`);
		sb.run("/adr note We use Postgres for storage", { STUB_FAIL: "1" });
		expect(await sb.waitForCall("rex")).toBeDefined();
		const call = await sb.waitForCall("pi");
		expect(call).toMatch(/ARG:-p/);
		expect(call).toMatch(/headless run/);
	});

	it("uses review_command for other hosts", async () => {
		const sb = sandbox(`${MODELS}review_command: rex run --cwd {cwd} -- sh -ic {command}\n`);
		sb.run("/adr note We use Postgres for storage", { REX_SESSION: "ignored" });
		const call = await sb.waitForCall("rex");
		expect(call).toMatch(
			/ARG:sh\nARG:-ic\nARG:cd .* && ADR_REVIEW_CHILD=1 pi --model 'test\/reviewer'/,
		);
		expect(existsSync(join(sb.calls, "pi.txt"))).toBe(false);
	});

	it("auto_review off and review children start no review", async () => {
		const off = sandbox(`${MODELS}auto_review: off\n`);
		off.run("/adr note We use Postgres for storage");
		const child = sandbox(MODELS);
		const r = child.run("/adr status", { ADR_REVIEW_CHILD: "1" });
		expect(r.stdout).toMatch(/ADR recorder: off/);
		child.run("/adr note We use Postgres for storage", { ADR_REVIEW_CHILD: "1" });
		await new Promise((r) => setTimeout(r, 1500));
		expect(existsSync(join(off.calls, "pi.txt"))).toBe(false);
		expect(existsSync(join(child.calls, "pi.txt"))).toBe(false);
	});
});

// One real classifier call through pi's providers. Uses the models from the
// user config, so it only runs where that is set up.
const userConfig = join(homedir(), ".config", "adr-recorder", "adr-recorder.yaml");
describe.skipIf(skipModel || !existsSync(userConfig))("pi extension with a model", () => {
	const models = () =>
		readFileSync(userConfig, "utf8")
			.split("\n")
			.filter((l) => /^(classifier_model|reviewer_model):/.test(l))
			.join("\n");
	const PROMPT =
		"We'll go with Fastify instead of Express for the HTTP server. Reply with one word: ok.";

	it("does not review the same notes twice after a resume", async () => {
		const sb = sandbox(`${models()}\n`);
		sb.run(PROMPT);
		expect(sb.notes().length).toBeGreaterThanOrEqual(1);
		expect(await sb.waitForCall("pi")).toBeDefined();
		rmSync(join(sb.calls, "pi.txt"));
		const r = sb.run("/adr status", {}, ["--continue"]);
		expect(r.stdout).toMatch(/notes this session: [1-9]/);
		await new Promise((r) => setTimeout(r, 1500));
		expect(existsSync(join(sb.calls, "pi.txt"))).toBe(false);
	}, 120_000);

	it("captures a decision at the end of a run", () => {
		const sb = sandbox(`${models()}\nauto_review: off\n`);
		sb.run(
			"We'll go with Fastify instead of Express for the HTTP server. Reply with one word: ok.",
		);
		const notes = sb.notes();
		expect(notes.length).toBeGreaterThanOrEqual(1);
		const text = readFileSync(join(sb.repo, "docs", "adr", "_backlog", notes[0] ?? ""), "utf8");
		expect(text).toMatch(/Fastify/);
		expect(text).toMatch(/^harness: pi$/m);
	}, 120_000);
});
