# pi-skills-extensions

Public Pi package for **engineering skills**, the **Symphony** Linear orchestrator (Pi-native scheduler), **prompts**, and **themes**. Install once globally with the Pi CLI; Pi discovers `extensions/`, `skills/`, `prompts/`, and `themes/` from the installed package.

> [!WARNING]
> Symphony is experimental and has not been tested in production. Use only in isolated, disposable environments until you have validated security and operational behavior for your workflow.

Symphony follows the portable OpenAI [Symphony service specification](https://github.com/openai/symphony/blob/main/SPEC.md) ideas for scheduling, Linear polling, per-issue workspaces, retries, hooks, and cleanup, but runs Pi agents through **Docker Sandbox** isolation and **git worktrees** instead of the upstream Codex app-server protocol. See [`docs/symphony/SPEC_CONFORMANCE.md`](docs/symphony/SPEC_CONFORMANCE.md) for the conformance matrix.

## Repository layout

```
extensions/           ← Pi extensions (includes Symphony entrypoint)
skills/               ← skill dirs (each needs a SKILL.md)
prompts/              ← prompt templates
themes/               ← JSON themes
workflow-templates/   ← starter WORKFLOW.md templates for Linear + Symphony
src/                  ← Symphony scheduler implementation (TypeScript)
tests/                ← Vitest suite for Symphony
docs/symphony/        ← Symphony documentation (spec conformance, repo notes)
```

## Install (global)

Install this package (skills + Symphony extension):

```bash
pi install https://github.com/NicoPowers/pi-skills-extensions
```

Pin a release or commit:

```bash
pi install https://github.com/NicoPowers/pi-skills-extensions@v2.0.0
```

Equivalent Git source form:

```bash
pi install git:github.com/NicoPowers/pi-skills-extensions
```

Project-local install (package under `.pi/git/` in the repo you run Pi from):

```bash
pi install https://github.com/NicoPowers/pi-skills-extensions -l
```

After install, use `pi list` and `pi config` to confirm or toggle package resources.

## Symphony — required companion packages

Symphony expects you to install the worker tooling packages separately:

```bash
pi install npm:pi-subagents
pi install git:github.com/NicoPowers/pi-linear-tools
```

- **pi-subagents** — delegate planning, review, implementation, and context-building work.
- **pi-linear-tools** — update Linear issues, comments, projects, and milestones from agents.

## Symphony — Linear setup

Configure Linear tools **before** starting Symphony (workers run non-interactively):

```text
/linear-tools-config
```

Optional non-interactive setup:

```text
/linear-tools-config --api-key lin_xxx
/linear-tools-config --default-team ENG
/linear-tools-config --team ENG --project "My Project"
/linear-tools-config --allow-overwrite-files true
```

## Symphony — Linear label opt-in

To avoid grabbing every Todo issue in a Linear project, Symphony only dispatches `Todo` issues that carry the **`Symphony`** label.

- `Todo` without `Symphony`: skipped.
- `Todo` with `Symphony` and no active blockers: dispatchable.
- Non-Todo active states (for example `In Progress`): dispatchable without the label, subject to blocker/concurrency rules.

Labels are normalized to lowercase internally (`Symphony`, `symphony`, `SYMPHONY` match).

## Symphony — create `WORKFLOW.md`

Copy a template from [`workflow-templates/`](workflow-templates/):

- [`01-basic-linear.WORKFLOW.md`](workflow-templates/01-basic-linear.WORKFLOW.md)
- [`02-git-worktree.WORKFLOW.md`](workflow-templates/02-git-worktree.WORKFLOW.md)
- [`03-subagent-review-loop.WORKFLOW.md`](workflow-templates/03-subagent-review-loop.WORKFLOW.md)
- [`04-docker-sbx-sandbox.WORKFLOW.md`](workflow-templates/04-docker-sbx-sandbox.WORKFLOW.md)

Place `WORKFLOW.md` in the repository you want Symphony to operate on (or pass an explicit path to `/symphony`).

### Workflow notes (Pi-native)

Supported combinations in this package:

- `workspace.strategy` must be **`git-worktree`**.
- `sandbox.kind` must be **`docker-sbx`**.
- `agent.runner` must be **`rpc`** (Symphony talks to `pi --mode rpc` over JSONL).

Template placeholders:

- `{model}` — raw configured model string.
- `{model_arg}` — expands to `--model '<agent.model>'` when set, otherwise empty.

Worker/hook environment variables include `SYMPHONY_PROMPT`, `SYMPHONY_ISSUE_ID`, `SYMPHONY_ISSUE_IDENTIFIER`, `SYMPHONY_ISSUE_TITLE`, and `SYMPHONY_AGENT_MODEL`.

### Model selection

Set the parent worker model under `agent.model` in `WORKFLOW.md`. Child subagents can override models per task via `subagent({ model: "..." })`.

### Mandatory Docker Sandbox isolation

Docker Sandboxes (`sbx`) wrap each Symphony worker in an isolated microVM. **Symphony refuses to start workers without Docker Sandbox isolation.**

Install the `sbx` CLI using Docker’s Early Access docs, run `sbx login`, then configure `sandbox.kind: docker-sbx` in `WORKFLOW.md`. Sandboxes combine with git worktrees: the sandbox protects the host; the Issue Worktree isolates concurrent repo changes.

### Mandatory git worktree isolation

Symphony creates or reuses a dedicated git worktree per Linear issue (`workspace.strategy: git-worktree`). Dirty worktrees are preserved with logged cleanup commands so uncommitted work is not silently destroyed.

### Retry behavior

- Clean worker exit schedules a short continuation retry so the scheduler can re-check Linear state.
- Abnormal exits use exponential backoff capped by `agent.max_retry_backoff_ms`.

### Run Symphony

Export `LINEAR_API_KEY` and start Pi with the Symphony flag (from a directory containing `WORKFLOW.md`):

```bash
export LINEAR_API_KEY="lin_api_..."
pi --symphony
```

Without a global install:

```bash
LINEAR_API_KEY="lin_api_..." pi -e https://github.com/NicoPowers/pi-skills-extensions --symphony
```

Use `/symphony [path/to/WORKFLOW.md]` or `/symphony-status` inside Pi for explicit control.

### Known limitations

- Does not implement the Codex app-server stdio protocol.
- RPC session usage collection is still maturing in status surfaces.
- Requires Docker `sbx` CLI availability and login.
- Stall detection is partly process-time based until richer RPC activity wiring lands.
- HTTP dashboard/API deferred; `/symphony-status` is the near-term operator surface.
- Retry/session state is in-memory and not restored across daemon restarts.

Additional detail: [`docs/symphony/SPEC_CONFORMANCE.md`](docs/symphony/SPEC_CONFORMANCE.md).

## Usage

```bash
pi            # extensions + skills load per your Pi config
/reload       # pick up changes without restarting
```

## Updates

```bash
pi update https://github.com/NicoPowers/pi-skills-extensions
```

Or `pi update` to refresh Pi and all non-pinned packages.

## Migrating from standalone `pi-symphony`

Symphony now ships inside **`pi-skills-extensions`** (v2 onward). Remove any Pi setting that points at `git:github.com/NicoPowers/pi-symphony` and install this repository instead using the commands above. Runtime behavior aligns with the historical standalone package (`extensions/symphony.ts`, shared scheduler sources).

## Developing this package

```bash
npm install
npm run build   # TypeScript compile (see tsconfig.json / dist/)
npm test        # Vitest
```

Symphony sources live under `extensions/symphony.ts` and `src/`. CI runs `npm ci`, `npm run build`, and `npm test` on each push and pull request to `main`.
