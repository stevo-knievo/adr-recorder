import { parseArgs } from "node:util";
import { captureSession } from "../core/capture.ts";
import { adrCommand } from "./adr-command.ts";
import { type Deps, HARNESS, type HookInput, QUIT_REASONS } from "./context.ts";
import { handleHook } from "./hook.ts";
import { statusLine } from "./statusline.ts";

export const CLAUDE_CODE_USAGE = `Usage: adr-recorder claude-code <command>

Commands used by the Claude Code plugin (see README, "Claude Code"):
  hook                     Handle a hook event; reads the hook JSON on stdin
  capture --transcript <f> --session <id> --cwd <dir> [--final --reason <r>]
                           Classify new exchanges (started by the hooks)
  adr --session <id> --cwd <dir> [--args-stdin | -- <args>]
                           Backend of the /adr command
  statusline [--wrap <cmd>]
                           Status line segment; --wrap runs your own status
                           line command and appends to it
`;

export async function claudeCodeMain(
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
				return 0; // never block Claude Code
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
					harness: HARNESS,
					transcript: values.transcript,
					sessionId: values.session,
					cwd: values.cwd,
					expect: values.expect,
					final: values.final,
					quit: values.final && QUIT_REASONS.has(values.reason ?? ""),
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
			return adrCommand({ id: values.session, cwd: values.cwd }, args, d);
		}
		case "statusline": {
			const { values } = parseArgs({ args: rest, options: { wrap: { type: "string" } } });
			const line = await statusLine(await readStdin(), d, values.wrap);
			if (line) d.out(`${line}\n`);
			return 0;
		}
		default:
			d.out(CLAUDE_CODE_USAGE);
			return command && command !== "help" ? 2 : 0;
	}
}
