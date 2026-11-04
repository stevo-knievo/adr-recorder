import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempRepo } from "../helpers.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));

/** Run a hook command the way Claude Code does: through a shell, JSON on stdin. */
function runHook(event: string, input: object, env: Record<string, string>) {
	const command: string = hooks.hooks[event][0].hooks[0].command;
	const start = Date.now();
	const out = execFileSync("sh", ["-c", command], {
		input: JSON.stringify({ hook_event_name: event, ...input }),
		encoding: "utf8",
		env: { ...process.env, ...env, CLAUDE_PLUGIN_ROOT: ROOT },
	});
	return { out, ms: Date.now() - start };
}

describe("Claude Code plugin", () => {
	it("SessionStart tells about a new review report, fast", () => {
		const repo = tempRepo("docs-adr");
		const home = tempRepo();
		mkdirSync(join(repo, "docs/adr/_backlog"), { recursive: true });
		writeFileSync(join(repo, "docs/adr/_backlog/_review-2026-11-03_1200.md"), "# Review\n");
		const env = {
			HOME: home,
			XDG_STATE_HOME: join(home, "state"),
			XDG_CONFIG_HOME: join(home, "cfg"),
		};
		const r = runHook("SessionStart", { session_id: "s1", cwd: repo }, env);
		expect(JSON.parse(r.out).systemMessage).toMatch(/^ADR review ready/);
		// SessionEnd hooks get 1.5s in total; the hook must stay far below.
		expect(r.ms).toBeLessThan(1500);
		expect(
			runHook("SessionEnd", { session_id: "s1", cwd: tempRepo("none"), reason: "other" }, env).out,
		).toBe("");
	});

	it("bin/adr-recorder runs without the .js, for the Bash tool's PATH", () => {
		const out = execFileSync(join(ROOT, "bin", "adr-recorder"), ["claude-code", "help"], {
			encoding: "utf8",
		});
		expect(out).toMatch(/^Usage: adr-recorder claude-code/);
	});
});
