import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadWorkflow, parseWorkflowContent, resolveWorkflowConfig, WorkflowConfigError } from "../src/config.js";
import { renderPrompt } from "../src/orchestrator.js";
import type { Issue } from "../src/linear.js";

const issue: Issue = {
  id: "1",
  identifier: "ENG-1",
  title: "Title",
  description: "Desc",
  priority: 1,
  state: "Todo",
  branch_name: null,
  url: null,
  labels: ["symphony"],
  blocked_by: [],
  created_at: null,
  updated_at: null,
};

function secureConfig(overrides: Record<string, any> = {}) {
  return {
    tracker: { kind: "linear", project_slug: "PROJ", ...(overrides.tracker ?? {}) },
    workspace: { strategy: "git-worktree", ...(overrides.workspace ?? {}) },
    sandbox: { kind: "docker-sbx", ...(overrides.sandbox ?? {}) },
    agent: { runner: "rpc", ...(overrides.agent ?? {}) },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["tracker", "workspace", "sandbox", "agent"].includes(key))),
  };
}

describe("workflow config", () => {
  const oldKey = process.env.LINEAR_API_KEY;
  beforeEach(() => { process.env.LINEAR_API_KEY = "lin_test"; });
  afterEach(() => {
    if (oldKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = oldKey;
  });

  it("rejects non-map frontmatter", () => {
    expect(() => parseWorkflowContent("---\n- nope\n---\nbody")).toThrow(WorkflowConfigError);
  });

  it("applies defaults and resolves workspace paths relative to workflow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "symphony-config-"));
    const workflowPath = join(dir, "nested", "WORKFLOW.md");
    await import("fs/promises").then(fs => fs.mkdir(join(dir, "nested"), { recursive: true }));
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  project_slug: PROJ\nworkspace:\n  strategy: git-worktree\n  root: .work\nsandbox:\n  kind: docker-sbx\n---\nHello {{ issue.identifier }} attempt {{ attempt }}`);
    const workflow = await loadWorkflow(workflowPath);
    expect(workflow.config.workspace.root).toBe(join(dir, "nested", ".work"));
    expect(workflow.config.agent.max_concurrent_agents).toBe(10);
    expect(workflow.config.sandbox.kind).toBe("docker-sbx");
    expect(workflow.config.workspace.strategy).toBe("git-worktree");
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves explicit api key env vars and LINEAR_API_KEY fallback", () => {
    process.env.MY_LINEAR_KEY = "lin_env";
    const config = resolveWorkflowConfig(secureConfig({ tracker: { api_key: "$MY_LINEAR_KEY" } }), "/tmp/WORKFLOW.md");
    expect(config.tracker.api_key).toBe("lin_env");
    const fallback = resolveWorkflowConfig(secureConfig(), "/tmp/WORKFLOW.md");
    expect(fallback.tracker.api_key).toBe("lin_test");
  });

  it("rejects invalid numerics, unsupported tracker kind, and unsupported sandbox kind", () => {
    expect(() => resolveWorkflowConfig(secureConfig({ tracker: { kind: "github" } }), "/tmp/WORKFLOW.md")).toThrow(/Unsupported/);
    expect(() => resolveWorkflowConfig(secureConfig({ polling: { interval_ms: 0 } }), "/tmp/WORKFLOW.md")).toThrow(/positive integer/);
    expect(() => resolveWorkflowConfig(secureConfig({ sandbox: { kind: "vmware" } }), "/tmp/WORKFLOW.md")).toThrow(/sandbox.kind/);
  });

  it("requires docker sandbox, git worktree strategy, and rpc pi command", () => {
    expect(() => resolveWorkflowConfig({ tracker: { kind: "linear", project_slug: "P" } }, "/tmp/WORKFLOW.md")).toThrow(/docker-sbx/);
    expect(() => resolveWorkflowConfig(secureConfig({ workspace: { strategy: "directory" } }), "/tmp/WORKFLOW.md")).toThrow(/workspace.strategy/);
    expect(() => resolveWorkflowConfig(secureConfig({ agent: { runner: "shell" } }), "/tmp/WORKFLOW.md")).toThrow(/agent.runner/);
    expect(() => resolveWorkflowConfig(secureConfig({ agent: { command: "node worker.js" } }), "/tmp/WORKFLOW.md")).toThrow(/must invoke pi/);
    expect(() => resolveWorkflowConfig(secureConfig({ agent: { command: "pi -p hi" } }), "/tmp/WORKFLOW.md")).toThrow(/--mode rpc/);
  });

  it("parses docker sbx sandbox config", () => {
    const config = resolveWorkflowConfig(secureConfig({
      tracker: { project_slug: "P" },
      sandbox: { agent: "shell", name_prefix: "sym", template: "custom", kits: ["kit-a"], cpus: 0, memory: "8g", setup: "echo ok" }
    }), "/tmp/WORKFLOW.md");
    expect(config.sandbox).toMatchObject({ kind: "docker-sbx", agent: "shell", name_prefix: "sym", template: "custom", kits: ["kit-a"], cpus: 0, memory: "8g", setup: "echo ok" });
  });

  it("credential_providers defaults to empty array", () => {
    const config = resolveWorkflowConfig(secureConfig(), "/tmp/WORKFLOW.md");
    expect(config.sandbox.credential_providers).toEqual([]);
  });

  it("credential_providers preserves provided values", () => {
    const config = resolveWorkflowConfig(secureConfig({
      sandbox: { credential_providers: ["anthropic", "openai"] }
    }), "/tmp/WORKFLOW.md");
    expect(config.sandbox.credential_providers).toEqual(["anthropic", "openai"]);
  });

  it("rejects credential_providers with non-string values", () => {
    expect(() => resolveWorkflowConfig(secureConfig({
      sandbox: { credential_providers: ["anthropic", 42] }
    }), "/tmp/WORKFLOW.md")).toThrow(/sandbox.credential_providers/);
  });

  it("parses model_labels with lowercased keys, ignoring non-string values", () => {
    const config = resolveWorkflowConfig(secureConfig({
      agent: { model: "default-model", model_labels: { Opus: "big-model", SONNET: "mid-model", bad: 42, empty: "" } }
    }), "/tmp/WORKFLOW.md");
    expect(config.agent.model).toBe("default-model");
    expect(config.agent.model_labels).toEqual({ opus: "big-model", sonnet: "mid-model" });
  });

  it("defaults model_labels to empty when absent or non-map", () => {
    const config = resolveWorkflowConfig(secureConfig(), "/tmp/WORKFLOW.md");
    expect(config.agent.model_labels).toEqual({});
  });

  it("strict liquid rendering includes attempt and rejects unknown variables", async () => {
    const config = resolveWorkflowConfig(secureConfig(), "/tmp/WORKFLOW.md");
    await expect(renderPrompt({ config, prompt_template: "{{ issue.identifier }} {{ attempt }}", path: "/tmp/WORKFLOW.md" }, issue, 2)).resolves.toBe("ENG-1 2");
    await expect(renderPrompt({ config, prompt_template: "{{ missing.value }}", path: "/tmp/WORKFLOW.md" }, issue, null)).rejects.toThrow();
  });
});
