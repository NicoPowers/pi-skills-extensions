import { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadWorkflow, WorkflowDefinition } from "./config.js";
import { LinearClient, Issue } from "./linear.js";
import { exec, spawn, ChildProcess } from "child_process";
import { mkdir, rm, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, isAbsolute, relative, resolve, sep } from "path";
import { promisify } from "util";
import { Liquid } from "liquidjs";

const execAsync = promisify(exec);
const engine = new Liquid({ strictVariables: true, strictFilters: true });

export type WorkerOutcome = "normal" | "failed" | "timeout" | "stalled" | "canceled_by_reconciliation";

type LogLevel = "info" | "warn" | "error" | "debug";

interface WorkerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  source: "pi-rpc" | "unavailable";
  estimated: boolean;
}

interface WorkerSessionInfo {
  sessionId?: string;
  sessionFile?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  turnCount: number;
  lastEvent?: string;
  lastMessage?: string;
  lastActivityAt?: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

interface RunState {
  running: Map<string, RunningWorker>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  usageTotals: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number; seconds_running: number };
  latestProviderLimits: unknown | null;
  startedAt: number;
  lastErrors: string[];
}

interface RunningWorker {
  issue: Issue;
  workspacePath: string;
  startedAt: number;
  lastActivityAt: number;
  pid: number | null;
  child?: ChildProcess;
  attempt: number | null;
  terminating?: WorkerOutcome;
  sessionInfo?: WorkerSessionInfo;
  usage?: WorkerUsage;
}

interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error?: string;
}

interface WorkspaceInfo {
  key: string;
  root: string;
  path: string;
  branchName: string;
  repoRoot: string;
  createdNow: boolean;
}

interface WorkflowRuntime {
  current: WorkflowDefinition;
  mtimeMs: number;
  path: string;
}

let authoritativeState: RunState | null = null;
let lastPreflightError: string | null = null;

function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const parts = [`event=${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    const safe = String(value).replace(/[\r\n]/g, " ");
    parts.push(`${key}=${JSON.stringify(safe)}`);
  }
  const line = parts.join(" ");
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function recordError(state: RunState, error: string) {
  state.lastErrors.unshift(error);
  state.lastErrors = state.lastErrors.slice(0, 20);
}

export function sanitizeIdentifier(identifier: string) {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized || "issue";
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function renderPrompt(workflow: WorkflowDefinition, issue: Issue, attempt: number | null) {
  return String(await engine.parseAndRender(workflow.prompt_template, { issue, attempt }));
}

function buildAgentCommand(workflow: WorkflowDefinition, prompt: string) {
  const model = workflow.config.agent.model;
  const modelArg = model ? `--model ${shellQuote(model)}` : "";

  return workflow.config.agent.command
    .replaceAll("{prompt}", prompt.replace(/"/g, '\\"'))
    .replaceAll("{model}", model ?? "")
    .replaceAll("{model_arg}", modelArg);
}

export function sandboxNameForIssue(workflow: WorkflowDefinition, issue: Issue) {
  const key = issue.identifier.toLowerCase().replace(/[^a-z0-9.+-]/g, "-").replace(/^-+|-+$/g, "") || "issue";
  return `${workflow.config.sandbox.name_prefix}-${key}`.replace(/[^A-Za-z0-9.+-]/g, "-").slice(0, 63);
}

async function writePromptFile(workspacePath: string, prompt: string) {
  const dir = resolve(workspacePath, ".symphony");
  await mkdir(dir, { recursive: true });
  const promptFile = resolve(dir, "prompt.md");
  await writeFile(promptFile, prompt, "utf8");
  return promptFile;
}

function normalizedStateList(states: string[]) {
  return states.map((state) => state.toLowerCase());
}

function priorityValue(issue: Issue) {
  return issue.priority == null ? Number.MAX_SAFE_INTEGER : issue.priority;
}

export function sortForDispatch(issues: Issue[]) {
  return [...issues].sort((a, b) => {
    const priorityDiff = priorityValue(a) - priorityValue(b);
    if (priorityDiff !== 0) return priorityDiff;
    const aCreated = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bCreated = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return a.identifier.localeCompare(b.identifier);
  });
}

function isPathInsideRoot(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function workspacePaths(workflow: WorkflowDefinition, issue: Issue): Omit<WorkspaceInfo, "createdNow" | "repoRoot"> {
  const key = sanitizeIdentifier(issue.identifier);
  const root = resolve(workflow.config.workspace.root);
  const path = resolve(root, key);
  const branchName = `${workflow.config.workspace.branch_prefix}${key}`;
  if (!isPathInsideRoot(root, path)) {
    throw new Error(`workspace path escaped root: ${path}`);
  }
  return { key, root, path, branchName };
}

async function gitRepoRoot(cwd: string) {
  const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd, shell: "bash", timeout: 10000 });
  const root = stdout.trim();
  if (!root) throw new Error("git rev-parse returned an empty repository root");
  return root;
}

async function isGitWorktree(path: string) {
  try {
    const { stdout } = await execAsync("git rev-parse --is-inside-work-tree", { cwd: path, shell: "bash", timeout: 10000 });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function gitBranchExists(repoRoot: string, branchName: string) {
  try {
    await execAsync(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${branchName}`)}`, { cwd: repoRoot, shell: "bash", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

export async function ensureWorkspace(workflow: WorkflowDefinition, issue: Issue): Promise<WorkspaceInfo> {
  const paths = workspacePaths(workflow, issue);
  const repoRoot = await gitRepoRoot(dirname(workflow.path));
  let createdNow = false;

  await mkdir(paths.root, { recursive: true });
  try {
    const current = await stat(paths.path);
    if (!current.isDirectory()) {
      throw new Error(`Issue Worktree path exists but is not a directory: ${paths.path}`);
    }
    if (!(await isGitWorktree(paths.path))) {
      throw new Error(`Issue Worktree path exists but is not a git worktree: ${paths.path}`);
    }
    return { ...paths, repoRoot, createdNow };
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const branchExists = await gitBranchExists(repoRoot, paths.branchName);
  const command = branchExists
    ? `git worktree add ${shellQuote(paths.path)} ${shellQuote(paths.branchName)}`
    : `git worktree add ${shellQuote(paths.path)} -b ${shellQuote(paths.branchName)} ${shellQuote(workflow.config.workspace.base_ref)}`;
  await execAsync(command, { cwd: repoRoot, shell: "bash", timeout: workflow.config.hooks.timeout_ms });
  createdNow = true;
  return { ...paths, repoRoot, createdNow };
}

function assertLaunchCwd(cwd: string, workspacePath: string) {
  if (resolve(cwd) !== resolve(workspacePath)) {
    throw new Error(`invalid launch cwd: ${cwd} != ${workspacePath}`);
  }
}

function hookEnv(workflow: WorkflowDefinition, issue: Issue, prompt?: string) {
  return {
    ...process.env,
    SYMPHONY_PROMPT: prompt ?? "",
    SYMPHONY_ISSUE_ID: issue.identifier,
    SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
    SYMPHONY_ISSUE_TITLE: issue.title,
    SYMPHONY_AGENT_MODEL: workflow.config.agent.model ?? "",
  };
}

async function runHook(workflow: WorkflowDefinition, issue: Issue, hookName: "after_create" | "before_run" | "after_run" | "before_remove", cwd: string, prompt?: string, bestEffort = false) {
  const script = workflow.config.hooks[hookName];
  if (!script) return;
  log("info", "hook_started", { hook: hookName, issue_id: issue.id, issue_identifier: issue.identifier, cwd });
  try {
    await execAsync(script, { shell: "bash", cwd, timeout: workflow.config.hooks.timeout_ms, env: hookEnv(workflow, issue, prompt) });
    log("info", "hook_completed", { hook: hookName, issue_id: issue.id, issue_identifier: issue.identifier });
  } catch (error: any) {
    log(bestEffort ? "warn" : "error", "hook_failed", { hook: hookName, issue_id: issue.id, issue_identifier: issue.identifier, reason: error?.message ?? error });
    if (!bestEffort) throw error;
  }
}

async function hasUncommittedChanges(workspacePath: string): Promise<boolean | null> {
  try {
    const { stdout } = await execAsync("git status --porcelain", { cwd: workspacePath, shell: "bash", timeout: 30000 });
    return stdout.trim().length > 0;
  } catch {
    return null;
  }
}

async function removeSandbox(workflow: WorkflowDefinition, issue: Issue) {
  if (workflow.config.sandbox.kind !== "docker-sbx" || !workflow.config.sandbox.remove_on_terminal) return;
  const sandboxName = sandboxNameForIssue(workflow, issue);
  await execAsync(`sbx rm ${shellQuote(sandboxName)}`, { shell: "bash", timeout: 60000 }).then(() => {
    log("info", "sandbox_removed", { issue_id: issue.id, issue_identifier: issue.identifier, sandbox_name: sandboxName });
  }).catch((error: any) => {
    log("warn", "sandbox_remove_failed", { issue_id: issue.id, issue_identifier: issue.identifier, sandbox_name: sandboxName, reason: error?.message ?? error });
  });
}

async function removeWorkspace(workflow: WorkflowDefinition, issue: Issue, workspacePath: string) {
  await removeSandbox(workflow, issue);
  if (!existsSync(workspacePath)) return;
  await runHook(workflow, issue, "before_remove", workspacePath, undefined, true);
  if (!existsSync(workspacePath)) return;

  const dirty = await hasUncommittedChanges(workspacePath);
  if (dirty === true) {
    log("warn", "workspace_preserved_dirty", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      workspace_path: workspacePath,
      review_command: `cd ${shellQuote(workspacePath)}`,
      cleanup_command: `git worktree remove --force ${shellQuote(workspacePath)}`,
    });
    return;
  }

  if (dirty === false) {
    try {
      await execAsync(`git worktree remove --force ${shellQuote(workspacePath)}`, { cwd: dirname(workspacePath), shell: "bash", timeout: 30000 });
      log("info", "git_worktree_removed", { issue_id: issue.id, issue_identifier: issue.identifier, workspace_path: workspacePath });
      return;
    } catch (error: any) {
      log("debug", "git_worktree_remove_failed_falling_back", { issue_id: issue.id, issue_identifier: issue.identifier, reason: error?.message ?? error });
    }
  }

  await rm(workspacePath, { recursive: true, force: true });
  log("info", "workspace_removed", { issue_id: issue.id, issue_identifier: issue.identifier, workspace_path: workspacePath });
}

function sbxCreateArgs(workflow: WorkflowDefinition, issue: Issue, workspacePath: string) {
  const args = ["create", "--name", sandboxNameForIssue(workflow, issue)];
  if (workflow.config.sandbox.template) args.push("--template", workflow.config.sandbox.template);
  for (const kit of workflow.config.sandbox.kits) args.push("--kit", kit);
  if (workflow.config.sandbox.cpus !== undefined) args.push("--cpus", String(workflow.config.sandbox.cpus));
  if (workflow.config.sandbox.memory) args.push("--memory", workflow.config.sandbox.memory);
  args.push(workflow.config.sandbox.agent, workspacePath);
  return args;
}

async function ensureDockerSandbox(workflow: WorkflowDefinition, issue: Issue, workspacePath: string) {
  if (workflow.config.sandbox.kind !== "docker-sbx") return;
  const sandboxName = sandboxNameForIssue(workflow, issue);
  const args = sbxCreateArgs(workflow, issue, workspacePath);
  log("info", "sandbox_create_started", { issue_id: issue.id, issue_identifier: issue.identifier, sandbox_name: sandboxName, workspace_path: workspacePath });
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("sbx", args, { cwd: workspacePath, stdio: "pipe" });
    let stderr = "";
    let stdout = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        log("info", "sandbox_create_completed", { issue_id: issue.id, issue_identifier: issue.identifier, sandbox_name: sandboxName });
        resolvePromise();
        return;
      }
      const output = `${stdout}\n${stderr}`;
      if (/already exists|exists already|already in use/i.test(output)) {
        log("info", "sandbox_reused", { issue_id: issue.id, issue_identifier: issue.identifier, sandbox_name: sandboxName });
        resolvePromise();
        return;
      }
      reject(new Error(`sbx create failed with code ${code}: ${output.trim()}`));
    });
  });

  if (workflow.config.sandbox.setup) {
    log("info", "sandbox_setup_started", { issue_id: issue.id, issue_identifier: issue.identifier, sandbox_name: sandboxName });
    await execAsync(`sbx exec -w ${shellQuote(workspacePath)} ${shellQuote(sandboxName)} bash -lc ${shellQuote(workflow.config.sandbox.setup)}`, { cwd: workspacePath, shell: "bash", timeout: workflow.config.hooks.timeout_ms });
    log("info", "sandbox_setup_completed", { issue_id: issue.id, issue_identifier: issue.identifier, sandbox_name: sandboxName });
  }
}

function buildSandboxedShellCommand(command: string, promptFile: string, workflow: WorkflowDefinition, issue: Issue) {
  const exports = [
    `export SYMPHONY_PROMPT_FILE=${shellQuote(promptFile)}`,
    `export SYMPHONY_PROMPT="$(cat ${shellQuote(promptFile)})"`,
    `export SYMPHONY_ISSUE_ID=${shellQuote(issue.identifier)}`,
    `export SYMPHONY_ISSUE_IDENTIFIER=${shellQuote(issue.identifier)}`,
    `export SYMPHONY_ISSUE_TITLE=${shellQuote(issue.title)}`,
    `export SYMPHONY_AGENT_MODEL=${shellQuote(workflow.config.agent.model ?? "")}`,
  ];
  return `${exports.join("; ")}; ${command}`;
}

function spawnWorkerProcess(workflow: WorkflowDefinition, issue: Issue, workspacePath: string, command: string, _prompt: string, promptFile: string) {
  if (workflow.config.sandbox.kind !== "docker-sbx") {
    throw new Error("refusing to launch worker without Docker Sandbox isolation");
  }
  const sandboxName = sandboxNameForIssue(workflow, issue);
  const sandboxCommand = buildSandboxedShellCommand(command, promptFile, workflow, issue);
  return spawn("sbx", ["exec", "-w", workspacePath, sandboxName, "bash", "-lc", sandboxCommand], {
    cwd: workspacePath,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
}

async function terminateProcessTree(pid: number | null, reason: WorkerOutcome) {
  if (!pid) return;
  log("warn", "process_terminate", { pid, reason });
  if (process.platform === "win32") {
    await execAsync(`taskkill /pid ${pid} /T /F`).catch(() => {});
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

export async function validateIsolationPreflight(workflow: WorkflowDefinition) {
  if (workflow.config.sandbox.kind !== "docker-sbx") {
    throw new Error("sandbox.kind: docker-sbx is required; refusing to start insecure worker configuration");
  }
  if (workflow.config.workspace.strategy !== "git-worktree") {
    throw new Error("workspace.strategy: git-worktree is required; refusing to start insecure workspace configuration");
  }
  if (workflow.config.agent.runner !== "rpc") {
    throw new Error("agent.runner: rpc is required; host-local shell/print-mode workers are not supported");
  }

  try {
    await execAsync("sbx --version", { shell: "bash", timeout: 10000 });
  } catch (error: any) {
    throw new Error(`Docker Sandbox CLI 'sbx' is required and must be available: ${error?.message ?? error}`);
  }

  const workflowDir = dirname(workflow.path);
  let repoRoot: string;
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd: workflowDir, shell: "bash", timeout: 10000 });
    repoRoot = stdout.trim();
    if (!repoRoot) throw new Error("empty git root");
  } catch (error: any) {
    throw new Error(`WORKFLOW.md must be inside a git repository: ${error?.message ?? error}`);
  }

  try {
    await execAsync(`git rev-parse --verify ${shellQuote(workflow.config.workspace.base_ref)}`, { cwd: repoRoot, shell: "bash", timeout: 10000 });
    await execAsync("git worktree list --porcelain", { cwd: repoRoot, shell: "bash", timeout: 10000 });
    await mkdir(workflow.config.workspace.root, { recursive: true });
  } catch (error: any) {
    throw new Error(`git worktrees must be available for workspace isolation: ${error?.message ?? error}`);
  }
}

async function loadWorkflowRuntime(workflowPath: string): Promise<WorkflowRuntime> {
  const absolute = resolve(workflowPath);
  const [workflow, fileStat] = await Promise.all([loadWorkflow(absolute), stat(absolute)]);
  workflow.loaded_mtime_ms = fileStat.mtimeMs;
  return { current: workflow, mtimeMs: fileStat.mtimeMs, path: absolute };
}

async function reloadWorkflowIfChanged(runtime: WorkflowRuntime, state: RunState): Promise<boolean> {
  const currentStat = await stat(runtime.path).catch(() => null);
  if (!currentStat || currentStat.mtimeMs === runtime.mtimeMs) return false;
  try {
    const next = await loadWorkflow(runtime.path);
    next.loaded_mtime_ms = currentStat.mtimeMs;
    runtime.current = next;
    runtime.mtimeMs = currentStat.mtimeMs;
    log("info", "workflow_reloaded", { workflow_path: runtime.path });
    return true;
  } catch (error: any) {
    const message = `workflow reload failed: ${error?.message ?? error}`;
    recordError(state, message);
    log("error", "workflow_reload_failed", { workflow_path: runtime.path, reason: error?.message ?? error });
    return false;
  }
}

function createState(): RunState {
  return {
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    usageTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, seconds_running: 0 },
    latestProviderLimits: null,
    startedAt: Date.now(),
    lastErrors: [],
  };
}

function createLinear(workflow: WorkflowDefinition) {
  return new LinearClient(workflow.config.tracker.endpoint, workflow.config.tracker.api_key!);
}

export async function runSymphony(pi: ExtensionAPI, ctx: ExtensionContext, workflowPath: string, isStopped: () => boolean) {
  const runtime = await loadWorkflowRuntime(workflowPath);
  const state = createState();

  authoritativeState = state;
  await validateIsolationPreflight(runtime.current).catch((error) => {
    lastPreflightError = error?.message ?? String(error);
    throw error;
  });
  lastPreflightError = null;
  await startupCleanup(runtime.current, state);
  log("info", "symphony_started", { workflow_path: runtime.path, poll_interval_ms: runtime.current.config.polling.interval_ms });

  while (!isStopped()) {
    await reloadWorkflowIfChanged(runtime, state);
    try {
      await pollTick(pi, ctx, runtime.current, state);
    } catch (error: any) {
      recordError(state, error?.message ?? String(error));
      log("error", "poll_tick_failed", { reason: error?.message ?? error });
    }
    const interval = runtime.current.config.polling.interval_ms;
    const sleepStarted = Date.now();
    while (!isStopped()) {
      const elapsed = Date.now() - sleepStarted;
      const dueIn = nearestRetryDueInMs(state);
      const remainingPoll = interval - elapsed;
      if (remainingPoll <= 0 || dueIn <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remainingPoll, dueIn)));
    }
  }
}

async function startupCleanup(workflow: WorkflowDefinition, state: RunState) {
  try {
    const linear = createLinear(workflow);
    const terminal = await linear.fetchIssuesByStates(workflow.config.tracker.terminal_states, workflow.config.tracker.project_slug);
    for (const issue of terminal) {
      const workspacePath = workspacePaths(workflow, issue).path;
      await removeWorkspace(workflow, issue, workspacePath);
    }
  } catch (error: any) {
    recordError(state, error?.message ?? String(error));
    log("warn", "startup_cleanup_failed", { reason: error?.message ?? error });
  }
}

async function pollTick(pi: ExtensionAPI, ctx: ExtensionContext, workflow: WorkflowDefinition, state: RunState) {
  await validateIsolationPreflight(workflow).then(() => { lastPreflightError = null; }).catch((error) => {
    lastPreflightError = error?.message ?? String(error);
    throw error;
  });
  const linear = createLinear(workflow);
  await reconcileRunning(linear, workflow, state);
  const candidates = await linear.fetchCandidateIssues(workflow.config.tracker.project_slug, workflow.config.tracker.active_states);
  await handleDueRetries(candidates, workflow, state, pi, ctx);
  await dispatchNewCandidates(sortForDispatch(candidates), workflow, state, pi, ctx);
}

async function reconcileRunning(linear: LinearClient, workflow: WorkflowDefinition, state: RunState) {
  await reconcileStalledRuns(workflow, state);
  const runningIds = Array.from(state.running.keys());
  if (runningIds.length === 0) return;

  let refreshed: Issue[];
  try {
    refreshed = await linear.fetchIssueStatesByIds(runningIds);
  } catch (error: any) {
    log("warn", "state_refresh_failed_keep_workers", { reason: error?.message ?? error });
    return;
  }

  const refreshedById = new Map(refreshed.map((issue) => [issue.id, issue]));
  const terminalStates = normalizedStateList(workflow.config.tracker.terminal_states);
  const activeStates = normalizedStateList(workflow.config.tracker.active_states);

  for (const [issueId, worker] of Array.from(state.running.entries())) {
    const issue = refreshedById.get(issueId);
    if (!issue) continue;
    const issueState = issue.state.toLowerCase();
    if (terminalStates.includes(issueState)) {
      await terminateRunningIssue(workflow, state, issueId, "canceled_by_reconciliation", true, issue);
    } else if (activeStates.includes(issueState)) {
      worker.issue = issue;
      worker.lastActivityAt = Date.now();
      log("debug", "running_issue_refreshed", { issue_id: issue.id, issue_identifier: issue.identifier, state: issue.state });
    } else {
      await terminateRunningIssue(workflow, state, issueId, "canceled_by_reconciliation", false, issue);
    }
  }
}

async function reconcileStalledRuns(workflow: WorkflowDefinition, state: RunState) {
  const timeout = workflow.config.codex.stall_timeout_ms;
  if (timeout <= 0) return;
  const now = Date.now();
  for (const [issueId, worker] of Array.from(state.running.entries())) {
    const elapsed = now - (worker.lastActivityAt || worker.startedAt);
    if (elapsed > timeout) {
      log("warn", "worker_stalled", { issue_id: worker.issue.id, issue_identifier: worker.issue.identifier, elapsed_ms: elapsed });
      await terminateRunningIssue(workflow, state, issueId, "stalled", false, worker.issue);
      scheduleRetry(state, worker.issue, nextAttempt(worker.attempt), workflow, "worker stalled");
    }
  }
}

async function terminateRunningIssue(workflow: WorkflowDefinition, state: RunState, issueId: string, outcome: WorkerOutcome, cleanupWorkspace: boolean, refreshedIssue?: Issue) {
  const worker = state.running.get(issueId);
  if (!worker) return;
  worker.terminating = outcome;
  await terminateProcessTree(worker.pid, outcome);
  state.running.delete(issueId);
  state.claimed.delete(issueId);
  state.retryAttempts.delete(issueId);
  const duration = (Date.now() - worker.startedAt) / 1000;
  state.usageTotals.seconds_running += duration;
  const issue = refreshedIssue ?? worker.issue;
  log("warn", "worker_terminated", { issue_id: issue.id, issue_identifier: issue.identifier, outcome, cleanup_workspace: cleanupWorkspace });
  if (cleanupWorkspace) {
    await removeWorkspace(workflow, issue, worker.workspacePath);
  }
}

function runningCountByState(state: RunState, stateName: string) {
  const normalized = stateName.toLowerCase();
  let count = 0;
  for (const worker of state.running.values()) {
    if (worker.issue.state.toLowerCase() === normalized) count++;
  }
  return count;
}

function hasGlobalSlot(workflow: WorkflowDefinition, state: RunState) {
  return state.running.size < workflow.config.agent.max_concurrent_agents;
}

function hasStateSlot(workflow: WorkflowDefinition, state: RunState, issue: Issue) {
  const stateKey = issue.state.toLowerCase();
  const limit = workflow.config.agent.max_concurrent_agents_by_state[stateKey] ?? workflow.config.agent.max_concurrent_agents;
  return runningCountByState(state, issue.state) < limit;
}

function hasAvailableSlots(workflow: WorkflowDefinition, state: RunState, issue: Issue) {
  return hasGlobalSlot(workflow, state) && hasStateSlot(workflow, state, issue);
}

export function isCandidateEligible(issue: Issue, workflow: WorkflowDefinition, state: RunState, opts: { allowClaimedIssueId?: string; checkSlots?: boolean } = {}) {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) return { ok: false, reason: "missing required issue fields" };
  const activeStates = normalizedStateList(workflow.config.tracker.active_states);
  const terminalStates = normalizedStateList(workflow.config.tracker.terminal_states);
  const issueState = issue.state.toLowerCase();
  if (!activeStates.includes(issueState)) return { ok: false, reason: "state is not active" };
  if (terminalStates.includes(issueState)) return { ok: false, reason: "state is terminal" };
  if (state.running.has(issue.id)) return { ok: false, reason: "already running" };
  if (state.claimed.has(issue.id) && opts.allowClaimedIssueId !== issue.id) return { ok: false, reason: "already claimed" };
  if (issueState === "todo") {
    if (!issue.labels.includes(workflow.config.eligibility.todo_required_label)) {
      return { ok: false, reason: `missing required ${workflow.config.eligibility.todo_required_label} label` };
    }
    const hasActiveBlockers = issue.blocked_by.some((blocker) => blocker.state && !terminalStates.includes(blocker.state.toLowerCase()));
    if (hasActiveBlockers) return { ok: false, reason: "blocked by non-terminal issue" };
  }
  if (opts.checkSlots !== false && !hasAvailableSlots(workflow, state, issue)) return { ok: false, reason: "no available orchestrator slots" };
  return { ok: true, reason: "eligible" };
}

async function handleDueRetries(candidates: Issue[], workflow: WorkflowDefinition, state: RunState, pi: ExtensionAPI, ctx: ExtensionContext) {
  const now = Date.now();
  const candidatesById = new Map(candidates.map((issue) => [issue.id, issue]));
  for (const retry of Array.from(state.retryAttempts.values()).sort((a, b) => a.dueAtMs - b.dueAtMs)) {
    if (retry.dueAtMs > now) continue;
    state.retryAttempts.delete(retry.issue_id);
    const issue = candidatesById.get(retry.issue_id);
    if (!issue) {
      state.claimed.delete(retry.issue_id);
      log("info", "retry_released_not_candidate", { issue_id: retry.issue_id, issue_identifier: retry.identifier, attempt: retry.attempt });
      continue;
    }
    const eligibility = isCandidateEligible(issue, workflow, state, { allowClaimedIssueId: retry.issue_id });
    if (!eligibility.ok) {
      if (eligibility.reason === "no available orchestrator slots") {
        scheduleRetry(state, issue, retry.attempt + 1, workflow, "no available orchestrator slots");
      } else {
        state.claimed.delete(retry.issue_id);
        log("info", "retry_released_ineligible", { issue_id: issue.id, issue_identifier: issue.identifier, reason: eligibility.reason });
      }
      continue;
    }
    await dispatchIssue(pi, ctx, issue, workflow, state, retry.attempt);
  }
}

async function dispatchNewCandidates(candidates: Issue[], workflow: WorkflowDefinition, state: RunState, pi: ExtensionAPI, ctx: ExtensionContext) {
  for (const issue of candidates) {
    if (!hasGlobalSlot(workflow, state)) break;
    const eligibility = isCandidateEligible(issue, workflow, state);
    if (!eligibility.ok) {
      log("debug", "issue_skipped", { issue_id: issue.id, issue_identifier: issue.identifier, reason: eligibility.reason });
      continue;
    }
    await dispatchIssue(pi, ctx, issue, workflow, state, null);
  }
}

function nextAttempt(attempt: number | null | undefined) {
  return attempt == null ? 1 : attempt + 1;
}

function nearestRetryDueInMs(state: RunState) {
  let nearest = Number.POSITIVE_INFINITY;
  const now = Date.now();
  for (const retry of state.retryAttempts.values()) {
    nearest = Math.min(nearest, retry.dueAtMs - now);
  }
  return Number.isFinite(nearest) ? Math.max(0, nearest) : Number.POSITIVE_INFINITY;
}

function scheduleRetry(state: RunState, issue: Issue, attempt: number, workflow: WorkflowDefinition, error?: string, continuation = false) {
  const delay = continuation ? 1000 : Math.min(10000 * 2 ** (attempt - 1), workflow.config.agent.max_retry_backoff_ms);
  const entry: RetryEntry = {
    issue_id: issue.id,
    identifier: issue.identifier,
    attempt,
    dueAtMs: Date.now() + delay,
    error,
  };
  state.retryAttempts.set(issue.id, entry);
  state.claimed.add(issue.id);
  log("info", "retry_scheduled", { issue_id: issue.id, issue_identifier: issue.identifier, attempt, delay_ms: delay, error, continuation });
}

async function dispatchIssue(pi: ExtensionAPI, ctx: ExtensionContext, issue: Issue, workflow: WorkflowDefinition, state: RunState, attempt: number | null) {
  state.claimed.add(issue.id);
  state.retryAttempts.delete(issue.id);
  const workspacePath = workspacePaths(workflow, issue).path;
  const worker: RunningWorker = {
    issue,
    workspacePath,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    pid: null,
    attempt,
  };
  state.running.set(issue.id, worker);
  log("info", "dispatch_started", { issue_id: issue.id, issue_identifier: issue.identifier, workspace_path: workspacePath, attempt });

  runAgentAttempt(pi, ctx, issue, workflow, state, worker).catch((error: any) => {
    log("error", "worker_task_error", { issue_id: issue.id, issue_identifier: issue.identifier, reason: error?.message ?? error });
  });
}

async function runAgentAttempt(pi: ExtensionAPI, ctx: ExtensionContext, issue: Issue, workflow: WorkflowDefinition, state: RunState, worker: RunningWorker) {
  let workspace: WorkspaceInfo | null = null;
  let prompt: string | undefined;
  let afterRunNeeded = false;
  let outcome: WorkerOutcome = "failed";
  let outcomeError: string | undefined;

  try {
    workspace = await ensureWorkspace(workflow, issue);
    afterRunNeeded = true;
    if (workspace.createdNow) {
      try {
        await runHook(workflow, issue, "after_create", workspace.path);
      } catch (error) {
        afterRunNeeded = false;
        await removeWorkspace(workflow, issue, workspace.path).catch(() => {});
        throw error;
      }
    }

    await runHook(workflow, issue, "before_run", workspace.path);
    prompt = await renderPrompt(workflow, issue, worker.attempt);
    const promptFile = await writePromptFile(workspace.path, prompt);
    const command = buildAgentCommand(workflow, prompt);
    assertLaunchCwd(workspace.path, worker.workspacePath);
    await ensureDockerSandbox(workflow, issue, workspace.path);

    log("info", "worker_process_launch", { issue_id: issue.id, issue_identifier: issue.identifier, cwd: workspace.path, attempt: worker.attempt, sandbox_kind: workflow.config.sandbox.kind });
    const child = spawnWorkerProcess(workflow, issue, workspace.path, command, prompt, promptFile);
    worker.child = child;
    worker.pid = child.pid || null;

    outcome = await waitForRpcTurn(child, prompt, workflow, worker);
    if (worker.terminating) outcome = worker.terminating;
  } catch (error: any) {
    outcome = worker.terminating ?? "failed";
    outcomeError = error?.message ?? String(error);
    log("error", "worker_attempt_failed", { issue_id: issue.id, issue_identifier: issue.identifier, reason: outcomeError });
  } finally {
    if (afterRunNeeded && workspace) {
      await runHook(workflow, issue, "after_run", workspace.path, prompt, true);
    }
    await handleWorkerExit(workflow, state, issue.id, outcome, outcomeError);
  }
}

function applySessionStats(worker: RunningWorker, data: any) {
  if (!data || typeof data !== "object") return;
  worker.sessionInfo = {
    ...(worker.sessionInfo ?? { turnCount: 0 }),
    sessionId: typeof data.sessionId === "string" ? data.sessionId : worker.sessionInfo?.sessionId,
    sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : worker.sessionInfo?.sessionFile,
    userMessages: Number(data.userMessages ?? worker.sessionInfo?.userMessages ?? 0),
    assistantMessages: Number(data.assistantMessages ?? worker.sessionInfo?.assistantMessages ?? 0),
    toolCalls: Number(data.toolCalls ?? worker.sessionInfo?.toolCalls ?? 0),
    toolResults: Number(data.toolResults ?? worker.sessionInfo?.toolResults ?? 0),
    totalMessages: Number(data.totalMessages ?? worker.sessionInfo?.totalMessages ?? 0),
    turnCount: worker.sessionInfo?.turnCount ?? 0,
    lastEvent: worker.sessionInfo?.lastEvent,
    lastMessage: worker.sessionInfo?.lastMessage,
    lastActivityAt: worker.lastActivityAt,
    contextUsage: data.contextUsage,
  };
  const tokens = data.tokens ?? {};
  worker.usage = {
    input: Number(tokens.input ?? 0),
    output: Number(tokens.output ?? 0),
    cacheRead: Number(tokens.cacheRead ?? 0),
    cacheWrite: Number(tokens.cacheWrite ?? 0),
    total: Number(tokens.total ?? 0),
    cost: Number(data.cost ?? 0),
    source: "pi-rpc",
    estimated: data.contextUsage?.tokens == null && Number(tokens.total ?? 0) === 0,
  };
}

async function waitForRpcTurn(child: ChildProcess, prompt: string, workflow: WorkflowDefinition, worker: RunningWorker): Promise<WorkerOutcome> {
  return await new Promise<WorkerOutcome>((resolve) => {
    let settled = false;
    let buffer = "";
    let stderr = "";
    let nextId = 1;
    const pending = new Map<string, (message: any) => void>();

    const finish = async (outcome: WorkerOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const resolvePending of pending.values()) resolvePending({ success: false, error: "rpc session finished" });
      pending.clear();
      resolve(outcome);
    };

    const send = (type: string, payload: Record<string, unknown> = {}) => {
      const id = `symphony-${nextId++}`;
      child.stdin?.write(JSON.stringify({ id, type, ...payload }) + "\n");
      return new Promise<any>((resolveResponse) => pending.set(id, resolveResponse));
    };

    const requestStats = async () => {
      try {
        const response = await Promise.race([
          send("get_session_stats"),
          new Promise<any>((resolveTimeout) => setTimeout(() => resolveTimeout({ success: false, error: "stats timeout" }), 5000)),
        ]);
        if (response?.success) applySessionStats(worker, response.data);
      } catch {
        // Best effort only; the run outcome should not depend on usage availability.
      }
    };

    const markActivity = (eventType: string, message?: string) => {
      worker.lastActivityAt = Date.now();
      worker.sessionInfo = {
        ...(worker.sessionInfo ?? { turnCount: 0 }),
        turnCount: worker.sessionInfo?.turnCount ?? 0,
        lastEvent: eventType,
        lastMessage: message ?? worker.sessionInfo?.lastMessage,
        lastActivityAt: worker.lastActivityAt,
      };
      if (eventType === "turn_end") worker.sessionInfo.turnCount += 1;
    };

    const handleMessage = async (message: any) => {
      if (message?.type === "response" && message.id && pending.has(message.id)) {
        const resolvePending = pending.get(message.id)!;
        pending.delete(message.id);
        resolvePending(message);
        return;
      }

      if (typeof message?.type === "string") {
        markActivity(message.type, typeof message.message === "string" ? message.message : undefined);
      }

      if (message?.type === "agent_end") {
        await requestStats();
        const turns = worker.sessionInfo?.turnCount ?? 0;
        if (turns < workflow.config.agent.max_turns) {
          try {
            const [refreshed] = await createLinear(workflow).fetchIssueStatesByIds([worker.issue.id]);
            if (refreshed) worker.issue = refreshed;
            const activeStates = normalizedStateList(workflow.config.tracker.active_states);
            const terminalStates = normalizedStateList(workflow.config.tracker.terminal_states);
            const stateName = (refreshed?.state ?? worker.issue.state).toLowerCase();
            if (activeStates.includes(stateName) && !terminalStates.includes(stateName)) {
              const guidance = `Continue working on ${worker.issue.identifier}. Do not repeat the original task description; inspect the current repository and Linear state, continue from the existing session context, and either make progress or update Linear with a clear handoff.`;
              const response = await send("prompt", { message: guidance });
              if (response?.success) return;
              log("warn", "rpc_continuation_rejected", { issue_id: worker.issue.id, issue_identifier: worker.issue.identifier, reason: response?.error ?? "unknown" });
              await finish("failed");
              return;
            }
          } catch (error: any) {
            log("warn", "rpc_continuation_state_refresh_failed", { issue_id: worker.issue.id, issue_identifier: worker.issue.identifier, reason: error?.message ?? error });
            await finish("failed");
            return;
          }
        }
        await finish(worker.terminating ?? "normal");
      } else if (message?.type === "extension_error") {
        await requestStats();
        await finish("failed");
      }
    };

    const timeoutMs = workflow.config.codex.turn_timeout_ms;
    const timeout = setTimeout(async () => {
      worker.terminating = "timeout";
      await requestStats();
      await terminateProcessTree(child.pid ?? null, "timeout");
      await finish("timeout");
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          void handleMessage(JSON.parse(line));
        } catch (error: any) {
          log("warn", "rpc_malformed_message", { issue_id: worker.issue.id, issue_identifier: worker.issue.identifier, reason: error?.message ?? error });
        }
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk).slice(-4000);
      markActivity("stderr");
    });
    child.on("exit", async (code, signal) => {
      worker.lastActivityAt = Date.now();
      if (settled) return;
      if (worker.terminating) return finish(worker.terminating);
      log("warn", "rpc_process_exited_before_agent_end", { issue_id: worker.issue.id, issue_identifier: worker.issue.identifier, code, signal, stderr });
      await finish(code === 0 && signal == null ? "normal" : "failed");
    });
    child.on("error", async () => finish("failed"));

    send("prompt", { message: prompt }).then(async (response) => {
      if (!response?.success) {
        log("error", "rpc_prompt_rejected", { issue_id: worker.issue.id, issue_identifier: worker.issue.identifier, reason: response?.error ?? "unknown" });
        await finish("failed");
      }
    }).catch(async () => finish("failed"));
  });
}

async function handleWorkerExit(workflow: WorkflowDefinition, state: RunState, issueId: string, outcome: WorkerOutcome, error?: string) {
  const running = state.running.get(issueId);
  if (!running) return;
  state.running.delete(issueId);
  const duration = (Date.now() - running.startedAt) / 1000;
  state.usageTotals.seconds_running += duration;

  if (running.usage) {
    state.usageTotals.input += running.usage.input;
    state.usageTotals.output += running.usage.output;
    state.usageTotals.cacheRead += running.usage.cacheRead;
    state.usageTotals.cacheWrite += running.usage.cacheWrite;
    state.usageTotals.total += running.usage.total;
    state.usageTotals.cost += running.usage.cost;
  }

  if (outcome === "canceled_by_reconciliation") {
    state.claimed.delete(issueId);
    log("info", "worker_exit_canceled", { issue_id: running.issue.id, issue_identifier: running.issue.identifier, duration_seconds: duration });
    return;
  }

  if (outcome === "normal") {
    state.completed.add(issueId);
    scheduleRetry(state, running.issue, 1, workflow, undefined, true);
    log("info", "worker_exit_normal", { issue_id: running.issue.id, issue_identifier: running.issue.identifier, duration_seconds: duration });
  } else {
    scheduleRetry(state, running.issue, nextAttempt(running.attempt), workflow, error ?? `worker exited: ${outcome}`);
    log("warn", "worker_exit_abnormal", { issue_id: running.issue.id, issue_identifier: running.issue.identifier, outcome, error, duration_seconds: duration });
  }
}

export function getRuntimeSnapshot(state: RunState) {
  const now = Date.now();
  return {
    generated_at: new Date(now).toISOString(),
    counts: { running: state.running.size, retrying: state.retryAttempts.size, claimed: state.claimed.size },
    running: Array.from(state.running.values()).map((worker) => ({
      issue_id: worker.issue.id,
      issue_identifier: worker.issue.identifier,
      state: worker.issue.state,
      pid: worker.pid,
      workspace_path: worker.workspacePath,
      attempt: worker.attempt,
      started_at: new Date(worker.startedAt).toISOString(),
      last_activity_at: new Date(worker.lastActivityAt).toISOString(),
      runtime_seconds: (now - worker.startedAt) / 1000,
      session: worker.sessionInfo ?? null,
      usage: worker.usage ?? { source: "unavailable", estimated: true },
    })),
    retrying: Array.from(state.retryAttempts.values()).map((retry) => ({
      issue_id: retry.issue_id,
      issue_identifier: retry.identifier,
      attempt: retry.attempt,
      due_at: new Date(retry.dueAtMs).toISOString(),
      error: retry.error ?? null,
    })),
    usage_totals: {
      ...state.usageTotals,
      seconds_running: state.usageTotals.seconds_running + Array.from(state.running.values()).reduce((sum, worker) => sum + (now - worker.startedAt) / 1000, 0),
    },
    latest_provider_limits: state.latestProviderLimits,
    last_errors: state.lastErrors,
    preflight_error: lastPreflightError,
    runtime_seconds: (now - state.startedAt) / 1000,
  };
}

export function getCurrentRuntimeSnapshot() {
  if (!authoritativeState) {
    return {
      generated_at: new Date().toISOString(),
      counts: { running: 0, retrying: 0, claimed: 0 },
      running: [],
      retrying: [],
      usage_totals: null,
      latest_provider_limits: null,
      last_errors: lastPreflightError ? [lastPreflightError] : [],
      preflight_error: lastPreflightError,
      runtime_seconds: 0,
    };
  }
  return getRuntimeSnapshot(authoritativeState);
}

export function formatRuntimeStatus(snapshot = getCurrentRuntimeSnapshot()) {
  const lines: string[] = [];
  lines.push(`Symphony status generated_at=${snapshot.generated_at}`);
  if (snapshot.preflight_error) lines.push(`Preflight: FAILED ${snapshot.preflight_error}`);
  else lines.push("Preflight: ok");
  lines.push(`Counts: running=${snapshot.counts.running} retrying=${snapshot.counts.retrying} claimed=${snapshot.counts.claimed}`);
  lines.push(`Usage: ${snapshot.usage_totals ? `tokens=${snapshot.usage_totals.total} input=${snapshot.usage_totals.input} output=${snapshot.usage_totals.output} cacheRead=${snapshot.usage_totals.cacheRead} cacheWrite=${snapshot.usage_totals.cacheWrite} cost=${snapshot.usage_totals.cost}` : "unavailable"}`);
  if (snapshot.running.length > 0) {
    lines.push("Running:");
    for (const row of snapshot.running as any[]) {
      lines.push(`- ${row.issue_identifier} state=${row.state} pid=${row.pid ?? "?"} workspace=${row.workspace_path} lastActivity=${row.last_activity_at} session=${row.session?.sessionId ?? "unavailable"} usage=${row.usage?.total ?? "unavailable"}`);
    }
  }
  if (snapshot.retrying.length > 0) {
    lines.push("Retries:");
    for (const row of snapshot.retrying as any[]) {
      lines.push(`- ${row.issue_identifier} attempt=${row.attempt} due=${row.due_at} error=${row.error ?? ""}`);
    }
  }
  if (snapshot.last_errors.length > 0) {
    lines.push("Recent errors:");
    for (const error of snapshot.last_errors.slice(0, 5)) lines.push(`- ${error}`);
  }
  return lines.join("\n");
}
