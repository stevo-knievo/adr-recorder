# Changelog

## [Unreleased]

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
