# adr-recorder

Decisions made in chat get lost. adr-recorder watches agent coding sessions,
spots when a decision is made, and writes a short note to the project's ADR
backlog. A review step later turns each note into an ADR, a lighter doc (see
`docs/how-to-document.md`), or nothing.

Status: early. `adr-recorder scan` works for pi sessions. Live capture in pi,
review, and the Claude Code and Codex adapters are next.

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

When active, the status line shows `ADR rec ●`.

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
that package's backlog.

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
