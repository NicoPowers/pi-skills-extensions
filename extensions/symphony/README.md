# Symphony

Symphony is a Pi-native Linear issue orchestrator. A long-running **Host Orchestrator** polls your Linear project, creates an isolated **git Issue Worktree** and **Docker Sandbox** per eligible issue, and supervises a **Pi RPC worker** inside each sandbox until the issue reaches a terminal state.

> [!WARNING]
> Symphony is experimental and has not been tested in production. Use only in isolated, disposable environments until you have validated security and operational behavior for your workflow.

See [`docs/SPEC_CONFORMANCE.md`](docs/SPEC_CONFORMANCE.md) for the full conformance matrix.  
See [`docs/CONTEXT.md`](docs/CONTEXT.md) for canonical terminology.  
See [`docs/adr/`](docs/adr/) for architecture decisions.

---

## Prerequisites

### 1. Docker Sandboxes (`sbx`)

Every Symphony worker runs inside a Docker microVM. Install and authenticate `sbx` before starting Symphony.

```bash
# macOS
brew install docker/tap/sbx && sbx login

# Windows
winget install -h Docker.sbx
sbx login

# Linux (Ubuntu)
curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh
sudo apt-get install docker-sbx
sudo usermod -aG kvm $USER && newgrp kvm
sbx login
```

### 2. Pi worker tooling packages

```bash
pi install npm:pi-subagents
pi install git:github.com/NicoPowers/pi-linear-tools
```

- **pi-subagents** — delegate planning, review, and implementation to subagents.
- **pi-linear-tools** — update Linear issues, comments, and states from inside workers.

### 3. Linear tools configuration

Workers run non-interactively, so configure Linear tools once before starting Symphony:

```text
/linear-tools-config
```

Optional non-interactive flags:

```text
/linear-tools-config --api-key lin_xxx
/linear-tools-config --default-team ENG
/linear-tools-config --team ENG --project "My Project"
/linear-tools-config --allow-overwrite-files true
```

### 4. `LINEAR_API_KEY`

```bash
export LINEAR_API_KEY="lin_api_..."
```

---

## Quick start

1. Copy a template from [`workflow-templates/`](workflow-templates/) into your project root as `WORKFLOW.md`.
2. Set `tracker.project_slug` to your Linear project's slug.
3. Start Symphony from that directory:

```bash
export LINEAR_API_KEY="lin_api_..."
pi --symphony
```

Label a `Todo` issue in your Linear project with **`Symphony`** and Symphony will dispatch it.

---

## WORKFLOW.md configuration reference

`WORKFLOW.md` is a YAML front matter block followed by a [Liquid](https://liquidjs.com/) prompt template. The front matter configures the scheduler; the template body is rendered per issue and passed to each worker as its initial prompt.

### Full schema with defaults

```yaml
---
# ── Tracker ──────────────────────────────────────────────────────────────────
tracker:
  kind: linear                          # required; only "linear" is supported
  project_slug: YOUR_PROJECT_SLUG       # required; Linear project slug (e.g. "ENG")
  api_key: $LINEAR_API_KEY              # optional; defaults to LINEAR_API_KEY env var
  active_states: [Todo, In Progress]    # states to poll for eligible issues
  terminal_states: [Done, Cancelled, Canceled, Closed, Duplicate]

# ── Polling ───────────────────────────────────────────────────────────────────
polling:
  interval_ms: 30000                    # how often to poll Linear (ms)

# ── Workspace ─────────────────────────────────────────────────────────────────
workspace:
  root: .symphony_worktrees             # directory for git worktrees (relative to WORKFLOW.md)
  strategy: git-worktree                # required; must be "git-worktree"
  base_ref: main                        # branch or commit to base new worktrees on
  branch_prefix: agent/                 # prefix for per-issue branches

# ── Hooks ─────────────────────────────────────────────────────────────────────
hooks:
  timeout_ms: 60000                     # max time any single hook may run (ms)
  after_create: ./scripts/setup.sh      # runs once after worktree + sandbox are created
  before_run: npm install               # runs before each worker attempt
  after_run: ./scripts/notify.sh        # runs after each worker attempt (best-effort)
  before_remove: ./scripts/cleanup.sh   # runs before worktree removal (best-effort)

# ── Agent ─────────────────────────────────────────────────────────────────────
agent:
  runner: rpc                           # required; must be "rpc"
  command: 'pi --mode rpc {model_arg} --session-dir .symphony/sessions'
  model: anthropic/claude-sonnet-4:high # default model; any Pi-supported provider/model
  model_labels:                         # label → model overrides (label names are lowercased)
    opus:   anthropic/claude-opus-4-7   # e.g. add "Opus" label in Linear for hard issues
    sonnet: anthropic/claude-sonnet-4-6
    haiku:  anthropic/claude-haiku-4-5-20251001
  max_concurrent_agents: 2             # global worker concurrency cap
  max_turns: 20                        # max turns per worker attempt
  max_retry_backoff_ms: 300000         # cap on exponential backoff between retries
  max_concurrent_agents_by_state:      # per-state concurrency caps
    "In Progress": 1

# ── Sandbox ───────────────────────────────────────────────────────────────────
sandbox:
  kind: docker-sbx                      # required; must be "docker-sbx"
  agent: shell                          # sbx agent type (use "shell" for Pi RPC workers)
  name_prefix: symphony                 # prefix for sbx sandbox names (for sbx ls filtering)
  template: pi-symphony-worker:v1       # optional: pre-built image with Pi + extensions baked in
  kits: []                              # optional: list of kit paths/refs applied at creation
  cpus: 0                               # optional: CPU limit (0 = unlimited)
  memory: 8g                            # optional: memory limit
  remove_on_terminal: true             # delete sandbox when issue reaches terminal state
  setup: |                              # optional: runs inside sandbox after creation (idempotent)
    npm install

# ── Eligibility ───────────────────────────────────────────────────────────────
eligibility:
  todo_required_label: symphony         # label required on Todo issues to opt into dispatch
---

You are a Symphony worker handling {{ issue.identifier }} — {{ issue.title }}.

{% if attempt %}This is retry/continuation attempt {{ attempt }}.{% endif %}

Issue URL: {{ issue.url }}
Priority: {{ issue.priority }}
Labels: {{ issue.labels | join: ", " }}
State: {{ issue.state }}

Description:
{{ issue.description }}

Use pi-linear-tools to update Linear. When complete, comment with a summary and move the issue to the appropriate state.
```

### Liquid template variables

| Variable | Type | Description |
|---|---|---|
| `issue.identifier` | string | Linear issue identifier (e.g. `ENG-42`) |
| `issue.title` | string | Issue title |
| `issue.description` | string \| null | Issue description body |
| `issue.state` | string | Current workflow state name |
| `issue.labels` | string[] | Lowercase label names |
| `issue.priority` | number \| null | 1 = Urgent, 2 = High, 3 = Medium, 4 = Low |
| `issue.url` | string \| null | Linear issue URL |
| `attempt` | number \| null | Retry attempt number (null on first run) |

Unknown variables and filters throw an error and fail the attempt (`strictVariables` + `strictFilters` are on).

### Agent command template placeholders

| Placeholder | Expands to |
|---|---|
| `{model_arg}` | `--provider '<provider>' --model '<model>'` when provider is present (e.g. `anthropic/claude-sonnet-4:high` → `--provider anthropic --model claude-sonnet-4:high`); `--model '<model>'` when no provider prefix; empty when no model |
| `{model}` | Model portion only (after `/`), or empty |
| `{provider}` | Provider prefix (before `/`), or empty |
| `{provider_arg}` | `--provider '<provider>'` when provider is present, otherwise empty |

---

## Linear label system

### Symphony dispatch gate

`Todo` issues require the **`Symphony`** label before dispatch. Without it they are skipped. Non-Todo active states (e.g. `In Progress`) are dispatched without the label, subject to concurrency rules.

Labels are normalized to lowercase — `Symphony`, `SYMPHONY`, and `symphony` all match.

### Model labels (`agent.model_labels`)

Assign different models to issues based on difficulty by adding a label in Linear. The first matching label wins (labels are matched in the order they appear on the issue).

```yaml
agent:
  model: anthropic/claude-haiku-4-5-20251001   # default — fast, cheap
  model_labels:
    sonnet: anthropic/claude-sonnet-4-6         # medium complexity
    opus:   anthropic/claude-opus-4-7           # hard / open-ended
```

Label names in `model_labels` are compared case-insensitively. Add an `Opus` label in Linear on any issue to route it to the Opus model.

---

## Hooks

All hooks run as bash commands in the issue's worktree directory (`cwd = worktree path`). Fatal hooks (`after_create`, `before_run`) abort the attempt on failure. Best-effort hooks (`after_run`, `before_remove`) log failures but do not abort.

### Hook environment variables

| Variable | Value |
|---|---|
| `SYMPHONY_ISSUE_ID` | Linear issue identifier (e.g. `ENG-42`) |
| `SYMPHONY_ISSUE_IDENTIFIER` | Same as above |
| `SYMPHONY_ISSUE_TITLE` | Issue title |
| `SYMPHONY_ISSUE_LABELS` | Comma-separated lowercase label names |
| `SYMPHONY_AGENT_MODEL` | Resolved model string (after `model_labels` override) |
| `SYMPHONY_PROMPT` | Rendered prompt (set on `before_run`/`after_run` only) |

### Skill routing via `after_create`

Use `SYMPHONY_ISSUE_LABELS` in `after_create` to inject role-specific skills into the worktree. Pi loads skills from `.claude/skills/` inside the workspace.

```bash
#!/usr/bin/env bash
# hooks/setup-worker.sh
set -euo pipefail
mkdir -p .claude/skills

if echo "$SYMPHONY_ISSUE_LABELS" | grep -qi "qa"; then
  cp -r /path/to/skills/qa/. .claude/skills/
elif echo "$SYMPHONY_ISSUE_LABELS" | grep -qi "infra"; then
  cp -r /path/to/skills/infra/. .claude/skills/
else
  cp -r /path/to/skills/coding/. .claude/skills/
fi
```

```yaml
hooks:
  after_create: ./hooks/setup-worker.sh
```

Add `.claude/skills/` to `.gitignore` so injected skills don't land in commits.

---

## Sandbox options

### Worker images

All worker images are **Linux** regardless of your host OS. `sbx` runs Linux microVMs on every platform (Hyper-V/WSL2 on Windows, Virtualization.framework on macOS, KVM on Linux). You always write a Linux Dockerfile.

Dockerfiles live in [`docker/`](docker/):

| File | Purpose |
|---|---|
| `Dockerfile.base` | Pi + all extensions — shared foundation |
| `Dockerfile.coding` | Extends base — for implementation/coding issues |
| `Dockerfile.qa` | Extends base — for QA/review/triage issues |
| `build.sh` | Builds all images and loads them into sbx |

**Build and load:**
```bash
cd extensions/symphony/docker
./build.sh
```

**Wire into WORKFLOW.md per agent role:**
```yaml
# coding agent
sandbox:
  kind: docker-sbx
  agent: shell
  template: pi-symphony-coding:v1

# QA agent (separate QA.WORKFLOW.md)
sandbox:
  kind: docker-sbx
  agent: shell
  template: pi-symphony-qa:v1
```

**Windows path mapping (verified on sbx v0.28.3)**: sbx mounts your Windows workspace into the Linux VM with drive letters lowercased at the root:

| Windows host path | Linux path inside sandbox |
|---|---|
| `C:\Users\nicol\project` | `/c/Users/nicol/project` |
| `D:\work\repo` | `/d/work/repo` |

`sbx create` accepts Windows paths for the initial mount. `sbx exec -w` requires the Linux path — Symphony translates this automatically via `toSandboxPath()` in `src/orchestrator.ts`. No action needed in your workflow config.

### Reusable base images (templates)

Build a template image with Pi and extensions pre-installed so every new sandbox boots instantly without re-installing:

```bash
# Build once
sbx run shell --name pi-base
sbx exec pi-base -- bash -lc "
  # install Pi + extensions inside the VM
  pi install npm:pi-subagents
  pi install git:github.com/NicoPowers/pi-linear-tools
"
sbx template save pi-base pi-symphony-worker:v1
sbx rm pi-base
```

```yaml
sandbox:
  kind: docker-sbx
  agent: shell
  template: pi-symphony-worker:v1
```

### Kits

Kits inject credentials, network allowlists, files, and startup commands at sandbox creation time. Useful for adding API keys or role-specific tooling on top of a shared base template.

```yaml
sandbox:
  template: pi-symphony-worker:v1
  kits:
    - ./kits/linear-credentials/
    - ./kits/qa-tools/
```

See the [docker-sandbox skill](../../skills/docker-sandbox/SKILL.md) for the full kit YAML schema.

### `sandbox.setup`

A bash snippet run inside the sandbox after creation. Use for dynamic setup that can't be baked into a template. Must be idempotent since it can run on sandbox reuse.

```yaml
sandbox:
  setup: |
    set -euo pipefail
    npm install
```

---

## Credential Setup

Symphony automatically injects API credentials into each sandbox using sbx's credential proxy. The proxy intercepts outbound HTTP requests and adds the real key as an HTTP header — the key **never enters the VM**.

### 1. Set API keys on the host

```bash
# Using sbx secret store (interactive prompt, persists across launches)
sbx secret set -g anthropic    # sets ANTHROPIC_API_KEY
sbx secret set -g openai       # sets OPENAI_API_KEY

# Or export directly before starting Symphony
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GEMINI_API_KEY="..."
```

### 2. Set models in WORKFLOW.md

Symphony reads the provider prefix from every model string and auto-applies the matching credential kit. No extra config is needed:

```yaml
agent:
  model: anthropic/claude-sonnet-4:high   # → applies anthropic kit automatically
  model_labels:
    opus: anthropic/claude-opus-4-7       # → same anthropic kit
    fast: groq/llama-3.1-8b-instant      # → applies groq kit automatically
```

### Supported providers

| Provider | Kit auto-detected via | Env var | API domain |
|---|---|---|---|
| `anthropic` | `anthropic/...` model strings | `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| `openai` | `openai/...` | `OPENAI_API_KEY` | `api.openai.com` |
| `azure-openai-responses` | `azure-openai-responses/...` | `AZURE_OPENAI_API_KEY` | `*.openai.azure.com` |
| `google` | `google/...` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `*.googleapis.com` |
| `deepseek` | `deepseek/...` | `DEEPSEEK_API_KEY` | `api.deepseek.com` |
| `mistral` | `mistral/...` | `MISTRAL_API_KEY` | `api.mistral.ai` |
| `groq` | `groq/...` | `GROQ_API_KEY` | `api.groq.com` |
| `cerebras` | `cerebras/...` | `CEREBRAS_API_KEY` | `api.cerebras.ai` |
| `xai` | `xai/...` | `XAI_API_KEY` | `api.x.ai` |
| `openrouter` | `openrouter/...` | `OPENROUTER_API_KEY` | `openrouter.ai` |
| `cloudflare-ai-gateway` | `cloudflare-ai-gateway/...` | `CLOUDFLARE_API_KEY` | `*.cloudflare.com` |
| `cloudflare-workers-ai` | `cloudflare-workers-ai/...` | `CLOUDFLARE_API_KEY` | `api.cloudflare.com` |
| `vercel-ai-gateway` | `vercel-ai-gateway/...` | `AI_GATEWAY_API_KEY` | `gateway.vercel.com` |
| `minimax` | `minimax/...` | `MINIMAX_API_KEY` | `api.minimax.chat` |
| `kimi-coding` | `kimi-coding/...` | `KIMI_API_KEY` | `api.moonshot.cn` |

### Explicit provider override

Use `sandbox.credential_providers` to force-include providers that aren't detected from model strings:

```yaml
sandbox:
  credential_providers: [anthropic, openai]   # always inject these, regardless of model strings
```

### Custom providers

Drop a `spec.yaml` into `extensions/symphony/kits/providers/<name>/` following the [kit schema](../../skills/docker-sandbox/SKILL.md#kit-schema-reference). It will be auto-applied whenever `<name>/` appears as the prefix of any configured model string.

---

## Running Symphony

### From a directory containing `WORKFLOW.md`

```bash
export LINEAR_API_KEY="lin_api_..."
pi --symphony
```

### Explicit workflow path

```bash
pi --symphony
# then inside Pi:
/symphony path/to/WORKFLOW.md
```

### Without a global install

```bash
LINEAR_API_KEY="lin_api_..." pi -e https://github.com/NicoPowers/pi-skills-extensions --symphony
```

### Monitor running workers

```text
/symphony-status
```

Shows: running workers, retry queue, per-worker attempt/model/context usage, last activity, recent errors.

---

## Security contract

These are enforced at startup — Symphony refuses to run without them:

- `sandbox.kind: docker-sbx` — mandatory; host-local workers are rejected.
- `workspace.strategy: git-worktree` — mandatory; shared checkouts are rejected.
- `agent.runner: rpc` — mandatory; non-Pi worker runtimes are rejected.

Dirty Issue Worktrees are **preserved** on terminal cleanup with a logged `git worktree remove` command for manual review. Uncommitted work is never silently deleted.

Worker agents have full privileges inside the VM (`sudo`, Docker, read-write workspace) but cannot reach the host filesystem, host Docker daemon, or other sandboxes. Credential values never enter the VM — they are injected as HTTP headers by the host-side proxy.

---

## Retry behavior

| Exit condition | Next action |
|---|---|
| Clean exit | 1-second continuation retry (re-check Linear state) |
| Abnormal exit (non-zero) | Exponential backoff: `min(10000 × 2^(attempt-1), max_retry_backoff_ms)` |

---

## Workflow templates

Ready-to-use templates are in [`workflow-templates/`](workflow-templates/):

| Template | Use case |
|---|---|
| [`01-basic-linear.WORKFLOW.md`](workflow-templates/01-basic-linear.WORKFLOW.md) | Minimal starting point |
| [`02-git-worktree.WORKFLOW.md`](workflow-templates/02-git-worktree.WORKFLOW.md) | Worktree-focused with `before_run` hook |
| [`03-subagent-review-loop.WORKFLOW.md`](workflow-templates/03-subagent-review-loop.WORKFLOW.md) | Multi-reviewer subagent loop |
| [`04-docker-sbx-sandbox.WORKFLOW.md`](workflow-templates/04-docker-sbx-sandbox.WORKFLOW.md) | Full sandbox options annotated |

---

## Known limitations

- Requires `sbx` CLI installed and `sbx login` completed before starting.
- Retry/session state is in-memory; not restored across daemon restarts.
- Stall detection is process-time based until richer Pi RPC activity wiring lands.
- HTTP dashboard/API deferred; `/symphony-status` is the current operator surface.
- Process tree termination on Windows uses `taskkill`; deeper testing needed.
- Pi RPC session usage collection (token counts, cost) is still maturing.
