# adr-recorder

Captures decisions from agent sessions into an ADR backlog. A pi package, a Claude
Code plugin (this repo is both) and a Node CLI. TypeScript only, no build step.

## Commands

- `npm test`: unit tests (`test/core`) and smoke tests (`test/smoke`)
- `npm run typecheck`, `npm run lint`, `npm run check` (all three)
- `SKIP_MODEL_TESTS=1` skips tests that call a model; `SKIP_PI_TESTS=1` skips tests that need `pi` on PATH

## Boundary

- `src/core/` must not import `@earendil-works/*`, `typebox`, or any adapter folder.
  `test/core/boundary.test.ts` enforces this.
- Only `src/pi/` imports pi. `src/claude-code/` and the CLI build on core.
  Adapters never import each other (same test).
- pi packages we import are optional `peerDependencies: "*"`, never
  `dependencies`. Optional, because the Claude Code plugin installs
  production deps from the lockfile and must not pull pi in. Runtime deps stay
  `jiti` and `yaml`.

## Extension points

Open source, so other people add hosts and agents. Keep these small and stable:

- `src/core/harness/`: one file per agent (`HarnessAdapter` = optional
  `SessionSource` + optional `ReviewerAgent`), registered in `index.ts`.
- `src/core/launch/`: one file per terminal host (`Launcher`), registered in
  `index.ts`. Launchers get a `System` for all side effects; tests pass a fake.
- Callers depend on the interfaces and registries, never on a concrete
  harness or launcher. No `if (name === "rex")` outside its own file.
- A new harness or launcher must not need edits to existing ones. See
  `docs/extending.md`; keep it in sync with the interfaces.

## Code rules

- Erasable TypeScript only (no enums, namespaces, parameter properties). Node,
  jiti and vitest all run the same source.
- Relative imports use the `.ts` extension.
- Pure functions in core, side effects at the edges, so tests need no model and no pi.
- Generated files (notes, ADRs, docs) never mention tools or models.
- Never edit accepted ADRs. Superseding means a new ADR.
