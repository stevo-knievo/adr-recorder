import { parseArgs } from "node:util";
import { captureSession } from "../core/capture.ts";
import { adrCommand } from "./adr-command.ts";
import type { Deps, HookInput } from "./context.ts";
import { handleHook } from "./hook.ts";
import { statusLine } from "./statusline.ts";

export const hookAgentUsage = (
	d: Pick<Deps, "agent">,
) => `Usage: adr-recorder ${d.agent.harness} <command>

Commands used by the ${d.agent.label} plugin (see README):
  hook                     Handle a hook event; reads the hook JSON on stdin
  capture --transcript <f> --session <id> --cwd <dir> [--final --reason <r>]
                           Classify new exchanges (started by the hooks)
  adr --session <id> --cwd <dir> [--args-stdin | -- <args>]
                           Backend of the /adr command
  statusline [--wrap <cmd>]
                           Status line segment (Claude Code); --wrap runs
                           your own status line command and appends to it
`;

export async function hookAgentMain(
	argv: string[],
	d: Deps,
	readStdin: () => Promise<string>,
): Promise<number> {
	const [command, ...rest] = argv;
	switch (command) {
		case "hook": {
			let input: HookInput;
			try {
				input = JSON.parse(await readStdin()) as HookInput;
			} catch {
				d.err("hook: expected the hook JSON on stdin\n");
				return 0; // never block the agent
			}
			handleHook(input, d);
			return 0;
		}
		case "capture": {
			const { values } = parseArgs({
				args: rest,
				options: {
					transcript: { type: "string" },
					session: { type: "string" },
					cwd: { type: "string" },
					expect: { type: "string" },
					reason: { type: "string" },
					final: { type: "boolean", default: false },
					all: { type: "boolean", default: false },
				},
			});
			if (!values.transcript || !values.session || !values.cwd) {
				d.err("capture needs --transcript, --session and --cwd\n");
				return 2;
			}
			const stamp = (d.now?.() ?? new Date()).toISOString();
			const r = await captureSession(
				{
					harness: d.agent.harness,
					transcript: values.transcript,
					sessionId: values.session,
					cwd: values.cwd,
					expect: values.expect,
					final: values.final,
					quit: values.final && d.agent.quitReasons.has(values.reason ?? ""),
					all: values.all,
				},
				d,
			);
			const what =
				"results" in r
					? `${r.results.filter((x) => x.outcome === "written").length} note(s)${r.review ? `, ${r.review}` : ""}`
					: "queued" in r
						? "queued behind a running capture"
						: `skipped: ${r.skipped}`;
			d.out(`${stamp} ${values.session} ${what}\n`);
			return 0;
		}
		case "adr": {
			const { values, positionals } = parseArgs({
				args: rest,
				allowPositionals: true,
				options: {
					session: { type: "string" },
					cwd: { type: "string" },
					// The /adr skill passes the arguments in a quoted heredoc: no shell quoting.
					"args-stdin": { type: "boolean", default: false },
				},
			});
			if (!values.session || !values.cwd) {
				d.err("adr needs --session and --cwd\n");
				return 2;
			}
			const args = values["args-stdin"] ? [(await readStdin()).trim()] : positionals;
			try {
				return await adrCommand({ id: values.session, cwd: values.cwd }, args, d);
			} catch (e) {
				const code = (e as NodeJS.ErrnoException).code ?? "";
				if (!["EROFS", "EACCES", "EPERM"].includes(code)) throw e;
				d.out(
					`ADR recorder: blocked by the sandbox (${(e as Error).message}).\n` +
						"Run it again outside the sandbox (approve escalated permissions).\n",
				);
				return 1;
			}
		}
		case "statusline": {
			const { values } = parseArgs({ args: rest, options: { wrap: { type: "string" } } });
			const line = await statusLine(await readStdin(), d, values.wrap);
			if (line) d.out(`${line}\n`);
			return 0;
		}
		default:
			d.out(hookAgentUsage(d));
			return command && command !== "help" ? 2 : 0;
	}
}
