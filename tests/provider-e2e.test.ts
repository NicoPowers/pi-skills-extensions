import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

const E2E = process.env.SBX_E2E === "1";

interface ProviderCase {
  provider: string;
  model: string;
  envKey: string;
}

const ALL_CASES: ProviderCase[] = [
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", envKey: "ANTHROPIC_API_KEY" },
  { provider: "openai",    model: "gpt-4o-mini",               envKey: "OPENAI_API_KEY"    },
  { provider: "google",    model: "gemini-2.0-flash",          envKey: "GEMINI_API_KEY"    },
  { provider: "deepseek",  model: "deepseek-chat",             envKey: "DEEPSEEK_API_KEY"  },
  { provider: "mistral",   model: "mistral-small-latest",      envKey: "MISTRAL_API_KEY"   },
  { provider: "groq",      model: "llama-3.1-8b-instant",      envKey: "GROQ_API_KEY"      },
  { provider: "cerebras",  model: "llama3.1-8b",               envKey: "CEREBRAS_API_KEY"  },
  { provider: "xai",       model: "grok-3-mini",               envKey: "XAI_API_KEY"       },
  { provider: "openrouter",model: "openrouter/auto",           envKey: "OPENROUTER_API_KEY"},
  { provider: "minimax",   model: "abab6.5s-chat",             envKey: "MINIMAX_API_KEY"   },
  { provider: "kimi-coding",model: "moonshot-v1-8k",           envKey: "KIMI_API_KEY"      },
];

const PROVIDER_CASES = ALL_CASES.filter((c) => !!process.env[c.envKey]);

describe.skipIf(!E2E)("provider e2e — sbx + Pi RPC round-trip", () => {
  if (PROVIDER_CASES.length === 0) {
    it.todo("no provider API keys set — set at least one and re-run with SBX_E2E=1");
    return;
  }

  for (const { provider, model, envKey } of PROVIDER_CASES) {
    it(`${provider}/${model}`, async () => {
      const wsDir = await mkdtemp(join(tmpdir(), `sbx-e2e-${provider}-`));
      const sandboxName = `pi-e2e-${provider}-${Date.now()}`;
      const kitsDir = fileURLToPath(new URL("../extensions/symphony/kits/providers", import.meta.url));
      const kitPath = join(kitsDir, provider);

      try {
        // Create sandbox with provider kit; pass API key from host env
        await execFileAsync("sbx", ["create", "--name", sandboxName, "--kit", kitPath, "shell", wsDir], {
          env: { ...process.env },
          timeout: 60_000,
        });

        // Install Pi CLI inside the sandbox
        await execFileAsync("sbx", ["exec", sandboxName, "--", "bash", "-lc",
          "curl -fsSL https://pi.dev/install.sh | sh"], { timeout: 120_000 });

        // Send a minimal Pi RPC prompt and capture JSONL output
        const prompt = JSON.stringify({ type: "prompt", message: "Reply with exactly one word: hello" });
        const { stdout } = await execFileAsync("sbx", [
          "exec", sandboxName, "--", "bash", "-lc",
          `echo ${JSON.stringify(prompt)} | /home/agent/.pi/bin/pi --mode rpc --provider ${provider} --model ${model}`,
        ], { timeout: 60_000 });

        // Parse JSONL and assert agent_end received
        const lines = stdout.split("\n").filter(Boolean);
        const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const agentEnd = events.find((e: any) => e.type === "agent_end");
        expect(agentEnd, `expected agent_end event from ${provider}/${model}`).toBeDefined();
      } finally {
        await execFileAsync("sbx", ["rm", sandboxName]).catch(() => {});
        await rm(wsDir, { recursive: true, force: true });
      }
    }, { timeout: 240_000 });
  }
});
