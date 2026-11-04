# adr-recorder

Decisions made in chat get lost. adr-recorder watches agent coding sessions,
spots when a decision is made, and writes a short note to the project's ADR
backlog. A review step later turns each note into an ADR, a lighter doc (see
`docs/how-to-document.md`), or nothing.

Status: early. Works in pi (live capture, `/adr` commands, review) and as a
CLI over pi session files. Claude Code and Codex adapters are next.

## Install (pi)

Try it once, for one run only:

```bash
pi -e /path/to/adr-recorder/src/pi/index.ts
```

Daily use while developing. It's a local path, so edits apply directly; type
`/reload` in a running session to pick them up:

```bash
pi install /path/to/adr-recorder
```

Shared install from git:

```bash
pi install git:github.com/stevo-knievo/adr-recorder
```

When active, the status line shows `ADR rec ●`, or `ADR rec ● 3` once this
session has three notes.

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

# The CLI talks to an OpenAI-compatible endpoint. Inside pi the recorder uses
# pi's own providers and ignores this block.
model_endpoint:
  base_url: https://api.openai.com/v1
  api_key_env: OPENAI_API_KEY # name of the env var, never the key

auto_review: on # on | ask | off
# How to start the review agent when a session quits. Optional; without it
# the review runs headless in the background. See "Review" below.
review_command: 'if [ -n "$REX_SESSION" ]; then rex run --cwd {cwd} -- "$SHELL" -ic {command}; else {headless}; fi'
enabled_paths: [] # e.g. ["~/code/work/**"], on even without an ADR folder
disabled_paths: [] # always off here, wins over everything but /adr on
```

Recommended models: a flash or mini class model for `classifier_model`
(gpt-5-mini works well and answers in a second or two), and the
strongest model you have for `reviewer_model`. Model ids are `provider/model`
as pi knows them; the CLI drops the provider part when calling the endpoint.

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

`model_endpoint`, `review_command`, and the path lists are only read from your
user file, so a cloned repo can't send transcripts somewhere else or run
commands.

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

### Review

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
its own. A quitting pi can't host it, so it hands off:

- With `review_command` set, that shell command runs. Placeholders: `{cwd}`,
  `{model}`, `{prompt_file}`, `{command}` (an interactive `pi` with the review
  prompt) and `{headless}` (the background run below). The example above opens
  a new Rex block inside Rex and falls back to the background run elsewhere.
- Without it, `pi -p` runs in the background and writes only the report. The
  next pi session in that repo says "ADR review ready: N proposals".

Review agents get `ADR_REVIEW_CHILD=1` and don't record or start reviews of
their own. Each note is auto-reviewed once, even across resumes. Logs and
bookkeeping live in `~/.local/state/adr-recorder/`.

## CLI

```bash
npm install
./bin/adr-recorder.js status                 # layout, config, enablement
./bin/adr-recorder.js scan --dry-run         # what would be recorded
./bin/adr-recorder.js scan                   # write backlog notes
./bin/adr-recorder.js scan --since 2026-11-01 --path ~/code/some/repo
./bin/adr-recorder.js scan --session ~/.pi/agent/sessions/<dir>/<file>.jsonl
```

`scan` finds pi sessions whose working folder is the project or a folder
inside it. Re-running is safe: exchanges that already have a note are
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
npm install
npm run check
```
