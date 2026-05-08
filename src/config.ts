import { readFile } from "fs/promises";
import * as yaml from "yaml";
import { dirname, resolve } from "path";
import { homedir, tmpdir } from "os";

export interface SymphonyConfig {
  tracker: {
    kind: "linear";
    endpoint: string;
    api_key: string | undefined;
    project_slug: string;
    active_states: string[];
    terminal_states: string[];
  };
  polling: {
    interval_ms: number;
  };
  workspace: {
    root: string;
    strategy: "git-worktree";
    base_ref: string;
    branch_prefix: string;
  };
  hooks: {
    after_create?: string;
    before_run?: string;
    after_run?: string;
    before_remove?: string;
    timeout_ms: number;
  };
  agent: {
    runner: "rpc";
    max_concurrent_agents: number;
    max_turns: number;
    max_retry_backoff_ms: number;
    max_concurrent_agents_by_state: Record<string, number>;
    model?: string;
    model_labels: Record<string, string>;
    command: string;
  };
  codex: {
    turn_timeout_ms: number;
    read_timeout_ms: number;
    stall_timeout_ms: number;
  };
  eligibility: {
    todo_required_label: string;
  };
  sandbox: {
    kind: "docker-sbx";
    agent: string;
    name_prefix: string;
    template?: string;
    kits: string[];
    cpus?: number;
    memory?: string;
    remove_on_terminal: boolean;
    setup?: string;
  };
}

export interface WorkflowDefinition {
  config: SymphonyConfig;
  prompt_template: string;
  path: string;
  loaded_mtime_ms?: number;
}

export class WorkflowConfigError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "WorkflowConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWorkflowContent(content: string): { rawConfig: Record<string, any>; prompt_template: string } {
  let rawConfig: unknown = {};
  let templateBody = content;

  if (content.startsWith("---")) {
    const lines = content.split(/\r?\n/);
    let endLine = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") {
        endLine = i;
        break;
      }
    }

    if (endLine === -1) {
      throw new WorkflowConfigError("workflow_parse_error", "YAML front matter is missing closing ---");
    }

    const yamlContent = lines.slice(1, endLine).join("\n");
    try {
      rawConfig = yamlContent.trim() ? yaml.parse(yamlContent) : {};
    } catch (error: any) {
      throw new WorkflowConfigError("workflow_parse_error", error?.message ?? "Invalid YAML front matter");
    }
    templateBody = lines.slice(endLine + 1).join("\n");
  }

  if (rawConfig == null) rawConfig = {};
  if (!isRecord(rawConfig)) {
    throw new WorkflowConfigError("workflow_front_matter_not_a_map", "YAML front matter must be a map/object");
  }

  return { rawConfig, prompt_template: templateBody.trim() };
}

function resolveEnvToken(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") return String(value);
  if (value.startsWith("$")) {
    const envName = value.slice(1);
    return process.env[envName] || undefined;
  }
  return value;
}

function resolvePathValue(value: string, workflowDir: string): string {
  let resolved = resolveEnvToken(value) || value;
  if (resolved.startsWith("~")) {
    resolved = homedir() + resolved.slice(1);
  }
  return resolve(workflowDir, resolved);
}

function stringList(value: unknown, fallback: string[], path: string): string[] {
  if (value == null) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new WorkflowConfigError("invalid_config", `${path} must be a list of non-empty strings`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new WorkflowConfigError("invalid_config", `${path} must be a string`);
  return value;
}

function positiveInteger(value: unknown, fallback: number, path: string): number {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new WorkflowConfigError("invalid_config", `${path} must be a positive integer`);
  }
  return Number(value);
}

function integer(value: unknown, fallback: number, path: string): number {
  if (value == null) return fallback;
  if (!Number.isInteger(value)) {
    throw new WorkflowConfigError("invalid_config", `${path} must be an integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new WorkflowConfigError("invalid_config", `${path} must be a non-negative integer`);
  }
  return Number(value);
}

function normalizeConcurrencyByState(value: unknown): Record<string, number> {
  if (value == null) return {};
  if (!isRecord(value)) {
    throw new WorkflowConfigError("invalid_config", "agent.max_concurrent_agents_by_state must be a map");
  }
  const normalized: Record<string, number> = {};
  for (const [state, rawLimit] of Object.entries(value)) {
    if (Number.isInteger(rawLimit) && Number(rawLimit) > 0) {
      normalized[state.toLowerCase()] = Number(rawLimit);
    }
  }
  return normalized;
}

export function resolveWorkflowConfig(raw: Record<string, any>, workflowPath: string): SymphonyConfig {
  const workflowDir = dirname(resolve(workflowPath));
  const tracker = isRecord(raw.tracker) ? raw.tracker : {};
  const polling = isRecord(raw.polling) ? raw.polling : {};
  const workspace = isRecord(raw.workspace) ? raw.workspace : {};
  const hooks = isRecord(raw.hooks) ? raw.hooks : {};
  const agent = isRecord(raw.agent) ? raw.agent : {};
  const codex = isRecord(raw.codex) ? raw.codex : {};
  const eligibility = isRecord(raw.eligibility) ? raw.eligibility : {};
  const sandbox = isRecord(raw.sandbox) ? raw.sandbox : {};

  if (typeof tracker.kind !== "string" || tracker.kind.trim() === "") {
    throw new WorkflowConfigError("unsupported_tracker_kind", "tracker.kind is required and must be 'linear'");
  }
  if (tracker.kind !== "linear") {
    throw new WorkflowConfigError("unsupported_tracker_kind", `Unsupported tracker.kind '${tracker.kind}'`);
  }

  const apiKey = resolveEnvToken(tracker.api_key) || process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new WorkflowConfigError("missing_tracker_api_key", "tracker.api_key or LINEAR_API_KEY is required");
  }

  const projectSlug = optionalString(tracker.project_slug, "tracker.project_slug");
  if (!projectSlug || projectSlug.trim() === "") {
    throw new WorkflowConfigError("missing_tracker_project_slug", "tracker.project_slug is required");
  }

  const runner = optionalString(agent.runner, "agent.runner") ?? "rpc";
  if (runner !== "rpc") {
    throw new WorkflowConfigError("invalid_config", "agent.runner must be 'rpc'; host-local shell/print-mode workers are not supported");
  }

  const command = optionalString(agent.command, "agent.command") ?? "pi --mode rpc {model_arg} --session-dir .symphony/sessions";
  if (command.trim() === "") {
    throw new WorkflowConfigError("invalid_config", "agent.command must be non-empty");
  }
  if (!/(^|[\s'\"])(pi|pi\.cmd|pi\.ps1)([\s'\"]|$)/.test(command.trim())) {
    throw new WorkflowConfigError("invalid_config", "agent.command must invoke pi; arbitrary non-Pi worker runtimes are not supported");
  }
  if (!command.includes("--mode rpc")) {
    throw new WorkflowConfigError("invalid_config", "agent.command must launch pi in RPC mode with --mode rpc");
  }

  const model = optionalString(agent.model, "agent.model");

  const rawModelLabels = isRecord(agent.model_labels) ? agent.model_labels : {};
  const modelLabels: Record<string, string> = {};
  for (const [key, val] of Object.entries(rawModelLabels)) {
    if (typeof val === "string" && val.trim()) {
      modelLabels[key.toLowerCase()] = val.trim();
    }
  }
  const requiredLabel = optionalString(eligibility.todo_required_label, "eligibility.todo_required_label") ?? "symphony";
  const workspaceStrategy = optionalString(workspace.strategy, "workspace.strategy") ?? "git-worktree";
  if (workspaceStrategy !== "git-worktree") {
    throw new WorkflowConfigError("invalid_config", "workspace.strategy must be 'git-worktree'");
  }
  const workspaceBaseRef = optionalString(workspace.base_ref, "workspace.base_ref") ?? "HEAD";
  if (workspaceBaseRef.trim() === "") {
    throw new WorkflowConfigError("invalid_config", "workspace.base_ref must be non-empty");
  }
  const workspaceBranchPrefix = optionalString(workspace.branch_prefix, "workspace.branch_prefix") ?? "agent/";
  const sandboxKind = optionalString(sandbox.kind, "sandbox.kind");
  if (sandboxKind !== "docker-sbx") {
    throw new WorkflowConfigError("invalid_config", "sandbox.kind: docker-sbx is required; workers cannot run without Docker Sandbox isolation");
  }
  const sandboxAgent = optionalString(sandbox.agent, "sandbox.agent") ?? "shell";
  const sandboxNamePrefix = optionalString(sandbox.name_prefix, "sandbox.name_prefix") ?? "symphony";
  const sandboxKits = stringList(sandbox.kits, [], "sandbox.kits");
  const sandboxCpus = sandbox.cpus == null ? undefined : nonNegativeInteger(sandbox.cpus, "sandbox.cpus");
  const sandboxMemory = optionalString(sandbox.memory, "sandbox.memory");

  return {
    tracker: {
      kind: "linear",
      endpoint: optionalString(tracker.endpoint, "tracker.endpoint") ?? "https://api.linear.app/graphql",
      api_key: apiKey,
      project_slug: projectSlug,
      active_states: stringList(tracker.active_states, ["Todo", "In Progress"], "tracker.active_states"),
      terminal_states: stringList(tracker.terminal_states, ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"], "tracker.terminal_states"),
    },
    polling: {
      interval_ms: positiveInteger(polling.interval_ms, 30000, "polling.interval_ms"),
    },
    workspace: {
      root: resolvePathValue(optionalString(workspace.root, "workspace.root") ?? `${tmpdir()}/symphony_worktrees`, workflowDir),
      strategy: "git-worktree",
      base_ref: workspaceBaseRef,
      branch_prefix: workspaceBranchPrefix,
    },
    hooks: {
      after_create: optionalString(hooks.after_create, "hooks.after_create"),
      before_run: optionalString(hooks.before_run, "hooks.before_run"),
      after_run: optionalString(hooks.after_run, "hooks.after_run"),
      before_remove: optionalString(hooks.before_remove, "hooks.before_remove"),
      timeout_ms: positiveInteger(hooks.timeout_ms, 60000, "hooks.timeout_ms"),
    },
    agent: {
      runner: "rpc",
      max_concurrent_agents: positiveInteger(agent.max_concurrent_agents, 10, "agent.max_concurrent_agents"),
      max_turns: positiveInteger(agent.max_turns, 20, "agent.max_turns"),
      max_retry_backoff_ms: positiveInteger(agent.max_retry_backoff_ms, 300000, "agent.max_retry_backoff_ms"),
      max_concurrent_agents_by_state: normalizeConcurrencyByState(agent.max_concurrent_agents_by_state),
      model,
      model_labels: modelLabels,
      command,
    },
    codex: {
      turn_timeout_ms: positiveInteger(codex.turn_timeout_ms, 3600000, "codex.turn_timeout_ms"),
      read_timeout_ms: positiveInteger(codex.read_timeout_ms, 5000, "codex.read_timeout_ms"),
      stall_timeout_ms: integer(codex.stall_timeout_ms, 300000, "codex.stall_timeout_ms"),
    },
    eligibility: {
      todo_required_label: requiredLabel.toLowerCase(),
    },
    sandbox: {
      kind: "docker-sbx",
      agent: sandboxAgent,
      name_prefix: sandboxNamePrefix,
      template: optionalString(sandbox.template, "sandbox.template"),
      kits: sandboxKits,
      cpus: sandboxCpus,
      memory: sandboxMemory,
      remove_on_terminal: sandbox.remove_on_terminal == null ? true : Boolean(sandbox.remove_on_terminal),
      setup: optionalString(sandbox.setup, "sandbox.setup"),
    },
  };
}

export async function loadWorkflow(workflowPath: string): Promise<WorkflowDefinition> {
  const absolutePath = resolve(workflowPath);
  const content = await readFile(absolutePath, "utf8").catch((error: any) => {
    throw new WorkflowConfigError("missing_workflow_file", error?.message ?? `Unable to read ${absolutePath}`);
  });
  const parsed = parseWorkflowContent(content);
  const config = resolveWorkflowConfig(parsed.rawConfig, absolutePath);

  return {
    config,
    prompt_template: parsed.prompt_template || "You are working on an issue from Linear.",
    path: absolutePath,
  };
}
