import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { db } from "../db/index.js";
import { conversations, messages, projects } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createGitSnapshot } from "./git-snapshot.js";
import { broadcast, saveEvents, saveEventsNow } from "./sessions.js";
import { dequeueNext, broadcastQueueState } from "./queue.js";
import { broadcastAll } from "../ws.js";
import { buildEffectiveSystemPrompt } from "./system-prompt.js";
import { generateSummary } from "./summary.js";
import { generateLearnings } from "./learnings.js";
import { isIndexed as isCodegraphIndexed, runCodegraph, CODEGRAPH_BIN } from "../routes/codegraph.js";
import type { AgentSession } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PORT = Number(process.env.PORT) || 4747;

export function sendMessage(session: AgentSession, message: string) {
  if (session.currentProcess) {
    console.log(`[agent:${session.projectId}] already running, queuing not implemented`);
    return;
  }

  const snapshotSha = createGitSnapshot(session.projectPath);
  console.log(`[agent:${session.projectId}] snapshot: ${snapshotSha ?? "none"}`);

  const eventIndex = session.events.length;
  session.events.push({ type: "user_message", content: message, snapshotSha });
  saveEvents(session);
  db.insert(messages)
    .values({ conversationId: session.conversationId, role: "user", content: message })
    .run();

  broadcast(session, { type: "agent:snapshot", snapshotSha, eventIndex, message });

  const tsxBin = resolve(__dirname, "..", "..", "node_modules", ".bin", "tsx");
  const mcpServers: Record<string, any> = {
    overlord: {
      command: tsxBin,
      args: [resolve(__dirname, "..", "mcp.ts")],
      env: { OVERLORD_PORT: String(PORT) },
    },
  };

  if (session.channel === "chat" && isCodegraphIndexed(session.projectPath)) {
    mcpServers.codegraph = {
      command: CODEGRAPH_BIN,
      args: ["serve", "--mcp", "-p", session.projectPath],
    };
  }

  const mcpConfig = JSON.stringify({ mcpServers });

  const project = db.select().from(projects).where(eq(projects.id, session.projectId)).get();

  const codegraphActive = session.channel === "chat" && isCodegraphIndexed(session.projectPath);

  const { full: systemPrompt } = buildEffectiveSystemPrompt(project, session.channel, session.projectPath);

  const model = project?.model;

  const defaultTools = [
    "Edit", "Write", "Read", "Bash", "Glob", "Grep", "NotebookEdit",
    "WebFetch", "WebSearch", "ToolSearch", "Agent",
    "mcp__overlord__overlord_list_todos", "mcp__overlord__overlord_add_todo",
    "mcp__overlord__overlord_complete_todo", "mcp__overlord__overlord_delete_todo",
    "mcp__overlord__overlord_list_projects", "mcp__overlord__overlord_get_project",
    "mcp__overlord__overlord_ask_project",
  ];
  let allowedTools = defaultTools;
  if (project?.allowedTools) {
    try { allowedTools = JSON.parse(project.allowedTools); } catch {}
  }

  if (codegraphActive) {
    allowedTools = [
      ...allowedTools,
      "mcp__codegraph__codegraph_search",
      "mcp__codegraph__codegraph_context",
      "mcp__codegraph__codegraph_callers",
      "mcp__codegraph__codegraph_callees",
      "mcp__codegraph__codegraph_impact",
      "mcp__codegraph__codegraph_node",
      "mcp__codegraph__codegraph_explore",
      "mcp__codegraph__codegraph_files",
      "mcp__codegraph__codegraph_status",
    ];
  }

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--append-system-prompt", systemPrompt,
    "--mcp-config", mcpConfig,
    "--allowedTools", ...allowedTools,
  ];

  if (model) {
    args.push("--model", model);
  }

  if (session.claudeSessionId) {
    args.push("--resume", session.claudeSessionId);
  }

  args.push("--", message);

  console.log(`[agent:${session.projectId}] spawning: claude ${args.join(" ").slice(0, 100)}...`);

  const proc = spawn(CLAUDE_PATH, args, {
    cwd: session.projectPath,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  console.log(`[agent:${session.projectId}] pid=${proc.pid}`);

  session.currentProcess = proc;
  session.status = "running";
  broadcast(session, { type: "agent:running" });
  broadcastAll({ type: "agent:status_change", projectId: session.projectId, status: "running" });

  let buffer = "";
  proc.stdout!.on("data", (data: Buffer) => {
    resetActivityTimer();
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        session.events.push(event);

        if (event.type === "system" && event.subtype === "init" && event.session_id) {
          session.claudeSessionId = event.session_id;
          console.log(`[agent:${session.projectId}] session_id=${event.session_id}`);
        }

        console.log(`[agent:${session.projectId}] ${event.type}${event.subtype ? `:${event.subtype}` : ""}`);
        broadcast(session, { type: "agent:event", event, eventIndex: session.events.length });
        saveEvents(session);
      } catch {
        broadcast(session, { type: "agent:raw", data: line });
      }
    }
  });

  let staleSessionDetected = false;
  proc.stderr!.on("data", (data: Buffer) => {
    resetActivityTimer();
    const text = data.toString();
    console.log(`[agent:${session.projectId}] stderr: ${text.slice(0, 500)}`);
    if (text.includes("No conversation found with session ID")) {
      console.log(`[agent:${session.projectId}] stale session, clearing claudeSessionId`);
      staleSessionDetected = true;
      session.claudeSessionId = null;
    }
  });

  let activityTimer = setTimeout(() => {
    console.log(`[agent:${session.projectId}] timeout — no activity for 5 minutes, killing`);
    proc.kill("SIGTERM");
  }, 5 * 60 * 1000);

  const resetActivityTimer = () => {
    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
      console.log(`[agent:${session.projectId}] timeout — no activity for 5 minutes, killing`);
      proc.kill("SIGTERM");
    }, 5 * 60 * 1000);
  };

  proc.on("error", (err) => {
    clearTimeout(activityTimer);
    console.log(`[agent:${session.projectId}] process error: ${err.message}`);
    session.currentProcess = null;
    session.status = "idle";
    broadcast(session, { type: "agent:done", code: 1 });
    broadcastAll({ type: "agent:status_change", projectId: session.projectId, status: "error" });
  });

  proc.on("close", (code) => {
    clearTimeout(activityTimer);
    console.log(`[agent:${session.projectId}] done code=${code}`);
    session.currentProcess = null;
    session.status = "idle";
    saveEventsNow(session);

    if (staleSessionDetected && code !== 0) {
      console.log(`[agent:${session.projectId}] retrying without --resume`);
      setTimeout(() => sendMessage(session, message), 100);
      return;
    }

    // Drain the persistent queue: continue with the next message after a
    // successful turn. On error/stop the queue is kept intact for the user.
    const next = code === 0 ? dequeueNext(session.projectId, session.channel) : null;

    broadcast(session, { type: "agent:done", code, willContinue: !!next });
    const finalStatus = code === 0 ? "done" : "error";
    broadcastAll({ type: "agent:status_change", projectId: session.projectId, status: finalStatus });

    if (next) {
      console.log(`[agent:${session.projectId}] draining queued message`);
      dispatchMessage(session, next.content);
      return;
    }

    if (code === 0) {
      generateSummary(session);
      if (session.channel === "chat" && isCodegraphIndexed(session.projectPath)) {
        runCodegraph(["sync", session.projectPath], session.projectPath, 60000).catch(() => {});
      }
      if (session.channel === "chat" && project?.learningsEnabled !== false) {
        const toolUseCount = session.events.filter(
          (e: any) => e.type === "stream_event" && e.event?.type === "content_block_start" && e.event?.content_block?.type === "tool_use"
        ).length;
        const assistantMessages = session.events.filter((e: any) => e.type === "assistant").length;
        if (toolUseCount >= 3 || assistantMessages >= 3) {
          generateLearnings(session);
        }
      }
    }
  });
}

// Dispatch a message as a fresh turn: notify subscribers, then spawn the agent.
function dispatchMessage(session: AgentSession, content: string) {
  broadcastQueueState(session);
  broadcast(session, { type: "agent:start", message: content });
  sendMessage(session, content);
}

// If the agent is idle, pop the oldest queued message and run it.
// Returns true if a message was dispatched.
export function dispatchNext(session: AgentSession): boolean {
  if (session.currentProcess) return false;
  const next = dequeueNext(session.projectId, session.channel);
  if (!next) return false;
  dispatchMessage(session, next.content);
  return true;
}
