---
name: docker-sandbox
description: Reference and workflow for Docker Sandboxes (sbx). Covers architecture, CLI, kits, templates, security model, network policy, and troubleshooting. Use when working with sbx, configuring Symphony sandboxes, or debugging sandbox issues.
---

# Docker Sandboxes

Docker Sandboxes run AI coding agents inside isolated microVMs. Each sandbox has its own kernel, Docker daemon, image cache, filesystem, and network — fully separated from the host and from other sandboxes.

## Install & Login

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

Login is required — it ties sandboxes to a verified identity for governance. Disable telemetry with `export SBX_NO_TELEMETRY=1`.

## Core CLI

```bash
# Launch agent in cwd
sbx run claude

# Launch in a specific directory
sbx run claude ~/my-project

# Named sandbox with an initial prompt
sbx run claude --name my-sandbox -- "Add error handling to the login function"

# Pipe a prompt from a file
sbx run claude -- "$(cat prompt.txt)"

# Append any Claude Code flags after --
sbx run claude -- --model claude-opus-4

# Stop agent (VM stays alive — env persists)
sbx stop <sandbox>

# Resume a stopped sandbox
sbx run claude --name <sandbox>

# Permanently delete VM and all contents
sbx rm <sandbox>

# List sandboxes
sbx ls

# Run a command inside a sandbox
sbx exec <sandbox> -- bash -c "which node"

# Diagnose installation issues
sbx diagnose

# Nuclear reset (stops all VMs, clears sandbox data)
sbx reset
```

## Architecture

- **Workspace**: mounted at the same absolute path as on the host — file changes are instant, no sync needed. The agent sees the exact same directory structure you do.
- **Networking**: all outbound traffic routes through an HTTP/HTTPS proxy on the host. Raw TCP, UDP, and ICMP are blocked. Default policy is deny-by-default with some broad wildcards (e.g. `*.googleapis.com`) — audit with `sbx policy ls`.
- **Credentials**: API keys are injected into HTTP headers by the host-side proxy. The credential value never enters the VM.
- **Persistence**: stopping an agent (`sbx stop`) preserves the VM — environment setup (installed packages, Docker layers) carries over on restart. Only `sbx rm` destroys it.
- **Storage**: each VM allocates disk independently for its image, Docker layers, containers, and volumes. Default Docker volume is 50 GB (sparse). Override: `DOCKER_SANDBOXES_DOCKER_SIZE=10g sbx run claude`.

## Security Model

Four isolation layers:
1. **Hypervisor** — separate kernel per sandbox, no shared memory or processes with host
2. **Network** — HTTP/HTTPS only through host proxy; non-HTTP protocols blocked
3. **Docker engine** — each sandbox has its own isolated Docker daemon
4. **Credentials** — injected by proxy, never stored in VM

Inside the VM the agent has full privileges: `sudo`, package installation, a private Docker engine, and read-write workspace access.

**Workspace trust warning**: the agent edits the same files on your host, including Git hooks, CI config, and build files. Review modifications before running any code, as these files execute implicitly during normal development.

Review and restrict network policies:
```bash
sbx policy ls
sbx policy allow network "*.npmjs.org,*.pypi.org"
sbx policy allow network "**"          # unrestricted (use with caution)
sbx policy log                          # inspect blocked/proxied requests
```

## Credential Setup

```bash
# Store Anthropic key globally
sbx secret set -g anthropic

# Or via env var before launch
export ANTHROPIC_API_KEY="sk-..."
sbx run claude
```

For credentials outside the built-in services, write exports inside the sandbox:
```bash
sbx exec <sandbox> -- bash -c 'echo "export MY_KEY=value" >> /etc/sandbox-persistent.sh'
```

## Configuration Limitations

Sandboxes ignore user-level host config (e.g. `~/.claude`). Only project-level configuration inside the working directory is accessible. Collocate `CLAUDE.md`, `.claude/settings.json`, etc. with the project.

## Kits — Runtime Extension

Kits are YAML artifacts that extend a sandbox at creation time with tools, credentials, network rules, files, and startup commands. Two types:
- **Mixin** — extends an existing agent
- **Agent** — defines a complete agent from scratch

```yaml
# spec.yaml — minimal mixin example
schemaVersion: "1"
kind: mixin
name: ruff-lint
displayName: Ruff Linter
description: Python linting

network:
  allowedDomains:
    - pypi.org
    - files.pythonhosted.org

commands:
  install:
    - command: "uv tool install ruff@latest"
      user: "1000"
```

### Kit schema reference

```yaml
# Credentials block
credentials:
  sources:
    <service-id>:
      env: [MY_API_KEY]
      file:
        path: ~/.config/service/token
        parser: raw          # raw | json | toml | ini
      priority: env-first    # env-first | file-first

# Network block
network:
  allowedDomains: ["api.example.com"]
  serviceDomains:
    api.example.com: my-service
  serviceAuth:
    my-service:
      headerName: Authorization
      valueFormat: "Bearer %s"

# Proxy-managed env var (agent gets placeholder; proxy replaces with real value)
environment:
  variables:
    MY_API_KEY: placeholder
  proxyManaged: [MY_API_KEY]

# Commands block
commands:
  install:                   # runs once at creation
    - command: "apt-get install -y jq"
      user: "0"
  startup:                   # runs each boot
    - command: ["./start-daemon.sh"]
      user: "1000"
      background: true
  initFiles:                 # written at startup with var substitution
    - path: /home/agent/.config/tool/config.json
      content: '{"workdir": "${WORKDIR}"}'
      mode: "0644"
      onlyIfMissing: true

# Agent kit only
agent:
  image: "registry/image:tag"
  persistence: persistent    # persistent | ephemeral
  entrypoint:
    run: ["pi", "--mode", "rpc"]
    args: ["--session-dir", ".sessions"]

# Static files (in kit directory)
# files/home/  → /home/agent/
# files/workspace/ → workspace root
```

### Credential injection pattern

The canonical 4-block pattern for injecting an API key:
```yaml
network:
  allowedDomains: ["api.example.com"]
  serviceDomains:
    api.example.com: my-service
  serviceAuth:
    my-service:
      headerName: Authorization
      valueFormat: "Bearer %s"
credentials:
  sources:
    my-service:
      env: [MY_SERVICE_API_KEY]
environment:
  proxyManaged: [MY_SERVICE_API_KEY]
```
The agent sends `MY_SERVICE_API_KEY=proxy-managed`; the host proxy substitutes the real key before forwarding.

### Kit CLI

```bash
sbx run claude --kit ./my-kit/
sbx run claude --kit ./my-kit.zip
sbx run claude --kit "git+https://github.com/org/repo.git#ref=v1&dir=my-kit"
sbx run claude --kit ghcr.io/myorg/my-kit:1.0

# Stack multiple kits
sbx run claude --kit ./kit-a --kit ./kit-b

# Apply kit to already-running sandbox (--kit only works at creation)
sbx kit add <sandbox> ./my-kit/

# Validate / inspect / package / publish
sbx kit validate ./my-kit/
sbx kit inspect ./my-kit/ --json
sbx kit pack ./my-kit/ -o my-kit.zip
sbx kit push ./my-kit/ ghcr.io/myorg/my-kit:1.0
sbx kit pull ghcr.io/myorg/my-kit:1.0
```

**Key constraint**: `--kit` only applies when creating a new sandbox. Use `sbx kit add` for running sandboxes.

## Templates — Reusable Base Images

Templates bake tools and packages into a Docker image so setup doesn't repeat each run. Base images: `docker/sandbox-templates:<variant>` where variant is `claude-code`, `claude-code-minimal`, `shell`, `codex`, `copilot`, `cursor-agent`, `docker-agent`, `droid`, `gemini`, `kiro`, `opencode`. Default variants include a full Docker engine; append `-docker` explicitly to opt in, or omit it (default uses `-docker`).

### Dockerfile approach

```dockerfile
FROM docker/sandbox-templates:claude-code
USER root
RUN apt-get update && apt-get install -y protobuf-compiler
USER agent
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
```

```bash
docker build -t my-org/my-template:v1 --push .
sbx run --template my-org/my-template:v1 claude
```

Private templates only work on Docker Hub. For other registries, load via tar:
```bash
docker image save my-org/my-template:v1 -o my-template.tar
sbx template load my-template.tar
```

### Save a running sandbox as a template

```bash
sbx template save <sandbox> my-template:v1
sbx template save <sandbox> my-template:v1 --output my-template.tar
```

Note: agent config files (`.claude/settings.json`) are recreated at launch and don't persist in templates.

### Template CLI

```bash
sbx run --template my-template:v1 claude   # also: -t
sbx template ls
sbx template rm my-template:v1
sbx template load my-template.tar
```

## Windows path mapping

On Windows, sbx mounts drives into the Linux microVM with the drive letter lowercased at the filesystem root — **not** under `/mnt/` like WSL2:

| Windows host path | Linux path inside sandbox |
|---|---|
| `C:\Users\nicol\project` | `/c/Users/nicol/project` |
| `D:\work\repo` | `/d/work/repo` |

Key asymmetry verified on sbx v0.28.3:
- `sbx create shell C:\path\to\workspace` — **accepts** Windows path for mounting
- `sbx exec -w C:\path\to\workspace` — **fails** ("No such file or directory")
- `sbx exec -w /c/path/to/workspace` — **works**

Any tool that drives `sbx exec -w` on Windows must translate the path before passing it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Package install fails | `sbx policy allow network "*.npmjs.org,*.pypi.org"` |
| SSH connection refused | Use IP address rules: `sbx policy allow network "10.1.2.3:22"` |
| Auth failures | `sbx login` to refresh; check `sbx policy log` for PROXY column |
| Clock drift after sleep | `sbx stop <sandbox> && sbx run claude` |
| Docker local exporter fails | Use tar exporter + manual extraction |
| Stale git worktrees | `git worktree remove <path> && git branch -D <branch>` |
| Persistent problem | `sbx reset` (stops all VMs, clears data) |

```bash
# Full diagnostic bundle
sbx diagnose
sbx diagnose --output json
sbx diagnose --upload   # generates shareable diagnostic ID for bug reports

# Inspect blocked requests
sbx policy log

# Manual cleanup if sbx reset fails
# Windows: $env:LOCALAPPDATA\DockerSandboxes
# macOS:   ~/Library/Application Support/com.docker.sandboxes/
# Linux:   ~/.local/state/sandboxes/, ~/.cache/sandboxes/, ~/.config/sandboxes/
```

## Symphony Integration

When Symphony (`sandbox.kind: docker-sbx`) creates workers:
- `sandbox.agent: shell` uses the `docker/sandbox-templates:shell` base (no pre-installed agent)
- The Pi RPC command runs inside the VM via the kit/agent entrypoint
- `name_prefix` prefixes all sandbox names for easy `sbx ls` filtering
- Dirty worktrees are preserved — review with `git worktree list` before cleanup

To check if Claude Code is running inside a sandbox: `/btw are you running in a sandbox?`

Full Symphony configuration reference: [`extensions/symphony/README.md`](../../extensions/symphony/README.md).
