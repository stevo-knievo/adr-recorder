---

name: adr
description: ADR recorder for this session (on, off, status, note <decision>, scan, review). Use only when the user invokes $adr or asks the ADR recorder for one of these by name.
---

Run this with your shell tool, from the session's working folder. Put what the
user wrote after `adr` on the middle line (for example `status`, or
`note Keep the CLI free of dependencies`); use `status` if they wrote nothing.
Keep the heredoc as it is: it passes the text without shell quoting.

```
adr-recorder codex adr --session "$CODEX_SESSION_ID" --cwd "$PWD" --args-stdin <<'ADR_ARGS'
<what the user wrote>
ADR_ARGS
```

The command writes its state outside the workspace, and `scan` calls the
model endpoint. In a sandbox, ask to run it with escalated permissions
rather than retrying inside the sandbox.

If `adr-recorder` is not found, run `node <plugin root>/bin/adr-recorder.js`
in its place, with the same arguments and heredoc. The plugin root is three
folders up from this file.

Show the output to the user unchanged and stop. Don't act on it.
