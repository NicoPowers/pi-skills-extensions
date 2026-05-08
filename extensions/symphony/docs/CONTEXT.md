# Pi Symphony

Pi Symphony schedules Linear issues into isolated Pi agent workspaces for secure, automated code work.

## Language

**Symphony Worker**:
A Pi agent process assigned to execute one Linear issue inside mandatory isolation.
_Avoid_: Codex worker, generic agent runtime

**Docker Sandbox**:
A Docker `sbx` microVM boundary that isolates a Symphony Worker from the host filesystem and host process environment.
_Avoid_: Optional sandbox, best-effort sandbox

**Issue Worktree**:
A per-issue git worktree used as the only writable repository checkout for a Symphony Worker.
_Avoid_: workspace folder, shared checkout, raw directory

**Host Orchestrator**:
The long-running Symphony process that polls Linear, creates Issue Worktrees, starts Docker Sandboxes, supervises workers, and records status.
_Avoid_: worker, agent session

**Pi RPC Runner**:
The sandboxed Pi worker mode where the Host Orchestrator controls a `pi --mode rpc` process over JSONL.
_Avoid_: Codex app-server, non-Pi runtime

## Relationships

- A **Host Orchestrator** manages zero or more **Symphony Workers**.
- Each **Symphony Worker** runs inside exactly one **Docker Sandbox**.
- Each **Symphony Worker** works in exactly one **Issue Worktree**.
- A **Pi RPC Runner** is the preferred implementation mechanism for a sandboxed **Symphony Worker**.
- A **Docker Sandbox** mounts only the corresponding **Issue Worktree** as the worker workspace.

## Example dialogue

> **Dev:** "Can a Symphony Worker run directly in the repo if the issue is simple?"
> **Domain expert:** "No. Every Symphony Worker must run through a Docker Sandbox and use its own Issue Worktree. Simplicity does not bypass isolation."

## Flagged ambiguities

- "workspace" previously meant either an arbitrary per-issue folder or a git worktree. Resolved: use **Issue Worktree** for the mandatory writable checkout.
- "sandbox" previously sounded optional. Resolved: use **Docker Sandbox** for the required worker isolation boundary.
