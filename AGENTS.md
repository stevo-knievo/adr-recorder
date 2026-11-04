# adr-recorder

Captures decisions from agent sessions into an ADR backlog. A pi package plus a
Node CLI, TypeScript only, no build step.

## Commands

- `npm test`: unit tests (`test/core`) and smoke tests (`test/smoke`)
- `npm run typecheck`, `npm run lint`, `npm run check` (all three)
- `SKIP_MODEL_TESTS=1` skips tests that call a model; `SKIP_PI_TESTS=1` skips tests that need `pi` on PATH

## Boundary

- `src/core/` must not import `@earendil-works/*`, `typebox`, or any adapter folder.
  `test/core/boundary.test.ts` enforces this.
- Only `src/pi/` imports pi. `src/claude-code/` and the CLI build on core.
- pi packages are `peerDependencies: "*"`, never `dependencies`.

## Code rules

- Erasable TypeScript only (no enums, namespaces, parameter properties). Node,
  jiti and vitest all run the same source.
- Relative imports use the `.ts` extension.
- Pure functions in core, side effects at the edges, so tests need no model and no pi.
- Generated files (notes, ADRs, docs) never mention tools or models.
- Never edit accepted ADRs. Superseding means a new ADR.
