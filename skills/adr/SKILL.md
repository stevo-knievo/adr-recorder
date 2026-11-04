---
name: adr
description: ADR recorder for this session. on, off, status, note <decision>, scan, review.
argument-hint: "[on [dir] | off | status | note <decision> | scan | review]"
disable-model-invocation: true
allowed-tools: Bash(adr-recorder claude-code adr *)
---

Run exactly this with the Bash tool, keeping the heredoc as it is (it passes
the arguments without shell quoting):

```
adr-recorder claude-code adr --session "${CLAUDE_SESSION_ID}" --cwd "${CLAUDE_PROJECT_DIR}" --args-stdin <<'ADR_ARGS'
$ARGUMENTS
ADR_ARGS
```

Show the output to the human unchanged and stop. Don't act on it.

If `adr-recorder` is not found, run `node "${CLAUDE_PLUGIN_ROOT}/bin/adr-recorder.js"`
in its place, with the same arguments and heredoc.
