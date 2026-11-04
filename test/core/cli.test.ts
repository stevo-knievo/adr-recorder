import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIO, main } from "../../src/cli.ts";
import { decision, fakeClassifier, fakeSystem, sessionFixturePath, tempRepo } from "../helpers.ts";

function io(over: Partial<CliIO> = {}) {
	let out = "";
	let err = "";
	const value: CliIO = {
		out: (s) => {
			out += s;
		},
		err: (s) => {
			err += s;
		},
		env: {},
		home: tempRepo(),
		cwd: process.cwd(),
		...over,
	};
	return { io: value, out: () => out, err: () => err };
}

/** A sessions folder holding the todo-api fixture, with its cwd pointed at root. */
function sessionsFor(root: string): string {
	const dir = tempRepo();
	mkdirSync(join(dir, "proj"));
	const target = join(dir, "proj", "s.jsonl");
	copyFileSync(sessionFixturePath("todo-api"), target);
	const text = readFileSync(target, "utf8").replace(
		'"cwd":"/work/todo-api"',
		`"cwd":${JSON.stringify(root)}`,
	);
	writeFileSync(target, text);
	return dir;
}

describe("cli", () => {
	it("help and unknown command", async () => {
		const a = io();
		expect(await main(["help"], a.io)).toBe(0);
		expect(a.out()).toMatch(/scan/);
		const b = io();
		expect(await main(["nope"], b.io)).toBe(2);
		expect(b.err()).toMatch(/Unknown command/);
	});

	it("scan without models fails with a pointer to the config file", async () => {
		const root = tempRepo("docs-adr");
		const a = io();
		expect(await main(["scan", "--path", root], a.io)).toBe(1);
		expect(a.err()).toMatch(
			/Missing required config: classifier_model, reviewer_model, model_endpoint/,
		);
		expect(a.err()).toMatch(/adr-recorder\.yaml/);
	});

	it("scan fails clearly when the API key env var is unset", async () => {
		const root = tempRepo("docs-adr");
		const home = tempRepo();
		mkdirSync(join(home, ".config/adr-recorder"), { recursive: true });
		writeFileSync(
			join(home, ".config/adr-recorder/adr-recorder.yaml"),
			"classifier_model: p/m\nreviewer_model: p/r\nmodel_endpoint:\n  base_url: https://x.test\n  api_key_env: NOPE_KEY\n",
		);
		const a = io({ home });
		expect(await main(["scan", "--path", root], a.io)).toBe(1);
		expect(a.err()).toMatch(/NOPE_KEY is not set/);
	});

	it("scan finds sessions for the project and writes notes", async () => {
		const root = tempRepo("docs-adr");
		const { classifier } = fakeClassifier({}, decision());
		const a = io({ classifier });
		const code = await main(["scan", "--path", root, "--sessions-dir", sessionsFor(root)], a.io);
		expect(code).toBe(0);
		expect(a.out()).toMatch(/1 session\(s\)/);
		expect(a.out()).toMatch(/Done: no-trigger=3 written=3/);
		expect(readdirSync(join(root, "docs/adr/_backlog"))).toHaveLength(3);
	});

	it("scan --dry-run --session writes nothing", async () => {
		const root = tempRepo("docs-adr");
		const { classifier } = fakeClassifier({}, decision());
		const a = io({ classifier });
		const code = await main(
			["scan", "--path", root, "--session", sessionFixturePath("todo-api"), "--dry-run"],
			a.io,
		);
		expect(code).toBe(0);
		expect(a.out()).toMatch(/would-write=3/);
		expect(readdirSync(join(root, "docs/adr"))).not.toContain("_backlog");
	});

	it("scan rejects harnesses that are not built yet and bad dates", async () => {
		const a = io();
		expect(await main(["scan", "--harness", "codex"], a.io)).toBe(2);
		expect(a.err()).toMatch(/--harness codex is not supported yet/);
		expect(await main(["scan", "--harness", "made-up"], a.io)).toBe(2);
		expect(a.err()).toMatch(/Unknown harness: made-up/);
		expect(await main(["scan", "--since", "yesterday-ish"], a.io)).toBe(2);
	});

	it("review --dry-run shows the plan; review opens it through the launcher", async () => {
		const root = tempRepo("docs-adr");
		const { classifier } = fakeClassifier({}, decision());
		const home = tempRepo();
		mkdirSync(join(home, ".config", "adr-recorder"), { recursive: true });
		writeFileSync(
			join(home, ".config", "adr-recorder", "adr-recorder.yaml"),
			"reviewer_model: p/strong\n",
		);
		const env = { REX_SESSION: "s", XDG_STATE_HOME: join(home, "state") };
		const empty = io({ home, env });
		expect(await main(["review", "--path", root], empty.io)).toBe(0);
		expect(empty.out()).toMatch(/No open notes/);

		await main(
			["scan", "--path", root, "--session", sessionFixturePath("todo-api")],
			io({ classifier, home }).io,
		);
		const dry = io({ home, env });
		expect(await main(["review", "--path", root, "--dry-run"], dry.io)).toBe(0);
		expect(dry.out()).toMatch(/3 open note\(s\); report docs\/adr\/_backlog\/_review-/);
		expect(dry.out()).toMatch(/launcher: rex, \(dry run\)/);
		expect(dry.out()).toMatch(/command: +cd .* && ADR_REVIEW_CHILD=1 pi --model 'p\/strong'/);

		const { sys, runs } = fakeSystem(env);
		const real = io({ home, env, sys });
		expect(await main(["review", "--path", root], real.io)).toBe(0);
		expect(real.out()).toMatch(/launcher: rex, new Rex block/);
		expect(runs[0]?.slice(0, 3)).toEqual(["rex", "run", "--cwd"]);
	});

	it("launchers marks what auto picks", async () => {
		const a = io({ env: { HERDR_ENV: "1" } });
		expect(await main(["launchers"], a.io)).toBe(0);
		expect(a.out()).toMatch(/^\* herdr/m);
		expect(a.out()).toMatch(/^ {2}headless/m);
	});

	it("status shows layout, enablement and missing settings", async () => {
		const root = tempRepo("docs-adr");
		const a = io();
		expect(await main(["status", "--path", root], a.io)).toBe(0);
		expect(a.out()).toMatch(/enabled: +yes \(repo has an ADR folder\)/);
		expect(a.out()).toMatch(/adr_dir: +docs\/adr \(known\)/);
		expect(a.out()).toMatch(/missing: +classifier_model, reviewer_model, model_endpoint/);
		expect(a.out()).toMatch(/review: +on, launcher auto -> headless/);
	});
});
