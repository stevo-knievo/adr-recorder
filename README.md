# adr-recorder

Decisions made in chat get lost. adr-recorder watches agent coding sessions,
spots when a decision is made, and writes a short note to the project's ADR
backlog. A review step later turns each note into an ADR, a lighter doc (see
`docs/how-to-document.md`), or nothing.

Status: early. Works in pi and Claude Code (live capture, `/adr` commands,
review) and as a CLI over their session files. A Codex adapter is next.

## Install

Needs Node 22.18 or later. The package is plain TypeScript, there is no build
step.

### pi

From git:

```bash
pi install git:github.com/stevo-knievo/adr-recorder
```

From a local clone, for working on it. Edits apply directly; type `/reload`
in a running session to pick them up:

```bash
git clone https://github.com/stevo-knievo/adr-recorder.git
cd adr-recorder && npm install
pi install .
```

To try a clone for one run only: `pi -e ./src/pi/index.ts`.

When active, the status line shows `ADR rec ●`, or `ADR rec ● 3` once this
session has three notes.

### Claude Code

The repo is also a Claude Code plugin and its own marketplace. Inside Claude
Code:

```
/plugin marketplace add stevo-knievo/adr-recorder
/plugin install adr-recorder@adr-recorder
```

Claude Code installs the two runtime packages (`jiti`, `yaml`) itself. To load
a local clone instead, run `npm install` in it and start
`claude --plugin-dir <clone>`. See "In Claude Code" for the model endpoint
and the status line.

### CLI

```bash
npm install -g github:stevo-knievo/adr-recorder
adr-recorder status
```

## Configuration

Models are required. There are no built-in defaults, so nothing runs against a
model you didn't pick. Put this in `~/.config/adr-recorder/adr-recorder.yaml`
(or `$XDG_CONFIG_HOME/adr-recorder/adr-recorder.yaml`, or point
`ADR_RECORDER_CONFIG` at a file):

```yaml
# Cheap and fast: called once per exchange that matches decision wording.
classifier_model: openai/gpt-5-mini
# Strong: reads the backlog and drafts ADRs and doc changes.
reviewer_model: anthropic/claude-opus-4-1

# The CLI and Claude Code talk to an OpenAI-compatible endpoint. Inside pi the
# recorder uses pi's own providers and ignores this block.
model_endpoint:
  base_url: https://api.openai.com/v1
  api_key_env: OPENAI_API_KEY # name of the env var, never the key

auto_review: on # on | ask | off
review_launcher: auto # where the review opens on quit; see "Review" below
enabled_paths: [] # e.g. ["~/work/**"], on even without an ADR folder
disabled_paths: [] # always off here, wins over everything but /adr on
```

Pick a small, fast model for `classifier_model` (it answers once per
candidate exchange and should take a second or two) and the strongest model
you have for `reviewer_model`. Model ids are `provider/model` as pi knows
them. Outside pi, the provider part is dropped when calling the endpoint, so
`openai/gpt-5-mini` is sent as `gpt-5-mini`.

A repo can add `.adr-recorder.yaml` next to its `.git`. It may set the models,
`auto_review`, and the layout:

```yaml
adr_dir: doc/architecture/decisions
backlog_dir: doc/architecture/decisions/_backlog
numbering: sequential # or date
template: doc/architecture/decisions/template.md
targets:
  glossary: docs/terms.md
  decision_log: docs/DECISIONS.md
ignore: [examples/**] # skipped when looking for package ADR folders
```

`model_endpoint`, `review_launcher`, `review_command`, `review_harness`,
`agent_commands` and the path lists are only read from your user file, so a
cloned repo can't send transcripts somewhere else or run commands.

### Where notes go

The ADR folder is found in this order: `adr_dir` in `.adr-recorder.yaml`,
`.adr-dir` (adr-tools), `.log4brains.yml`, then the first of these that holds
Markdown, ignoring case: `docs/adr`, `docs/adrs`, `doc/adr`, `doc/adrs`,
`docs/decisions`, `doc/decisions`, `docs/architecture/decisions`,
`doc/architecture/decisions`, `docs/architecture-decisions`, `adr`, `adrs`,
`architecture/decisions`. New repos get `docs/adr`.

Notes go to `<adr_dir>/_backlog/YYYY-MM-DD_slug.md` and are meant to be
committed. In a monorepo with package ADR folders (say
`services/billing/docs/adr`), a decision about files in that package goes to
that package's backlog. Folders named `fixtures`, `__fixtures__`,
`testdata`, `node_modules`, `vendor` and build output are never searched.

## In pi

The recorder is on in a repo that has an ADR folder, in folders matching
`enabled_paths`, or after `/adr on`. After each agent run it looks at the new
exchange and writes a note if a decision was made. Classification goes
through pi's own providers, using `classifier_model`.

| Command               | What it does                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/adr status`         | layout, models, notes so far                                                                                                                             |
| `/adr on`, `/adr off` | turn it on or off for this session (kept on resume). In a repo with no ADR folder, `on` asks where ADRs should live and saves it in `.adr-recorder.yaml` |
| `/adr note <text>`    | record a decision by hand, no model call                                                                                                                 |
| `/adr scan`           | look at the whole session, for sessions where it was off                                                                                                 |
| `/adr review`         | ask the agent to start a reviewer sub-agent on the backlog                                                                                               |

## In Claude Code

The same rules decide when it is on. Hooks do the work:

- `Stop` (after each reply) and `PreCompact` start a background worker that
  classifies the new exchanges. Claude Code doesn't wait for it.
- `SessionEnd` runs a last pass, then the auto review when you quit (not on
  `/clear`).
- `SessionStart` says "ADR review ready" after a headless review.

Claude Code has no model access for plugins, so the classifier goes through
`model_endpoint` like the CLI does. The `api_key_env` variable must be set in
the shell you start `claude` from.

`/adr` takes the same subcommands as in pi. `/adr on <dir>` sets the ADR
folder in a repo that has none (default `docs/adr`). `/adr review` opens the
reviewer through `review_launcher`, the same way the auto review does.

A plugin can't set the status line, so add it to `~/.claude/settings.json`
yourself. `--wrap` keeps the status line you have and appends to it:

```json
"statusLine": {
  "type": "command",
  "command": "adr-recorder claude-code statusline --wrap 'your-current-statusline-command'"
}
```

Use the full path to `bin/adr-recorder.js` if `adr-recorder` isn't on your
PATH. Worker output goes to
`~/.local/state/adr-recorder/claude-code/capture.log`.

## Review

The reviewer reads the open notes, the existing ADRs and the session
transcripts, and proposes for each note: promote to an ADR (drafted from the
repo's template), merge into another note, move to a lighter doc (with the
exact file and text), or discard. It writes
`<backlog>/_review-YYYY-MM-DD_HHMM.md` and asks before touching anything
outside the backlog.

`/adr review` hands the task to the agent's sub-agent tool. Which tool that is
(a Rex pane, a tmux split, anything else) is up to the pi packages you have
installed. Without one, the agent does the review itself.

When a session that recorded notes quits, `auto_review` starts a review on
its own. A quitting pi can't host it, so a launcher opens it somewhere else.
`review_launcher` picks one:

| `review_launcher` | Opens the reviewer in                                          |
| ----------------- | -------------------------------------------------------------- |
| `auto` (default)  | the first host below that this terminal runs in, else headless |
| `tmux`            | a new tmux window                                              |
| `zellij`          | a new zellij pane                                              |
| `herdr`           | a new herdr tab                                                |
| `rex`             | a new Rex block                                                |
| `wezterm`         | a new WezTerm tab                                              |
| `kitty`           | a new kitty tab (needs remote control)                         |
| `headless`        | a background run (`pi -p`, `claude -p`), report only           |
| `command`         | your own `review_command`, for any other host                  |

`adr-recorder launchers` shows which one `auto` picks in the current
terminal. If the host refuses (say the tmux server is gone), the review runs
headless instead. After a headless run the next session in that repo says
"ADR review ready: N proposals". `adr-recorder review` starts the same
hand-off by hand.

`review_command` is a shell template. `{cwd}`, `{title}`, `{command}` (the
interactive reviewer) and `{headless}` (the background run) are replaced with
shell-quoted values, so pass them as arguments:

```yaml
review_launcher: command
review_command: my-mux new-tab --dir {cwd} --name {title} -- sh -ic {command}
```

The reviewer is the same agent the session ran in. `review_harness: <name>`
overrides that. If you start an agent through a wrapper, say so in
`agent_commands`:

```yaml
agent_commands:
  claude-code: my-wrapper claude # default: claude
  pi: pi # default
```
To add a host or an agent, see
[docs/extending.md](docs/extending.md).

Review agents get `ADR_REVIEW_CHILD=1` and don't record or start reviews of
their own. Each note is auto-reviewed once, even across resumes. Logs and
bookkeeping live in `~/.local/state/adr-recorder/`.

## CLI

```bash
adr-recorder status                      # layout, config, enablement
adr-recorder scan --dry-run              # what would be recorded
adr-recorder scan                        # write backlog notes
adr-recorder scan --since 2026-11-01 --path ~/work/some-repo
adr-recorder scan --session ~/.pi/agent/sessions/<dir>/<file>.jsonl
adr-recorder scan --harness claude-code  # or all
adr-recorder review --dry-run            # which launcher, which command
adr-recorder launchers                   # hosts this terminal supports
```

`scan` finds sessions (pi by default, `--harness claude-code` for
`~/.claude/projects`) whose working folder is the project or a folder inside
it. Re-running is safe: exchanges that already have a note are
skipped without a model call.

### How detection works

Two stages. A cheap local check scores each exchange (the human's message plus
everything the agent did until it stopped): decision wording from the human
("let's go with", "instead of", "from now on", "never use"), a short "yes" or
"do 2" right after the agent listed options, or tool calls that install
packages, scaffold a project, or write config files. Agent wording alone never
triggers. Only exchanges that pass go to the classifier model, which lists the
decisions in it (often none), picks a target from the routing table, and
checks existing ADRs and backlog notes for duplicates.

## Development

```bash
git clone https://github.com/stevo-knievo/adr-recorder.git
cd adr-recorder
npm install
npm run check              # typecheck, lint, tests
./bin/adr-recorder.js help # the CLI from the clone
```

See `AGENTS.md` for the code rules and `docs/extending.md` to add an agent or
a terminal host.
