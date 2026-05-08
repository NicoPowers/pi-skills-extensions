import { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatRuntimeStatus, runSymphony } from "../../src/orchestrator.js";
import { resolve } from "path";

export default function (pi: ExtensionAPI) {
  let isStopped = false;

  pi.on("session_shutdown", () => {
    isStopped = true;
  });

  pi.registerFlag("symphony", {
    description: "Start the Symphony orchestrator daemon",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("symphony", {
    description: "Start the Symphony orchestrator daemon",
    handler: async (args, ctx) => {
      ctx.ui.notify("Starting Symphony daemon...", "info");
      const workflowPath = args.trim() || resolve(ctx.cwd, "WORKFLOW.md");
      await runSymphony(pi, ctx, workflowPath, () => isStopped);
    },
  });

  pi.registerCommand("symphony-status", {
    description: "Show Symphony orchestrator status",
    handler: async (_args, ctx) => {
      const status = formatRuntimeStatus();
      ctx.ui.notify(status, "info");
      console.log(status);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("symphony")) {
      console.log("[Symphony] Starting daemon from flag...");
      const workflowPath = resolve(ctx.cwd, "WORKFLOW.md");

      runSymphony(pi, ctx, workflowPath, () => isStopped).catch(e => {
        console.error(`[Symphony] error: ${e.message}`);
      });
    }
  });
}
