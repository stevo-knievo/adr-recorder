import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adrCommand } from "../../src/claude-code/adr-command.ts";
import { claudeCodeMain } from "../../src/claude-code/cli.ts";
import { type Deps, readOverride } from "../../src/claude-code/context.ts";
import { handleHook } from "../../src/claude-code/hook.ts";
import { statusLine } from "../../src/claude-code/statusline.ts";
import { captureSession } from "../../src/core/capture.ts";
import type { Classifier, ClassifierInput } from "../../src/core/detect.ts";
import { encodeClaudeProjectDir, parseClaudeSession } from "../../src/core/harness/claude-code.ts";
import { readBacklog } from "../../src/core/notes.ts";
import { lockSession } from "../../src/core/state.ts";
import { decision, FIXTURES, fakeSystem, tempRepo } from "../helpers.ts";

const SID = "dc806543-1e1a-4112-ba37-6aa35578dbed";
const CONFIG = `classifier_model: p/small
reviewer_model: p/strong
model_endpoint:
  base_url: https://example.test/v1
  api_key_env: TEST_KEY
`;

/** Every exchange is a decision with its own summary. */
function countingClassifier() {
	const calls: ClassifierInput[] = [];
	const classifier: Classifier = {
		async classify(input) {
			calls.push(input);
			return [
				decision({ summary: `Decision ${calls.length}: ${input.exchange.user.slice(0, 30)}` }),
			];
		},
	};
	return { classifier, calls };
}

/** A repo with docs/adr, a home with config and a Claude transcript of the fixture session. */
function setup(env: Record<string, string> = {}) {
	const repo = tempRepo("docs-adr");
	const home = tempRepo();
	mkdirSync(join(home, ".config", "adr-recorder"), { recursive: true });
	writeFileSync(join(home, ".config", "adr-recorder", "adr-recorder.yaml"), CONFIG);
	const projects = join(home, ".claude", "projects", encodeClaudeProjectDir(repo));
	mkdirSync(projects, { recursive: true });
	const transcript = join(projects, `${SID}.jsonl`);
	copyFileSync(join(FIXTURES, "sessions", "claude-code-cc-notes.jsonl"), transcript);
	const { sys, runs, detached } = fakeSystem(env);
	const out: string[] = [];
	const err: string[] = [];
	const { classifier, calls } = countingClassifier();
	const d: Deps = {
		env: { ...sys.env, TEST_KEY: "k" },
		home,
		stateDir: join(home, "state"),
		sys,
		self: ["node", "/x/adr-recorder.js"],
		out: (s) => out.push(s),
		err: (s) => err.push(s),
		sleep: async () => {},
		classifier,
	};
	const notes = () => readBacklog(repo, "docs/adr/_backlog");
	return { repo, home, transcript, d, runs, detached, out, err, calls, notes };
}

const job = (s: ReturnType<typeof setup>, over = {}) => ({
	harness: "claude-code",
	transcript: s.transcript,
	sessionId: SID,
	cwd: s.repo,
	...over,
});

describe("Claude Code hooks", () => {
	it("Stop hands the turn to a detached worker", () => {
		const s = setup();
		handleHook(
			{
				hook_event_name: "Stop",
				session_id: SID,
				transcript_path: s.transcript,
				cwd: s.repo,
				last_assistant_message: "-".repeat(10) + "x".repeat(300),
			},
			s.d,
		);
		const argv = s.detached[0]?.argv ?? [];
		expect(argv.slice(0, 4)).toEqual(["node", "/x/adr-recorder.js", "claude-code", "capture"]);
		expect(argv).toEqual(expect.arrayContaining(["--transcript", s.transcript, "--session", SID]));
		expect(argv.at(-1)).toBe(`--expect=${"x".repeat(200)}`);
		expect(s.detached[0]?.logFile).toMatch(/claude-code\/capture\.log$/);
	});

	it("SessionEnd asks for a final pass with the reason", () => {
		const s = setup();
		const input = { session_id: SID, transcript_path: s.transcript, cwd: s.repo };
		handleHook({ ...input, hook_event_name: "SessionEnd", reason: "prompt_input_exit" }, s.d);
		handleHook({ ...input, hook_event_name: "PreCompact" }, s.d);
		expect(s.detached[0]?.argv.slice(-3)).toEqual(["--final", "--reason", "prompt_input_exit"]);
		expect(s.detached[1]?.argv).not.toContain("--final");
	});

	it("do nothing in review agents, repos without ADRs, sessions turned off, or a Stop loop", () => {
		const input = { hook_event_name: "Stop", session_id: SID };
		const child = setup({ ADR_REVIEW_CHILD: "1" });
		handleHook({ ...input, transcript_path: child.transcript, cwd: child.repo }, child.d);
		const plain = setup();
		handleHook({ ...input, transcript_path: plain.transcript, cwd: tempRepo("none") }, plain.d);
		handleHook(
			{ ...input, transcript_path: plain.transcript, cwd: plain.repo, stop_hook_active: true },
			plain.d,
		);
		const off = setup();
		adrCommand({ id: SID, cwd: off.repo }, ["off"], off.d);
		handleHook({ ...input, transcript_path: off.transcript, cwd: off.repo }, off.d);
		expect([...child.detached, ...plain.detached, ...off.detached]).toEqual([]);
	});

	it("SessionStart announces a new review report once", () => {
		const s = setup();
		mkdirSync(join(s.repo, "docs/adr/_backlog"), { recursive: true });
		writeFileSync(
			join(s.repo, "docs/adr/_backlog/_review-2026-11-03_1200.md"),
			"# Review\n\n## Proposal 1\n",
		);
		const start = { hook_event_name: "SessionStart", session_id: SID, cwd: s.repo };
		handleHook(start, s.d);
		handleHook(start, s.d);
		expect(s.out).toHaveLength(1);
		expect(JSON.parse(s.out[0] ?? "").systemMessage).toMatch(
			/^ADR review ready: .*_review-2026-11-03_1200\.md/,
		);
	});
});

describe("Claude Code capture", () => {
	it("classifies each exchange once and keeps the transcript path", async () => {
		const s = setup();
		const r = await captureSession(job(s), s.d);
		expect("results" in r && r.results.filter((x) => x.outcome === "written")).toHaveLength(3);
		expect(s.calls).toHaveLength(3);
		const n = s.notes();
		expect(
			n.every((x) => x.harness === "claude-code" && x.id.startsWith(`claude-code:${SID}:`)),
		).toBe(true);
		expect(n[0]?.sessionFile).toMatch(/^~\/\.claude\/projects\/.*\.jsonl$/);
		await captureSession(job(s), s.d);
		expect(s.calls).toHaveLength(3);
	});

	it("leaves the last exchange for later when its reply hasn't landed", async () => {
		const s = setup();
		await captureSession(job(s, { expect: "a reply that is not in the file" }), s.d);
		expect(s.calls).toHaveLength(2);
		const reply = parseClaudeSession(readFileSync(s.transcript, "utf8"), s.transcript).turns.at(
			-1,
		)?.text;
		await captureSession(job(s, { expect: reply?.slice(-80) }), s.d);
		expect(s.calls).toHaveLength(3);
	});

	it("reviews this session's notes once when the human quits", async () => {
		const s = setup({ REX_SESSION: "r" });
		const quit = job(s, { final: true, quit: true });
		const r = await captureSession(quit, s.d);
		expect("results" in r && r.review).toMatch(/^review started: 3 note\(s\), rex/);
		expect(s.runs[0]?.at(-1)).toMatch(/ADR_REVIEW_CHILD=1 claude --model 'strong'/);
		const again = await captureSession(quit, s.d);
		expect("results" in again && again.review).toBe("review skipped: no-new-notes");
		const clear = await captureSession(job(s, { final: true, quit: false }), s.d);
		expect("results" in clear && clear.review).toBeUndefined();
	});

	it("queues behind a running worker", async () => {
		const s = setup();
		const release = lockSession(s.d.stateDir, "claude-code", SID);
		expect(await captureSession(job(s, { final: true, quit: true }), s.d)).toEqual({
			queued: true,
		});
		const queued = readdirSync(join(s.d.stateDir, "claude-code", "locks")).find((f) =>
			f.endsWith(".rerun.json"),
		);
		expect(
			JSON.parse(readFileSync(join(s.d.stateDir, "claude-code", "locks", queued ?? ""), "utf8"))
				.final,
		).toBe(true);
		release?.();
	});

	it("the running worker picks up a final pass queued while it works", async () => {
		const s = setup({ REX_SESSION: "r" });
		let second: Promise<unknown> | undefined;
		const slow: Classifier = {
			async classify(input) {
				// SessionEnd fires while the Stop worker is still classifying.
				second ??= captureSession(job(s, { final: true, quit: true }), s.d);
				return [decision({ summary: `About ${input.exchange.anchor}` })];
			},
		};
		const r = await captureSession(job(s), { ...s.d, classifier: slow });
		expect(await second).toEqual({ queued: true });
		expect("results" in r && r.review).toMatch(/^review started: 3 note/);
	});

	it("stays off in a review agent's own session", async () => {
		const s = setup({ ADR_REVIEW_CHILD: "1" });
		expect(await captureSession(job(s), s.d)).toEqual({ skipped: "review agent" });
	});
});

describe("claude-code capture command", () => {
	it("reviews after a quit, not after /clear", async () => {
		const s = setup({ REX_SESSION: "r" });
		const run = (reason: string) =>
			claudeCodeMain(
				[
					"capture",
					"--transcript",
					s.transcript,
					"--session",
					SID,
					"--cwd",
					s.repo,
					"--final",
					"--reason",
					reason,
				],
				s.d,
				async () => "",
			);
		await run("clear");
		expect(s.out.at(-1)).toMatch(/ 3 note\(s\)\n$/);
		await run("prompt_input_exit");
		expect(s.out.at(-1)).toMatch(/ 0 note\(s\), review started: 3 note\(s\), rex/);
	});
});

describe("/adr in Claude Code", () => {
	it("on, off, note, status", async () => {
		const s = setup();
		const session = { id: SID, cwd: s.repo };
		await adrCommand(session, ["off"], s.d);
		expect(readOverride(s.d, SID)).toBe(false);
		await adrCommand(session, ["note", "Keep", "notes", "in", "SQLite"], s.d);
		expect(s.notes()[0]).toMatchObject({
			decision: "Keep notes in SQLite",
			harness: "claude-code",
		});
		await adrCommand(session, ["status"], s.d);
		expect(s.out.at(-1)).toMatch(/^ADR recorder: off \(\/adr off\)\n.*\nnotes this session: 1/);
		await adrCommand(session, ["on"], s.d);
		expect(s.out.at(-1)).toBe("ADR recorder: on (/adr on)\n");
	});

	it("on in a repo without ADRs sets adr_dir", async () => {
		const s = setup();
		const repo = tempRepo("none");
		await adrCommand({ id: SID, cwd: repo }, ["on", "doc/decisions"], s.d);
		expect(readFileSync(join(repo, ".adr-recorder.yaml"), "utf8")).toBe("adr_dir: doc/decisions\n");
	});

	it("scan and review", async () => {
		const s = setup({ REX_SESSION: "r" });
		const session = { id: SID, cwd: s.repo };
		await adrCommand(session, ["scan"], s.d);
		expect(s.out.at(-1)).toMatch(/^ADR recorder: 3 note\(s\)/);
		expect(await adrCommand(session, ["review"], s.d)).toBe(0);
		expect(s.out.join("")).toMatch(/ADR review: 3 open note\(s\), rex/);
		expect(await adrCommand(session, ["bogus"], s.d)).toBe(2);
	});
});

describe("Claude Code status line", () => {
	it("shows the recorder only where it is on, and wraps another status line", async () => {
		const s = setup();
		await adrCommand({ id: SID, cwd: s.repo }, ["note", "x"], s.d);
		const input = JSON.stringify({ session_id: SID, workspace: { current_dir: s.repo } });
		expect(await statusLine(input, s.d)).toBe("ADR rec ● 1");
		expect(await statusLine(JSON.stringify({ session_id: SID, cwd: tempRepo("none") }), s.d)).toBe(
			"",
		);
		expect(await statusLine("not json", s.d)).toBe("");
		const answers = { sh: { stdout: "model · branch\nsecond\n" } };
		const { sys, runs } = fakeSystem({}, answers);
		expect(await statusLine(input, { ...s.d, sys }, "my-status")).toBe(
			"model · branch  ADR rec ● 1\nsecond",
		);
		expect(runs[0]).toEqual(["sh", "-c", "my-status"]);
	});
});
