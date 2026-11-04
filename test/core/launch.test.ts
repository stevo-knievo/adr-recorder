import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandLauncher, fillTemplate } from "../../src/core/launch/command.ts";
import {
	headlessLauncher,
	type Launcher,
	type LaunchJob,
	listLaunchers,
	pickLauncher,
	registerLauncher,
} from "../../src/core/launch/index.ts";
import { fakeSystem, tempRepo } from "../helpers.ts";

const job: LaunchJob = {
	cwd: "/repo",
	title: "adr-review",
	command: "ADR_REVIEW_CHILD=1 pi --model 'p/m' \"$(cat '/s/p.md')\"",
	headlessCommand: "ADR_REVIEW_CHILD=1 pi -p --model 'p/m' \"$(cat '/s/h.md')\"",
	logFile: "/s/review.log",
};
const byName = (name: string) => pickLauncher(name, {});
const ish = ["/bin/zsh", "-ic", job.command];

describe("pickLauncher", () => {
	it("auto picks the innermost detected host, else headless", () => {
		const pick = (env: Record<string, string>) => pickLauncher("auto", env).name;
		expect(pick({})).toBe("headless");
		expect(pick({ REX_SESSION: "s" })).toBe("rex");
		expect(pick({ HERDR_ENV: "1" })).toBe("herdr");
		expect(pick({ HERDR_ENV: "0" })).toBe("headless");
		expect(pick({ TMUX: "/tmp/t,1,0", REX_SESSION: "s" })).toBe("tmux");
		expect(pick({ ZELLIJ: "0", WEZTERM_PANE: "1" })).toBe("zellij");
		expect(pick({ WEZTERM_PANE: "1" })).toBe("wezterm");
		expect(pick({ KITTY_LISTEN_ON: "unix:/tmp/k" })).toBe("kitty");
	});

	it("by name, command, and errors", () => {
		expect(byName("herdr").name).toBe("herdr");
		expect(byName("headless").name).toBe("headless");
		expect(pickLauncher("command", {}, "x {command}").name).toBe("command");
		expect(() => pickLauncher("command", {})).toThrow(/needs review_command/);
		expect(() => byName("nope")).toThrow(
			/Unknown review_launcher: nope \(one of tmux, .*auto, command\)/,
		);
	});

	it("registerLauncher adds a host that wins auto detection", () => {
		const mine: Launcher = {
			name: "mymux",
			description: "test",
			detect: (env) => env.MYMUX === "1",
			launch: async () => "mymux",
		};
		registerLauncher(mine);
		expect(pickLauncher("auto", { MYMUX: "1", TMUX: "x" }).name).toBe("mymux");
		expect(listLaunchers().at(-1)?.name).toBe("headless");
	});
});

describe("built-in launchers", () => {
	it("rex: new block through the interactive shell", async () => {
		const { sys, runs } = fakeSystem();
		expect(await byName("rex").launch(job, sys)).toBe("new Rex block");
		expect(runs).toEqual([["rex", "run", "--cwd", "/repo", "--", ...ish]]);
	});

	it("herdr: creates a tab, then types the command into its pane", async () => {
		const { sys, runs } = fakeSystem(
			{},
			{
				"herdr tab": { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2" } } }) },
			},
		);
		expect(await byName("herdr").launch(job, sys)).toBe("herdr tab adr-review (w1:p2)");
		expect(runs).toEqual([
			["herdr", "tab", "create", "--cwd", "/repo", "--label", "adr-review", "--focus"],
			["herdr", "pane", "run", "w1:p2", job.command],
		]);
	});

	it("herdr: fails clearly without a pane id", async () => {
		const { sys } = fakeSystem({}, { "herdr tab": { stdout: "{}" } });
		await expect(byName("herdr").launch(job, sys)).rejects.toThrow(/no pane id/);
	});

	it("tmux, zellij, wezterm, kitty", async () => {
		const cases: [string, string[]][] = [
			["tmux", ["tmux", "new-window", "-c", "/repo", "-n", "adr-review", ...ish]],
			["zellij", ["zellij", "run", "--cwd", "/repo", "--name", "adr-review", "--", ...ish]],
			["wezterm", ["wezterm", "cli", "spawn", "--cwd", "/repo", "--", ...ish]],
			[
				"kitty",
				[
					"kitty",
					"@",
					"launch",
					"--type=tab",
					"--cwd",
					"/repo",
					"--tab-title",
					"adr-review",
					...ish,
				],
			],
		];
		for (const [name, argv] of cases) {
			const { sys, runs } = fakeSystem();
			await byName(name).launch(job, sys);
			expect(runs).toEqual([argv]);
		}
	});

	it("a failing host rejects with its own message", async () => {
		const { sys } = fakeSystem({}, { rex: { code: 1, stderr: "not inside rex\nmore" } });
		await expect(byName("rex").launch(job, sys)).rejects.toThrow(
			"rex run exited 1: not inside rex",
		);
	});

	it("headless: detached, logged", async () => {
		const { sys, detached } = fakeSystem();
		await headlessLauncher.launch(job, sys);
		expect(detached).toEqual([
			{ argv: ["sh", "-c", job.headlessCommand], cwd: "/repo", logFile: "/s/review.log" },
		]);
	});
});

describe("command launcher", () => {
	it("quotes every placeholder", () => {
		expect(
			fillTemplate("mux open {cwd} --name {title} -- sh -ic {command}", {
				cwd: "/a b",
				title: "t",
				command: "echo 'hi'",
				headless: "",
			}),
		).toBe(`mux open '/a b' --name 't' -- sh -ic 'echo '\\''hi'\\'''`);
	});

	it("runs the template in sh and survives a real round trip", async () => {
		const dir = tempRepo("none");
		const out = join(dir, "out.txt");
		const template = `printf '%s\\n' {cwd} {command} > ${out}`;
		const { sys, detached } = fakeSystem();
		await commandLauncher(template).launch({ ...job, cwd: dir }, sys);
		const argv = detached[0]?.argv ?? [];
		expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
		execFileSync(argv[0] ?? "sh", argv.slice(1));
		expect(readFileSync(out, "utf8")).toBe(`${dir}\n${job.command}\n`);
	});

	it("is the place for hosts without a launcher", () => {
		writeFileSync(join(tempRepo("none"), "x"), "");
		expect(commandLauncher("x").detect({ ANYTHING: "1" })).toBe(false);
	});
});
