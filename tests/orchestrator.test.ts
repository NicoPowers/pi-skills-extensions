import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { ensureWorkspace, isCandidateEligible, resolveModelForIssue, sanitizeIdentifier, sandboxNameForIssue, sortForDispatch, toSandboxPath, validateIsolationPreflight } from "../src/orchestrator.js";
import { resolveWorkflowConfig, type WorkflowDefinition } from "../src/config.js";
import type { Issue } from "../src/linear.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(dir: string) {
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "test\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    identifier: "ENG-1",
    title: "T",
    description: null,
    priority: 2,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: ["symphony"],
    blocked_by: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: null,
    ...overrides,
  };
}

function workflow(root: string, workflowPath = join(root, "WORKFLOW.md")): WorkflowDefinition {
  return {
    path: workflowPath,
    prompt_template: "hi",
    config: resolveWorkflowConfig({
      tracker: { kind: "linear", api_key: "lin", project_slug: "PROJ" },
      workspace: { root, strategy: "git-worktree" },
      sandbox: { kind: "docker-sbx" },
      agent: { runner: "rpc" },
    }, workflowPath),
  };
}

function state() {
  return { running: new Map(), claimed: new Set(), retryAttempts: new Map(), completed: new Set(), codexTotals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 }, rateLimits: null, startedAt: Date.now(), lastErrors: [] } as any;
}

describe("orchestrator helpers", () => {
  it("sanitizes workspace keys and sandbox names", () => {
    expect(sanitizeIdentifier("ENG/1: bad")).toBe("ENG_1__bad");
    const wf = workflow(tmpdir());
    expect(sandboxNameForIssue(wf, issue({ identifier: "ENG/1: bad" }))).toBe("symphony-eng-1--bad");
  });

  it("creates/reuses Issue Worktrees and rejects existing files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "symphony-ws-"));
    await initGitRepo(dir);
    const root = join(dir, ".symphony_worktrees");
    const wf = workflow(root, join(dir, "WORKFLOW.md"));
    const ws = await ensureWorkspace(wf, issue({ identifier: "ENG/1" }));
    expect(ws.createdNow).toBe(true);
    expect(ws.branchName).toBe("agent/ENG_1");
    await expect(execFileAsync("git", ["-C", ws.path, "rev-parse", "--is-inside-work-tree"])).resolves.toBeTruthy();
    const ws2 = await ensureWorkspace(wf, issue({ identifier: "ENG/1" }));
    expect(ws2.createdNow).toBe(false);
    await writeFile(join(root, "ENG-2"), "file");
    await expect(ensureWorkspace(wf, issue({ identifier: "ENG-2" }))).rejects.toThrow(/not a directory/);
    await execFileAsync("git", ["worktree", "remove", "--force", ws.path], { cwd: dir }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it("requires Symphony label for Todo issues", () => {
    const wf = workflow(tmpdir());
    expect(isCandidateEligible(issue({ labels: [] }), wf, state()).ok).toBe(false);
    expect(isCandidateEligible(issue({ labels: ["symphony"] }), wf, state()).ok).toBe(true);
    expect(isCandidateEligible(issue({ state: "In Progress", labels: [] }), wf, state()).ok).toBe(true);
  });

  it("blocks Todo issues with non-terminal blockers", () => {
    const wf = workflow(tmpdir());
    expect(isCandidateEligible(issue({ blocked_by: [{ id: "2", identifier: "ENG-0", state: "In Progress" }] }), wf, state()).ok).toBe(false);
    expect(isCandidateEligible(issue({ blocked_by: [{ id: "2", identifier: "ENG-0", state: "Done" }] }), wf, state()).ok).toBe(true);
  });

  it("fails preflight clearly when sbx is unavailable", async () => {
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = "";
      await expect(validateIsolationPreflight(workflow(tmpdir()))).rejects.toThrow(/sbx|Docker Sandbox/i);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("resolves model from issue labels, falling back to workflow default", () => {
    const wf = workflow(tmpdir());
    wf.config.agent.model = "default-model";
    wf.config.agent.model_labels = { opus: "big-model", sonnet: "mid-model" };

    expect(resolveModelForIssue(wf, issue({ labels: ["symphony"] }))).toBe("default-model");
    expect(resolveModelForIssue(wf, issue({ labels: ["symphony", "opus"] }))).toBe("big-model");
    expect(resolveModelForIssue(wf, issue({ labels: ["sonnet", "opus"] }))).toBe("mid-model");
    expect(resolveModelForIssue(wf, issue({ labels: [] }))).toBe("default-model");
  });

  it("toSandboxPath converts Windows paths to Linux sandbox paths", () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    expect(toSandboxPath("C:\\Users\\nicol\\project")).toBe("/c/Users/nicol/project");
    expect(toSandboxPath("C:\\Users\\nicol\\worktrees\\ENG-42")).toBe("/c/Users/nicol/worktrees/ENG-42");
    expect(toSandboxPath("D:\\work\\repo")).toBe("/d/work/repo");
    expect(toSandboxPath("c:\\lowercase\\drive")).toBe("/c/lowercase/drive");

    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  });

  it("toSandboxPath is a no-op on non-Windows platforms", () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    expect(toSandboxPath("/home/user/project")).toBe("/home/user/project");
    expect(toSandboxPath("/c/Users/nicol/project")).toBe("/c/Users/nicol/project");

    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  });

  it("resolveModelForIssue returns undefined when no model is configured", () => {
    const wf = workflow(tmpdir());
    wf.config.agent.model = undefined;
    wf.config.agent.model_labels = {};
    expect(resolveModelForIssue(wf, issue())).toBeUndefined();
  });

  it("sorts by priority, created_at, then identifier", () => {
    const sorted = sortForDispatch([
      issue({ id: "b", identifier: "ENG-2", priority: 1, created_at: "2024-01-01T00:00:00Z" }),
      issue({ id: "a", identifier: "ENG-1", priority: 1, created_at: "2024-01-01T00:00:00Z" }),
      issue({ id: "c", identifier: "ENG-3", priority: null, created_at: "2023-01-01T00:00:00Z" }),
    ]);
    expect(sorted.map(i => i.identifier)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
  });
});
