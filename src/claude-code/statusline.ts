import { loadProject, projectEnablement, sessionNotes } from "../core/project.ts";
import { REVIEW_CHILD_ENV } from "../core/review.ts";
import { statusText } from "../core/status.ts";
import { type Deps, HARNESS, readOverride } from "./context.ts";

interface StatusInput {
	session_id?: string;
	cwd?: string;
	workspace?: { current_dir?: string; project_dir?: string };
}

/** "ADR rec ● 2" while the recorder is on in this session, else "". */
export function statusSegment(input: StatusInput, d: Deps): string {
	const cwd = input.workspace?.project_dir || input.workspace?.current_dir || input.cwd;
	if (!cwd || !input.session_id) return "";
	const project = loadProject(cwd, { home: d.home, env: d.env });
	const en = projectEnablement(project, {
		override: readOverride(d, input.session_id),
		reviewChild: d.env[REVIEW_CHILD_ENV] === "1",
	});
	if (!en.enabled) return "";
	return statusText(true, sessionNotes(project, HARNESS, input.session_id).length) ?? "";
}

/**
 * Claude Code has one status line command. With `wrap`, run the user's own
 * command on the same input and add our segment to the end of its first line.
 */
export async function statusLine(stdin: string, d: Deps, wrap?: string): Promise<string> {
	let input: StatusInput = {};
	try {
		input = JSON.parse(stdin) as StatusInput;
	} catch {
		// keep going: the wrapped command may still work
	}
	let segment = "";
	try {
		segment = statusSegment(input, d);
	} catch {
		// never break the status line
	}
	if (!wrap) return segment;
	const r = await d.sys.run(["sh", "-c", wrap], { stdin, timeoutMs: 5_000 });
	const lines = r.stdout.replace(/\n+$/, "").split("\n");
	if (segment) lines[0] = lines[0] ? `${lines[0]}  ${segment}` : segment;
	return lines.join("\n");
}
