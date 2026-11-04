import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { Env } from "../harness/types.ts";
import type { RunResult, System } from "./types.ts";

/** The real System: child processes on this machine. */
export function nodeSystem(env: Env = process.env): System {
	return {
		env,
		run(argv, opts = {}) {
			return new Promise<RunResult>((resolve) => {
				const [cmd, ...args] = argv;
				if (!cmd) return resolve({ code: 127, stdout: "", stderr: "empty command" });
				const child = spawn(cmd, args, {
					cwd: opts.cwd,
					env: env as NodeJS.ProcessEnv,
					stdio: ["ignore", "pipe", "pipe"],
					timeout: opts.timeoutMs,
				});
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (d) => {
					stdout += d;
				});
				child.stderr.on("data", (d) => {
					stderr += d;
				});
				child.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
				child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
			});
		},
		spawnDetached(argv, opts = {}) {
			const [cmd, ...args] = argv;
			if (!cmd) return;
			let fd: number | "ignore" = "ignore";
			if (opts.logFile) {
				mkdirSync(dirname(opts.logFile), { recursive: true });
				fd = openSync(opts.logFile, "a");
			}
			const child = spawn(cmd, args, {
				cwd: opts.cwd,
				env: env as NodeJS.ProcessEnv,
				detached: true,
				stdio: ["ignore", fd, fd],
			});
			child.on("error", () => {});
			child.unref();
			if (typeof fd === "number") closeSync(fd);
		},
	};
}
