# Changelog

## [Unreleased]

- Claude Code plugin (this repo): hooks record decisions after each reply
  through `model_endpoint`, `/adr` has the same subcommands as in pi, and the
  review starts on quit. `adr-recorder claude-code statusline --wrap` adds the
  note count to an existing status line.
- `adr-recorder scan --harness claude-code` reads `~/.claude/projects`,
  `--harness codex` reads Codex rollouts, `--harness all` reads every agent.
- Codex can run the review, interactive or headless (sandboxed to the repo).
- `agent_models` gives an agent its own reviewer model. Claude Code and Codex
  get the model name without the provider part.
- `agent_commands` (user file only) sets how each agent is started, for
  wrappers.
- The classifier no longer records a question the agent asked as a human
  decision, and skips the `/adr` command turns.
- Only the pi SDK is a peer dependency, and it is optional, so the plugin
  install pulls just `jiti` and `yaml`.

- pi extension: records decisions after each agent run through pi's own
  providers, shows the note count in the status line, and adds `/adr on`,
  `off`, `status`, `note`, `scan` and `review`.
- `/adr review` starts a reviewer sub-agent that proposes where each note
  belongs and writes a review report.
- Auto review on quit, with a notice in the next session after a background
  run. Review agents never record.
- `review_launcher` picks where the review opens: `auto` detects tmux,
  zellij, herdr, Rex, WezTerm or kitty, falling back to a background run.
  `command` runs your own `review_command` template, whose placeholders are
  now shell-quoted (`{model}` and `{prompt_file}` are gone).
- `adr-recorder review` and `adr-recorder launchers`.
- Agents and hosts are plugins behind `HarnessAdapter` and `Launcher`
  (docs/extending.md). `review_harness` picks the reviewing agent.

- `adr-recorder scan` for pi sessions: finds sessions for a project, scores
  each exchange locally, classifies hits with the configured model, and
  writes one backlog note per decision. Safe to re-run.
- `adr-recorder status` shows the resolved layout, config, and enablement.
- ADR folder discovery: repo config, adr-tools, log4brains, common folder
  names (case-insensitive), nested package folders in monorepos.
- Config in `~/.config/adr-recorder/adr-recorder.yaml` plus a per-repo
  `.adr-recorder.yaml`. Models are required.

## [0.0.1] - 2026-11-03

- Repo skeleton. The extension shows `ADR rec ●` in the status line.
