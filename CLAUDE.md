# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install       # Install dependencies
npm run build     # Compile TypeScript to dist/
npm test          # Run all tests (Vitest)
npx vitest run tests/orchestrator.test.ts  # Run a single test file
```

CI runs `npm ci && npm run build && npm test` on push to `main` and PRs.

## Architecture

This is a unified Pi package combining **engineering skills** and the **Symphony scheduler**.

### Package layout

```
skills/engineering/                    # discipline skills (see skills/engineering/README.md)
skills/symphony/                       # Symphony operator skill
skills/docker-sandbox/                 # Docker Sandboxes (sbx) reference skill
extensions/symphony/                   # Symphony Pi extension folder
  symphony.ts                          # Pi extension: registers --symphony flag & /symphony-status
  README.md                            # Full Symphony setup and configuration reference
  workflow-templates/                  # Four progressively detailed WORKFLOW.md starter files
  docs/                                # Design docs, ADRs, spec conformance matrix
src/                                   # Symphony TypeScript implementation
  config.ts                            # Parses WORKFLOW.md YAML front matter, applies typed defaults
  linear.ts                            # GraphQL client for Linear (30s timeout, typed error categories)
  orchestrator.ts                      # Core scheduler loop
tests/                                 # Vitest test suite mirroring src/
```

### Symphony orchestrator

The Host Orchestrator (`src/orchestrator.ts`) polls Linear for eligible issues and spawns **Symphony Workers** — Pi RPC subprocesses running inside Docker Sandboxes with per-issue git worktrees. Key invariants enforced at config time:

- `sandbox.kind: docker-sbx` is **mandatory** — host-local workers are rejected (see `docs/symphony/adr/0001-mandatory-worker-isolation.md`)
- `workspace.strategy: git-worktree` is **mandatory**
- `agent.runner: rpc` is **mandatory**

**Linear eligibility**: `Todo` issues require the `Symphony` label; non-Todo active states (e.g., `In Progress`) are dispatched without it. Issues with non-terminal blockers are skipped.

**Worker lifecycle**: clean exit → 1s retry; abnormal exit → exponential backoff capped at `agent.max_retry_backoff_ms`. Dirty worktrees are preserved (Sandcastle safety policy).

**Liquid templates**: `strictVariables` and `strictFilters` are both enabled — unknown variables cause the attempt to fail, not silently render empty.

**Structured logging** uses `event=name key1=val1 key2=val2` format throughout.

### Engineering skills conventions

- Issue tracker is **Linear** (not GitHub Issues unless explicitly noted)
- Planning feedback uses the **Plannotator extension**, not GitHub Issues
- `grill-me` skill pairs with the **pi-interview extension** for interactive Q&A
- Skills follow [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/skills/engineering) conventions

### Required companion packages

Symphony requires these to be installed separately:

```bash
pi install npm:pi-subagents
pi install git:github.com/NicoPowers/pi-linear-tools
```

## Key configuration

- **TypeScript**: strict mode, ES2022 target, NodeNext module resolution
- **Node**: version 22 (`.nvmrc`)
- **Templating**: Liquidjs with `strictVariables` + `strictFilters`
- **Config format**: YAML front matter in `WORKFLOW.md` (see `workflow-templates/` for examples)
