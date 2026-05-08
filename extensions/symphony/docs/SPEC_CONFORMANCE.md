# Symphony Pi-Native Conformance

The **Symphony** scheduler shipped in **`pi-skills-extensions`** is a **Pi-native Symphony scheduler**. It adopts the upstream OpenAI Symphony service ideas for workflow loading, Linear polling, issue eligibility, per-issue workspaces, retries, hooks, reconciliation, cleanup, and operator visibility, but it intentionally does **not** define conformance in terms of the OpenAI Codex app-server protocol.

Instead, **Symphony** treats Pi as the worker runtime. Any model/provider that Pi can run can be used by configuring `agent.model`, for example OpenAI/Codex-family models, Gemini, Kimi, Anthropic/Claude, local/custom providers, or any other Pi-supported model string.

## Compatibility target

The project target is:

1. **Scheduler compatibility** with the portable parts of the Symphony service specification.
2. **Pi-native execution** through Pi worker processes, Pi RPC/SDK sessions, Pi tools, Pi packages, and Pi model routing.
3. **Provider neutrality**: Symphony should not care whether the underlying model is OpenAI, Google, Moonshot/Kimi, Anthropic, local, or custom, as long as Pi can run it.
4. **Observable worker sessions** using Pi-native usage/session data where available.

OpenAI/Codex app-server details are therefore treated as one possible Pi worker backend, not as the architectural center of this package.

## Conformance matrix

| Area | Status | Pi-native contract |
| --- | --- | --- |
| Workflow discovery | Implemented | Uses explicit path from extension command/flag or `WORKFLOW.md` in cwd. |
| YAML front matter parsing | Implemented | Supports optional front matter and rejects non-map YAML. |
| Typed config defaults | Implemented | Applies defaults for tracker, polling, workspace, hooks, agent, and Pi-native fields. |
| `$VAR` resolution | Implemented | Supports explicit `$VAR`; also falls back to `LINEAR_API_KEY` as a documented Pi-native convenience. |
| Relative workspace root | Implemented | Resolves relative to the directory containing `WORKFLOW.md`. |
| Dynamic workflow reload | Implemented | Checks mtime before ticks and keeps last known good config on invalid reload. |
| Strict Liquid prompt rendering | Implemented | Unknown variables/filters fail the affected attempt. `issue` and `attempt` are passed. |
| Linear candidate fetch | Implemented | Uses project `slugId`, active state filtering, labels, blockers, and pagination. |
| Linear terminal fetch | Implemented | Uses pagination and configured project slug. |
| Linear state refresh | Implemented | Uses GraphQL ID filtering and batches large ID sets. |
| Linear network timeout | Implemented | 30s `AbortController` timeout. |
| Linear error categories | Implemented | Transport, HTTP status, GraphQL, malformed payload, and missing cursor categories. |
| Todo blocker rule | Implemented | Skips Todo issues with non-terminal blockers. |
| Todo Symphony label gate | Implemented / Pi-native safety policy | Todo issues require the `Symphony` label by default to opt into automation. Non-Todo active states are dispatchable without the label. |
| Dispatch sort | Implemented | Priority, created time, identifier tie-breaker. |
| Global concurrency | Implemented | Uses `agent.max_concurrent_agents`. |
| Per-state concurrency | Implemented | Uses normalized `agent.max_concurrent_agents_by_state` keys. |
| Retry queue | Implemented | Stores issue id, identifier, attempt, due time, and error. |
| Continuation retry | Implemented | Clean worker exit schedules a 1 second continuation retry. |
| Failure backoff | Implemented | Uses `min(10000 * 2 ** (attempt - 1), agent.max_retry_backoff_ms)`. |
| Workspace sanitization | Implemented | Uses the upstream character policy for deterministic per-issue workspace keys. |
| Workspace root containment | Implemented | Normalizes root/path and rejects escape. |
| Existing workspace reuse | Implemented | Reuses existing directories and rejects non-directories. |
| Hooks | Implemented | Supports `after_create`, `before_run`, `after_run`, `before_remove` with timeout. |
| Hook failure semantics | Implemented | `after_create`/`before_run` are fatal; `after_run`/`before_remove` are best-effort. |
| Issue Worktree isolation | In progress / mandatory | `workspace.strategy: git-worktree` is required. Dirty git worktrees are preserved following Sandcastle-inspired safety policy. |
| Docker Sandbox isolation | In progress / mandatory | `sandbox.kind: docker-sbx` is required. Workers must run via `sbx exec`; host-local workers are rejected. |
| Reconciliation terminal cleanup | Implemented | Stops worker and cleans/preserves workspace according to safety policy. |
| Reconciliation non-active state | Implemented | Stops worker without workspace cleanup. |
| Process tree termination | Partial | Uses process group kill on POSIX and `taskkill` on Windows; deeper platform testing needed. |
| Stall detection | Partial | Current implementation is process-time based. Better Pi-native tracking should use Pi RPC/SDK events or worker session activity. |
| Structured logging | Implemented | Emits stable `key=value` logs with issue context. |
| Runtime snapshot | Partial | Internal snapshot shape exists for future command/API. |
| Pi model selection | Implemented | `agent.model` is passed to Pi through `{model_arg}` and may reference any Pi-supported provider/model. |
| Pi RPC worker command templating | In progress | `agent.command` must invoke `pi --mode rpc` and supports `{model}` and `{model_arg}`. |
| Pi token/cost usage tracking | Planned / Pi-native | Pi exposes session usage through RPC `get_session_stats`, assistant message usage, session files, and context usage helpers. Symphony does not yet collect those stats from worker subprocesses. |
| Pi session-aware worker runner | Missing / Recommended | Current workers are one-shot Pi subprocesses. A future runner should use Pi RPC or SDK sessions to observe lifecycle events, token usage, cost, context usage, and continuation turns. |
| HTTP dashboard/API | Missing / Deferred | Not required for Pi-native scheduler correctness. Internal snapshot is designed to support this later. |
| Durable retry/session persistence | Missing / Deferred | Scheduler state is in memory and recovers from Linear/filesystem after restart. |
| SSH worker extension | Missing / Deferred | Out of scope. |

## Pi-native worker contract

A workflow selects the worker model through Pi, not through a Codex-specific app-server schema. Workers must run through Pi RPC inside Docker Sandbox isolation and a dedicated Issue Worktree:

```yaml
workspace:
  root: .symphony_worktrees
  strategy: git-worktree
  base_ref: main
  branch_prefix: agent/
sandbox:
  kind: docker-sbx
agent:
  runner: rpc
  model: anthropic/claude-sonnet-4:high
  command: 'pi --mode rpc {model_arg} --session-dir .symphony/sessions'
```

The same contract can route to any model Pi knows how to run:

```yaml
agent:
  model: google/gemini-3-pro
```

```yaml
agent:
  model: openai/gpt-5.1-codex
```

```yaml
agent:
  model: kimi/k2
```

The exact model identifiers depend on the user’s Pi model/provider configuration. Symphony should pass the selected model through and avoid provider-specific assumptions.

## Token usage and cost tracking

Yes: Pi has native usage surfaces that Symphony can use, but this package does **not yet collect them from worker runs**.

Useful Pi-native sources include:

- **RPC mode**: `pi --mode rpc` supports `get_session_stats`, which returns token totals, cost, session id/file, message counts, and context usage.
- **Pi SDK / AgentSession**: a future in-process runner can observe worker lifecycle and usage without shelling out to an opaque subprocess.
- **Extension events**: assistant `message_end` events include message usage/cost when the provider reports it.
- **Session files**: Pi sessions store assistant messages with usage metadata where available.
- **Context usage helper**: `ctx.getContextUsage()` reports current context-window usage for the active model.

Recommended next step: replace or augment the current one-shot `pi -p` worker launch with a Pi RPC/SDK-backed worker runner. That would let Symphony populate runtime snapshots with:

- `session_id`
- turn/message counts
- input/output/cache token totals
- cost
- context-window usage
- latest worker activity timestamp for better stall detection

Provider note: token and cost precision depends on what the selected Pi provider/model reports. When a provider does not return exact usage, Pi may estimate context usage, and Symphony should mark those values as estimated rather than exact.

## Intentional Pi-native divergence from the OpenAI spec

The upstream OpenAI Symphony spec assumes a Codex app-server subprocess and Codex-specific thread/turn events. **Symphony** intentionally generalizes that layer:

- `agent.command` launches Pi RPC workers through `sbx exec`.
- `agent.model` selects any Pi-supported model/provider.
- Worker tools come from Pi packages such as `pi-subagents` and `pi-linear-tools`.
- Observability should come from Pi RPC/SDK/session usage rather than Codex-only events.

This keeps Symphony useful across OpenAI, Gemini, Kimi, Anthropic, local, and custom models while preserving the scheduler/workspace/tracker behavior that makes Symphony valuable.

## Remaining Pi-native action items

1. Add the mandatory Pi RPC worker runner for session-aware sandboxed execution.
2. Capture Pi session stats after each worker turn/run.
3. Add token/cost/context usage to `getRuntimeSnapshot()`.
4. Use Pi worker events/session activity for stall detection instead of process age alone.
5. Optionally expose the internal snapshot through `/symphony-status` or an HTTP API.
6. Keep the current shell-command runner as a simple compatibility mode for custom workflows.
