# Mandatory worker isolation

Symphony Workers must always run as Pi agents inside Docker Sandboxes and per-issue git worktrees. This deliberately removes insecure local/shared-workspace modes: the Host Orchestrator may poll Linear and supervise processes on the host, but all agent execution and repository mutation must occur inside the Docker Sandbox mounted to the issue's dedicated worktree.

## Considered Options

- Allow optional sandbox/worktree isolation for simpler local setup.
- Require Docker Sandbox plus git worktree isolation for every worker.

## Consequences

Local setup is stricter and requires `sbx` plus git worktree support, but future implementation and documentation can assume there is no unsandboxed worker path to secure or explain.
