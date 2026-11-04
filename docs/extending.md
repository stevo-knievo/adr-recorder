# Extending adr-recorder

Two things vary between users: the **agent** they code with, and the
**terminal host** they run it in. Each has a small interface and a registry.
Adding one is a new file plus one line in the registry; nothing else changes.

```
src/core/harness/   agents    (pi, ...)          HarnessAdapter
src/core/launch/    hosts     (tmux, rex, ...)   Launcher
src/core/review-start.ts      picks one of each and opens the reviewer
```

## Add a terminal host (launcher)

A launcher opens a shell command somewhere a human can see it: a new tab,
pane, block or window.

```ts
// src/core/launch/myhost.ts
import type { Launcher } from "./types.ts";
import { check, interactiveShell } from "./util.ts";

export const myhostLauncher: Launcher = {
	name: "myhost", // value of review_launcher
	description: "new myhost tab (inside myhost)",
	// Read only the environment. Return true when this process runs inside the host.
	detect: (env) => Boolean(env.MYHOST_SESSION),
	async launch(job, sys) {
		check(
			"myhost open",
			await sys.run([
				"myhost",
				"open",
				"--cwd",
				job.cwd,
				"--title",
				job.title,
				"--",
				...interactiveShell(sys.env, job.command),
			]),
		);
		return "new myhost tab"; // shown to the user
	},
};
```

Then add it to the list in `src/core/launch/index.ts`. The order is the
`auto` detection order: multiplexers (tmux, zellij, herdr) before terminals,
because a tmux inside WezTerm should get a tmux window.

Things to know:

- `job.command` is a full POSIX shell line. If your host starts a program
  directly, wrap it with `interactiveShell(env, cmd)` so the user's shell
  config (PATH, API tokens) is loaded. If your host types into a shell that is
  already running (herdr does), pass `job.command` as is.
- Do every side effect through `sys` (`run`, `spawnDetached`). Never import
  `child_process` in a launcher. That keeps it testable without the host.
- Reject (throw) when the host refuses. The caller then runs the review
  headless, so a broken host never loses a review.
- Test the exact argv with `fakeSystem()` from `test/helpers.ts`, like the
  cases in `test/core/launch.test.ts`.

A user who doesn't want to write code can use `review_launcher: command` with a
`review_command` template instead.

## Add an agent (harness)

A harness has two optional sides. Implement what the agent supports; a new
agent can be scanned long before it can act as a reviewer, or the other way
round.

```ts
// src/core/harness/myagent.ts
import type { HarnessAdapter } from "./types.ts";

export const myAgentHarness: HarnessAdapter = {
	name: "myagent", // stored in notes as `harness: myagent`
	sessions: {
		name: "myagent",
		sessionsDir: (env, home) => env.MYAGENT_HOME ?? `${home}/.myagent/sessions`,
		findSessions: (dir, project, since) => [
			/* FoundSession[] */
		],
		loadSession: (file) => ({
			/* Session: ordered user/assistant turns */
		}),
	},
	reviewer: {
		name: "myagent",
		reviewerCommand: ({ cwd, model, promptFile, bin }) => "...",
		headlessReviewerCommand: ({ cwd, model, promptFile, bin }) => "...",
	},
};
```

Then register it in `src/core/harness/index.ts`.

- `findSessions` returns sessions whose working folder is the project or a
  folder inside it.
- `loadSession` returns the turns of the active branch only, as `Turn`s
  (`src/core/types.ts`). Detection, notes and review work on that shape and
  never look at the raw format.
- Reviewer commands must set `ADR_REVIEW_CHILD=1` for the agent, so the
  review doesn't record itself, and must read the prompt from `promptFile`
  (it is long). Quote with `shq` from `src/core/shell.ts`. Start the agent
  as `bin` when it is set (the user's `agent_commands`). See `pi.ts`,
  `claude-code.ts`, `codex.ts` and the round-trip test in `test/core/harness.test.ts`.
- Put a real (anonymised) session in `test/fixtures/` and test the parser
  against it. `scripts/make-fixture.ts` (pi) and
  `scripts/make-claude-fixture.ts` and `scripts/make-codex-fixture.ts` show how to trim and anonymise one.

## Add live capture for an agent

Live capture lives outside core: `src/pi/` for pi, `src/hook-agent/` for
agents with Claude Code style hooks (Claude Code, Codex). Only an adapter
folder may import an agent's SDK,
and adapters never import each other; `test/core/boundary.test.ts` checks
both. What an adapter needs is already in core:

| Need                                  | Core function                                      |
| ------------------------------------- | -------------------------------------------------- |
| config, layout, on or off             | `loadProject`, `projectEnablement`                 |
| `/adr status`, `/adr note`, `/adr on` | `statusReport`, `writeManualNote`, `setRepoAdrDir` |
| review on quit, once per note         | `reviewOnExit`                                     |
| "ADR review ready" once per report    | `takeNewReviewReport`                              |
| `/adr review` in a new pane           | `startReview`                                      |
| the status line text                  | `statusText`, `sessionNotes`                       |

How the adapter gets new exchanges depends on the agent:

- **In-process** (pi): the extension lives as long as the session, keeps the
  set of seen exchanges in memory and calls `scanSession` after each run.
- **Hooks** (Claude Code, Codex): each hook is a new, short-lived process. Return at
  once and start a detached worker that calls `captureSession` from
  `src/core/capture.ts`. It reads the transcript through the harness's
  `SessionSource`, keeps one worker per session (later jobs queue behind it),
  waits briefly for a reply that hasn't reached the transcript yet,
  remembers what it classified in the state dir, and runs `reviewOnExit` when
  the job says the human quit. `/adr on` and `/adr off` go to
  `writeOverride` in `src/core/state.ts`. See `src/hook-agent/hook.ts` for
  the whole pattern in about fifty lines.

If the agent's hooks send the same JSON as Claude Code (`session_id`,
`transcript_path`, `cwd`, `hook_event_name`, `last_assistant_message`,
`reason`), you don't write an adapter at all:

1. The harness in `src/core/harness/<name>.ts`, with `findSession` so `/adr`
   can find the transcript by session id.
2. A profile in `src/hook-agent/agents.ts`: name, label, the SessionEnd
   reasons that mean the human quit, and the env var with the project folder
   if hooks may lack `cwd`. That also adds the CLI command
   `adr-recorder <name> hook|capture|adr`.
3. The agent's plugin files: a manifest, a hooks file that runs
   `adr-recorder <name> hook` (see `hooks/hooks.json` and
   `hooks/codex-hooks.json`), and an `/adr` skill that passes the session id
   (`skills/adr/`, `codex/skills/adr/`).

Hook-based agents have no model access for plugins, so the classifier comes
from `model_endpoint` (`classifierFromConfig`).

## Without forking

`registerLauncher()` and `registerHarness()` add entries at runtime, for
example from a pi extension of your own that runs before this one. Built-in
code never needs to know about them.
