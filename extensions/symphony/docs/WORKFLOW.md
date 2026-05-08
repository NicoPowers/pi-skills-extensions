---
tracker:
  kind: linear
  project_slug: TEST
polling:
  interval_ms: 1000
workspace:
  root: .symphony_worktrees
  strategy: git-worktree
  base_ref: main
  branch_prefix: agent/
sandbox:
  kind: docker-sbx
  agent: shell
  name_prefix: symphony
agent:
  runner: rpc
  model: anthropic/claude-sonnet-4:high
  command: 'pi --mode rpc {model_arg} --session-dir .symphony/sessions'
---
You are an agent working on {{ issue.identifier }}: {{ issue.title }}
