import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Square, Copy, Check, ArrowDown, Undo2, Plus, SendHorizontal, Pencil, X, GitBranch } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { MarkdownContent } from "./MarkdownContent.js";
import { ToolUseCard } from "./ToolUseCard.js";
import { RichPasteInput, type RichPasteInputHandle, type FileBlock } from "./RichPasteInput.js";
import type { Project } from "../types.js";
import { formatModelVersion } from "../lib/models.js";
import { useModels } from "../hooks/useModels.js";

type AgentStatus = "idle" | "waiting" | "running";
type LearningsStatus = "idle" | "generating";

interface ToolRequest {
  id: number;
  tool: string;
  reason: string | null;
  status: string;
  createdAt: string;
}

type SlashCmdType = "skill" | "command" | "agent" | "plugin" | "builtin" | "overlord";
interface SlashCmd {
  name: string;
  description?: string | null;
  type?: SlashCmdType;
  scope?: "project" | "global" | "plugin" | "builtin" | "overlord";
}

// Overlord-native slash commands. The CLI doesn't expose interactive commands
// in headless --print mode (and they'd do nothing there), so Overlord handles
// these itself — intercepted in handleSend, never sent to claude.
const OVERLORD_COMMANDS: SlashCmd[] = [
  { name: "model", description: "Changer le modèle — /model opus, ou /model pour lister", scope: "overlord", type: "overlord" },
  { name: "stop", description: "Stopper l'agent en cours", scope: "overlord", type: "overlord" },
  { name: "cost", description: "Afficher tokens et coût de la session", scope: "overlord", type: "overlord" },
  { name: "help", description: "Lister les commandes Overlord disponibles", scope: "overlord", type: "overlord" },
];
const OVERLORD_COMMAND_NAMES = new Set(OVERLORD_COMMANDS.map((c) => c.name));

// Merge bare command names (from a run's system/init event) into the rich list,
// without dropping the descriptions already loaded from /api/commands.
function mergeSlashNames(prev: SlashCmd[], names: string[]): SlashCmd[] {
  const have = new Set(prev.map((c) => c.name));
  const added = names
    .filter((n) => !have.has(n))
    .map((n): SlashCmd => ({ name: n, type: n.includes(":") ? "plugin" : "builtin" }));
  return added.length ? [...prev, ...added].sort((a, b) => a.name.localeCompare(b.name)) : prev;
}

interface OverlordDesktopBridge {
  isDesktop: boolean;
  notifyAgentDone: (payload: { projectName: string; body?: string }) => Promise<unknown>;
}

function getDesktopBridge() {
  return (window as Window & { overlordDesktop?: OverlordDesktopBridge }).overlordDesktop;
}

function notifyAgentDone(projectName: string) {
  const body = "Claude has finished its work.";
  const desktop = getDesktopBridge();
  if (desktop?.isDesktop) {
    void desktop.notifyAgentDone({ projectName, body });
    return;
  }

  if (document.hidden && Notification.permission === "granted") {
    new Notification(`Overlord - ${projectName}`, {
      body,
      icon: "/favicons/favicon-128.png",
    });
  }
}

interface PastedBlock {
  id: string;
  content: string;
  lineCount: number;
}

interface QueuedMessage {
  id: number;
  content: string;
}

interface ChatEntry {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  displayContent?: string; // What to show in UI (may differ from content sent to Claude)
  pastedBlocks?: PastedBlock[];
  fileBlocks?: FileBlock[];
  toolName?: string;
  toolInput?: Record<string, any>;
  toolResult?: string;
  snapshotSha?: string;
  eventIndex?: number;
}

interface Props {
  project: Project;
  input: string;
  onInputChange: (value: string) => void;
  activeWorkspaces: string[];
  onToggleWorkspace: (path: string) => void;
  // Any channel string is valid — sub-conversations use `sub:<conversationId>`.
  channel?: string;
  // When provided, each message shows a "branch" button that spins off a new
  // sub-conversation seeded with an excerpt ending at that message.
  onCreateBranch?: (payload: { contextText: string; title: string }) => void;
}

// Extract readable chat entries from Claude stream-json events
// `indexOffset` is the absolute position in the full events array (for pagination).
function extractFromEvents(events: any[], indexOffset = 0): ChatEntry[] {
  const entries: ChatEntry[] = [];
  let pendingText = "";

  function flushText() {
    if (pendingText.trim()) {
      entries.push({ id: crypto.randomUUID(), role: "assistant", content: pendingText.trim() });
      pendingText = "";
    }
  }

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === "user_message") {
      flushText();
      entries.push({
        id: crypto.randomUUID(),
        role: "user",
        content: ev.content,
        snapshotSha: ev.snapshotSha ?? undefined,
        eventIndex: indexOffset + i,
      });
    } else if (ev.type === "assistant") {
      const blocks = ev.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          pendingText += block.text;
        } else if (block.type === "tool_use") {
          flushText();
          entries.push({
            id: block.id ?? crypto.randomUUID(),
            role: "tool",
            content: block.name,
            toolName: block.name,
            toolInput: block.input,
          });
        } else if (block.type === "tool_result") {
          // Attach result to the last tool entry
          const lastTool = [...entries].reverse().find((e) => e.role === "tool");
          if (lastTool) {
            const text = Array.isArray(block.content)
              ? block.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
              : typeof block.content === "string" ? block.content : "";
            lastTool.toolResult = text;
          }
        }
      }
    } else if (ev.type === "result") {
      if (!pendingText.trim() && ev.result) {
        pendingText = ev.result;
      }
      flushText();
    }
  }

  flushText();
  return entries;
}

function InlineDisplay({ content, blocks, files }: { content: string; blocks: PastedBlock[]; files?: FileBlock[] }) {
  const blocksById = new Map(blocks.map((b) => [b.id, b]));
  const filesById = new Map((files ?? []).map((f) => [f.id, f]));
  type Part = { kind: "text"; text: string } | { kind: "paste"; block: PastedBlock } | { kind: "file"; file: FileBlock };
  const parts: Part[] = [];
  let lastIndex = 0;
  const regex = /\{\{(paste|file):([^}]+)\}\}/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) parts.push({ kind: "text", text: content.slice(lastIndex, match.index) });
    if (match[1] === "paste") {
      const block = blocksById.get(match[2]);
      if (block) parts.push({ kind: "paste", block });
      else parts.push({ kind: "text", text: match[0] });
    } else {
      const file = filesById.get(match[2]);
      if (file) parts.push({ kind: "file", file });
      else parts.push({ kind: "text", text: match[0] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) parts.push({ kind: "text", text: content.slice(lastIndex) });

  return (
    <div className="whitespace-pre-wrap">
      {parts.map((p, i) => {
        if (p.kind === "text") return <span key={i}>{p.text}</span>;
        if (p.kind === "paste") return <PastedBadge key={i} block={p.block} />;
        return <FileBadge key={i} file={p.file} />;
      })}
    </div>
  );
}

function FileBadge({ file }: { file: FileBlock }) {
  const sizeLabel = file.size < 1024
    ? `${file.size} B`
    : file.size < 1024 * 1024
      ? `${(file.size / 1024).toFixed(1)} KB`
      : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-primary-foreground/20 border border-primary-foreground/30 px-2 py-0.5 text-[11px] font-mono cursor-default"
      title={`${file.path} • ${sizeLabel}`}
    >
      📄 {file.filename} ({sizeLabel})
    </span>
  );
}

function PastedBadge({ block }: { block: PastedBlock }) {
  const [showPreview, setShowPreview] = useState(false);

  return (
    <span
      className="relative inline-flex items-center rounded-md bg-primary-foreground/20 border border-primary-foreground/30 px-2 py-0.5 text-[11px] font-mono cursor-default"
      onMouseEnter={() => setShowPreview(true)}
      onMouseLeave={() => setShowPreview(false)}
    >
      [{block.lineCount} copied line{block.lineCount > 1 ? "s" : ""}]
      {showPreview && (
        <div className="absolute bottom-full left-0 mb-1 w-80 max-h-48 overflow-auto rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg z-50 font-mono whitespace-pre-wrap">
          {block.content.slice(0, 2000)}
          {block.content.length > 2000 && "\n..."}
        </div>
      )}
    </span>
  );
}

function AddToTodoButton({ content, projectId }: { content: string; projectId: number }) {
  const [added, setAdded] = useState(false);

  const handleAdd = useCallback(async () => {
    const title = content.slice(0, 100).split("\n")[0];
    const description = content.length > 100 ? content.slice(0, 500) : undefined;
    await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title, description }),
    });
    setAdded(true);
    setTimeout(() => setAdded(false), 2000);
  }, [content, projectId]);

  return (
    <Tooltip>
      <TooltipTrigger>
        <span
          role="button"
          onClick={handleAdd}
          className="flex h-6 w-6 items-center justify-center rounded-md opacity-0 group-hover/msg:opacity-100 transition-opacity hover:bg-secondary cursor-pointer"
        >
          {added ? (
            <Check className="h-3 w-3 text-green-400" />
          ) : (
            <Plus className="h-3 w-3 text-muted-foreground" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" className="text-xs">
        Add to todos
      </TooltipContent>
    </Tooltip>
  );
}

// Always-visible "branch" affordance: opens a fresh sub-conversation seeded
// with the context ending at this message.
function BranchButton({ onBranch }: { onBranch: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger>
        <span
          role="button"
          onClick={onBranch}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-secondary hover:text-primary cursor-pointer"
        >
          <GitBranch className="h-3 w-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" className="text-xs">
        Open a branch conversation from here
      </TooltipContent>
    </Tooltip>
  );
}

const UserMessage = React.memo(function UserMessage({
  entry,
  projectId,
  onRollback,
  onBranch,
}: {
  entry: ChatEntry;
  projectId: number;
  onRollback: (content: string) => void;
  onBranch?: () => void;
}) {
  const [rolling, setRolling] = useState(false);
  const [confirmNeeded, setConfirmNeeded] = useState<string | null>(null);

  const handleRollback = useCallback(async (force = false) => {
    if (!entry.snapshotSha) return;
    setRolling(true);

    const endpoint = force ? "/api/agent/rollback/force" : "/api/agent/rollback";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        snapshotSha: entry.snapshotSha,
        messageIndex: entry.eventIndex,
      }),
    });
    const data = await res.json();

    if (data.needsConfirm) {
      setConfirmNeeded(data.error);
      setRolling(false);
      return;
    }

    if (data.ok) {
      onRollback(entry.content);
    }
    setRolling(false);
  }, [entry, projectId, onRollback]);

  return (
    <div className="group/user ml-auto max-w-[80%]">
      {/* Confirm dialog */}
      {confirmNeeded && (
        <div className="mb-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <p>{confirmNeeded}</p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => handleRollback(true)}
              className="rounded bg-destructive px-2 py-1 text-[11px] text-white hover:bg-destructive/80"
            >
              Roll back anyway
            </button>
            <button
              onClick={() => setConfirmNeeded(null)}
              className="rounded bg-secondary px-2 py-1 text-[11px] hover:bg-secondary/80"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="relative rounded-lg bg-primary px-4 py-3 text-primary-foreground">
        {/* Rollback button */}
        {entry.snapshotSha && (
          <button
            onClick={() => handleRollback()}
            disabled={rolling}
            className="absolute -left-8 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-md opacity-0 group-hover/user:opacity-100 transition-opacity hover:bg-secondary"
            title="Rollback: restore the code and put the message back into the input"
          >
            <Undo2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider opacity-50">
            You
          </span>
          {onBranch && (
            <span className="-mr-1 -mt-1 text-primary-foreground/70">
              <BranchButton onBranch={onBranch} />
            </span>
          )}
        </div>
        <div className="text-sm leading-relaxed select-text">
          {entry.displayContent ? (
            <InlineDisplay content={entry.displayContent} blocks={entry.pastedBlocks ?? []} files={entry.fileBlocks} />
          ) : (entry.pastedBlocks?.length || entry.fileBlocks?.length) ? (
            <div className="flex flex-wrap gap-1.5">
              {entry.pastedBlocks?.map((block) => (
                <PastedBadge key={block.id} block={block} />
              ))}
              {entry.fileBlocks?.map((file) => (
                <FileBadge key={file.id} file={file} />
              ))}
            </div>
          ) : (
            <div className="whitespace-pre-wrap">{entry.content}</div>
          )}
        </div>
      </div>
    </div>
  );
});

const MessageBubble = React.memo(function MessageBubble({ content, projectId, onBranch }: { content: string; projectId: number; onBranch?: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  return (
    <div className="group/msg relative max-w-[90%] rounded-lg border border-border bg-card px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider opacity-50">
          Claude
        </span>
        <div className="flex items-center gap-0.5">
          {onBranch && <BranchButton onBranch={onBranch} />}
          <AddToTodoButton content={content} projectId={projectId} />
          <Tooltip>
            <TooltipTrigger>
              <span
                role="button"
                onClick={handleCopy}
                className="flex h-6 w-6 items-center justify-center rounded-md opacity-0 transition-opacity group-hover/msg:opacity-100 hover:bg-secondary cursor-pointer"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-green-400" />
                ) : (
                  <Copy className="h-3 w-3 text-muted-foreground" />
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">Copy markdown</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="select-text">
        <MarkdownContent content={content} />
      </div>
    </div>
  );
});

// Persistent message queue: list, edit and delete pending messages.
function QueuePanel({
  queue,
  agentIdle,
  onEdit,
  onDelete,
  onClear,
  onRun,
}: {
  queue: QueuedMessage[];
  agentIdle: boolean;
  onEdit: (id: number, content: string) => void;
  onDelete: (id: number) => void;
  onClear: () => void;
  onRun: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  if (queue.length === 0) return null;

  const startEdit = (m: QueuedMessage) => {
    setEditingId(m.id);
    setDraft(m.content);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };
  const saveEdit = () => {
    if (editingId !== null && draft.trim()) onEdit(editingId, draft.trim());
    cancelEdit();
  };

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-yellow-400/20 bg-yellow-400/5">
      <div className="flex items-center gap-2 border-b border-yellow-400/10 px-3 py-1.5">
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/20 px-1.5 text-[10px] font-bold text-primary">
          {queue.length}
        </span>
        <span className="text-xs text-muted-foreground">
          pending message{queue.length > 1 ? "s" : ""}
        </span>
        {agentIdle && (
          <button
            onClick={onRun}
            className="text-[10px] font-medium text-primary hover:underline"
            title="Send the next queued message now"
          >
            Resume
          </button>
        )}
        <button
          onClick={onClear}
          className="ml-auto text-[10px] text-muted-foreground hover:text-destructive"
        >
          Vider la file
        </button>
      </div>
      <div className="max-h-[28vh] divide-y divide-yellow-400/10 overflow-y-auto scrollbar-visible">
        {queue.map((m, i) => (
          <div key={m.id} className="flex items-start gap-2 px-3 py-2">
            <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground/60">
              {i + 1}.
            </span>
            {editingId === m.id ? (
              <div className="flex flex-1 flex-col gap-1.5">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      saveEdit();
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      cancelEdit();
                    }
                  }}
                  autoFocus
                  rows={3}
                  className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <div className="flex gap-1.5">
                  <Button size="sm" className="h-6 text-[11px]" onClick={saveEdit}>
                    Enregistrer
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[11px]"
                    onClick={cancelEdit}
                  >
                    Annuler
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p className="flex-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/80 line-clamp-3">
                  {m.content}
                </p>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    onClick={() => startEdit(m)}
                    title="Modifier"
                    className="flex h-6 w-6 items-center justify-center rounded hover:bg-secondary"
                  >
                    <Pencil className="h-3 w-3 text-muted-foreground" />
                  </button>
                  <button
                    onClick={() => onDelete(m.id)}
                    title="Supprimer"
                    className="flex h-6 w-6 items-center justify-center rounded hover:bg-secondary"
                  >
                    <X className="h-3 w-3 text-muted-foreground" />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChatTab({ project, input, onInputChange, activeWorkspaces, onToggleWorkspace, channel = "chat", onCreateBranch }: Props) {
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<RichPasteInputHandle>(null);
  const [connected, setConnected] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const [learningsStatus, setLearningsStatus] = useState<LearningsStatus>("idle");
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [firstLoadedIndex, setFirstLoadedIndex] = useState(0);
  const [totalEvents, setTotalEvents] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [elapsed, setElapsed] = useState(0);

  // Model settings (fetched from project)
  const [model, setModel] = useState<string>("");
  // Concrete model resolved by the CLI (alias to full version), read from the `system/init` event.
  const [resolvedModel, setResolvedModel] = useState<string>("");
  // Model list with versions resolved dynamically by the server.
  const models = useModels();
  useEffect(() => {
    fetch(`/api/projects/${project.id}`)
      .then((r) => r.json())
      .then((data) => setModel(data.model ?? ""))
      .catch(() => {});
  }, [project.id]);

  const handleModelChange = useCallback(async (newModel: string) => {
    setModel(newModel);
    await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: newModel || null }),
    });
  }, [project.id]);

  // Codegraph status (chat channel only)
  const [codegraphStatus, setCodegraphStatus] = useState<{ indexed: boolean; indexing: boolean }>({ indexed: false, indexing: false });
  const fetchCodegraphStatus = useCallback(() => {
    if (channel !== "chat") return;
    fetch(`/api/codegraph/${project.id}/status`)
      .then((r) => r.json())
      .then((data) => setCodegraphStatus({ indexed: !!data.indexed, indexing: !!data.indexing }))
      .catch(() => {});
  }, [project.id, channel]);

  useEffect(() => {
    fetchCodegraphStatus();
    // Poll while indexing
    const interval = setInterval(() => {
      if (codegraphStatus.indexing) fetchCodegraphStatus();
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchCodegraphStatus, codegraphStatus.indexing]);

  const handleIndexCodegraph = useCallback(async () => {
    setCodegraphStatus((s) => ({ ...s, indexing: true }));
    await fetch(`/api/codegraph/${project.id}/init`, { method: "POST" });
    fetchCodegraphStatus();
  }, [project.id, fetchCodegraphStatus]);

  // Fetch workspace packages for the workspace selector
  const [workspacePackages, setWorkspacePackages] = useState<{ name: string; path: string; category: string }[]>([]);
  useEffect(() => {
    fetch(`/api/projects/${project.id}/workspaces`)
      .then((r) => r.json())
      .then((data) => {
        console.log("[chat] workspaces:", data?.packages?.length ?? 0);
        if (data.packages?.length) {
          setWorkspacePackages(data.packages.map((p: any) => ({ name: p.name, path: p.path, category: p.category })));
        } else {
          setWorkspacePackages([]);
        }
      })
      .catch((err) => { console.log("[chat] workspaces error:", err); setWorkspacePackages([]); });
  }, [project.id]);

  // Token usage tracking
  const [tokenStats, setTokenStats] = useState({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCost: 0,
    turns: 0,
  });

  // RTK savings
  const [rtkSavings, setRtkSavings] = useState<{
    total_commands: number;
    total_input: number;
    total_output: number;
    total_saved: number;
    avg_savings_pct: number;
  } | null>(null);

  // Codegraph usage estimate: heuristic tokens saved per tool call (arbitrary, tweakable).
  // Each value = rough tokens a Read+Grep equivalent would have consumed.
  const codegraphSavingsPerCall: Record<string, number> = {
    mcp__codegraph__codegraph_context: 8000,
    mcp__codegraph__codegraph_search: 3000,
    mcp__codegraph__codegraph_callers: 5000,
    mcp__codegraph__codegraph_callees: 5000,
    mcp__codegraph__codegraph_impact: 6000,
    mcp__codegraph__codegraph_explore: 4000,
    mcp__codegraph__codegraph_node: 1500,
    mcp__codegraph__codegraph_files: 500,
    mcp__codegraph__codegraph_status: 100,
  };

  const codegraphStats = useMemo(() => {
    const perTool: Record<string, { calls: number; consumed: number; saved: number }> = {};
    let totalCalls = 0;
    let totalConsumed = 0;
    let totalSaved = 0;
    for (const e of entries) {
      if (e.role !== "tool" || !e.toolName) continue;
      if (!e.toolName.startsWith("mcp__codegraph__")) continue;
      const consumed = Math.ceil((e.toolResult?.length ?? 0) / 4);
      const saved = codegraphSavingsPerCall[e.toolName] ?? 0;
      perTool[e.toolName] ??= { calls: 0, consumed: 0, saved: 0 };
      perTool[e.toolName].calls += 1;
      perTool[e.toolName].consumed += consumed;
      perTool[e.toolName].saved += saved;
      totalCalls += 1;
      totalConsumed += consumed;
      totalSaved += saved;
    }
    return { perTool, totalCalls, totalConsumed, totalSaved };
  }, [entries]);

  const formatMs = (ms: number | null) => ms === null ? "-" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  // Message queue: persisted server-side and synced through `queue:state` events.
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);

  // Per-turn latency tracking
  interface TurnTiming {
    sentAt: number;
    firstEventAt?: number;  // first stream event after start (process boot + first API byte)
    firstTextAt?: number;   // first assistant text delta (TTFT)
    firstToolAt?: number;   // first tool_use observed
    doneAt?: number;
    durationApiMs?: number; // from result.duration_api_ms
    durationMs?: number;    // from result.duration_ms
    numTurns?: number;
  }
  const [turnTimings, setTurnTimings] = useState<TurnTiming[]>([]);
  const currentTurnRef = useRef<TurnTiming | null>(null);

  // Latency aggregates
  const latencyStats = useMemo(() => {
    if (turnTimings.length === 0) return null;
    const last = turnTimings[turnTimings.length - 1];
    const completed = turnTimings.filter((t) => t.doneAt !== undefined);
    const recent = completed.slice(-5);

    const lastTTFE = last.firstEventAt !== undefined ? last.firstEventAt - last.sentAt : null;
    const lastTTFT = last.firstTextAt !== undefined ? last.firstTextAt - last.sentAt : null;
    const lastTTFA = last.firstToolAt !== undefined ? last.firstToolAt - last.sentAt : null;
    const lastTotal = last.doneAt !== undefined ? last.doneAt - last.sentAt : null;
    const lastApi = last.durationApiMs ?? null;
    const lastNumTurns = last.numTurns ?? null;

    const avg = (vals: (number | undefined)[]) => {
      const xs = vals.filter((v): v is number => typeof v === "number");
      if (xs.length === 0) return null;
      return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    };

    const avgTTFE = avg(recent.map((t) => t.firstEventAt !== undefined ? t.firstEventAt - t.sentAt : undefined));
    const avgTTFT = avg(recent.map((t) => t.firstTextAt !== undefined ? t.firstTextAt - t.sentAt : undefined));
    const avgTotal = avg(recent.map((t) => t.doneAt !== undefined ? t.doneAt - t.sentAt : undefined));
    const avgApi = avg(recent.map((t) => t.durationApiMs));

    return {
      lastTTFE, lastTTFT, lastTTFA, lastTotal, lastApi, lastNumTurns,
      avgTTFE, avgTTFT, avgTotal, avgApi,
      sampleSize: recent.length,
    };
  }, [turnTimings]);

  // Pasted content: stored separately and shown as badges.
  const [pastedBlocks, setPastedBlocks] = useState<{ id: string; content: string; lineCount: number }[]>([]);
  const [fileBlocks, setFileBlocks] = useState<FileBlock[]>([]);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initialScrollDone = useRef(false);
  const userScrolledUp = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Track current tool being used (for streaming tool input)
  const currentToolRef = useRef<{ id: string; name: string; inputJson: string } | null>(null);
  // Track event index to deduplicate events after subscribe
  const lastEventIndexRef = useRef(0);

  // Slash commands — the authoritative list is discovered dynamically from the
  // CLI (GET /api/commands), enriched with descriptions, and refreshed by the
  // server whenever the Claude version changes. Live runs merge in any names
  // from their system/init event so the list stays current within a session.
  const [slashCommands, setSlashCommands] = useState<SlashCmd[]>([]);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);

  // Load the full command list as soon as the project opens, so the menu is
  // complete before the first message (not just after a turn emits init).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/commands/${project.id}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && Array.isArray(d?.commands)) setSlashCommands(d.commands);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Tool-access requests the agent filed (overlord_request_tool). Shown as a
  // banner the user approves/denies — the agent can never grant itself a tool.
  const [toolRequests, setToolRequests] = useState<ToolRequest[]>([]);
  const refreshToolRequests = useCallback(() => {
    fetch(`/api/tool-requests/${project.id}`)
      .then((r) => r.json())
      .then((d) => setToolRequests(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [project.id]);

  useEffect(() => {
    refreshToolRequests();
  }, [refreshToolRequests]);

  // The agent files requests mid-run; pick them up as soon as the turn ends.
  useEffect(() => {
    if (agentStatus === "idle") refreshToolRequests();
  }, [agentStatus, refreshToolRequests]);

  const resolveToolRequest = useCallback(
    async (reqId: number, action: "approve" | "deny") => {
      await fetch(`/api/tool-requests/${project.id}/${reqId}/${action}`, { method: "POST" }).catch(() => {});
      setToolRequests((prev) => prev.filter((r) => r.id !== reqId));
    },
    [project.id]
  );

  const showSlash = input.startsWith("/") && agentStatus === "idle" && !slashDismissed;
  const slashQuery = input.startsWith("/") ? input.slice(1).toLowerCase() : "";
  const filteredCommands = useMemo(() => {
    if (!showSlash) return [];
    const match = (c: SlashCmd) => c.name.toLowerCase().includes(slashQuery);
    // Overlord-native commands first, then the dynamic CLI/skill list (deduped).
    return [
      ...OVERLORD_COMMANDS.filter(match),
      ...slashCommands.filter((c) => !OVERLORD_COMMAND_NAMES.has(c.name) && match(c)),
    ];
  }, [showSlash, slashCommands, slashQuery]);

  useEffect(() => {
    if (!input.startsWith("/")) setSlashDismissed(false);
    setSlashIndex(0);
  }, [input]);

  // Fetch RTK savings when turns change
  useEffect(() => {
    if (tokenStats.turns === 0) return;
    fetch(`/api/rtk/gain/${project.id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.summary) setRtkSavings(data.summary);
      })
      .catch(() => {});
  }, [tokenStats.turns, project.id]);

  // Timer
  useEffect(() => {
    if (agentStatus === "waiting" || agentStatus === "running") {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [agentStatus]);

  // Auto-scroll only if user hasn't scrolled up
  useEffect(() => {
    if (!scrollRef.current) return;
    if (!initialScrollDone.current && entries.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      initialScrollDone.current = true;
    } else if (!userScrolledUp.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [entries, streamingText]);

  const loadOlderRef = useRef<() => void>(() => {});

  // Detect user scroll position + auto-load older when near top
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 80;
    userScrolledUp.current = !atBottom;
    setShowScrollBtn(!atBottom);
    if (scrollTop < 200) loadOlderRef.current();
  }, []);

  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    userScrolledUp.current = false;
    setShowScrollBtn(false);
  }, []);

  const loadOlder = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (firstLoadedIndex <= 0 || loadingOlder) return;
    setLoadingOlder(true);
    ws.send(JSON.stringify({
      type: "loadOlder",
      projectId: project.id,
      channel,
      beforeIndex: firstLoadedIndex,
      limit: 500,
    }));
  }, [firstLoadedIndex, loadingOlder, project.id, channel]);

  useEffect(() => {
    loadOlderRef.current = loadOlder;
  }, [loadOlder]);

  // WebSocket with auto-reconnect (browsers drop WS when tab is backgrounded)
  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const connect = () => {
      if (cancelled) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        attempts = 0;
        setConnected(true);
        ws.send(
          JSON.stringify({
            type: "subscribe",
            projectId: project.id,
            projectPath: project.path,
            channel,
          })
        );
      };

      ws.onclose = () => {
        setConnected(false);
        // Do not touch agentStatus. The server process is likely still running, and reconnect will resync.
        if (cancelled) return;
        const delay = Math.min(10000, 500 * Math.pow(2, attempts++));
        reconnectTimer = setTimeout(connect, delay);
      };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === "agent:history") {
        const offset = msg.firstLoadedIndex ?? 0;
        const parsed = extractFromEvents(msg.events, offset);
        setEntries(parsed);
        setFirstLoadedIndex(offset);
        setTotalEvents(msg.totalEvents ?? msg.eventCount ?? msg.events.length);
        setStreamingText("");
        lastEventIndexRef.current = msg.eventCount ?? msg.events.length;

        // Rebuild token stats from history
        let stats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, turns: 0 };
        for (const ev of msg.events) {
          if (ev.type === "system" && ev.subtype === "init" && ev.slash_commands) {
            setSlashCommands((prev) => mergeSlashNames(prev, ev.slash_commands));
          }
          if (ev.type === "system" && ev.subtype === "init" && ev.model) {
            setResolvedModel(ev.model);
          }
          if (ev.type === "result" && ev.usage) {
            stats.inputTokens += ev.usage.input_tokens ?? 0;
            stats.outputTokens += ev.usage.output_tokens ?? 0;
            stats.cacheReadTokens += ev.usage.cache_read_input_tokens ?? 0;
            stats.cacheWriteTokens += ev.usage.cache_creation_input_tokens ?? 0;
            stats.totalCost += ev.total_cost_usd ?? 0;
            stats.turns += 1;
          }
        }
        setTokenStats(stats);

        if (msg.status === "running") setAgentStatus("running");
        else setAgentStatus("idle");
      } else if (msg.type === "agent:older") {
        const offset = msg.firstLoadedIndex ?? 0;
        const olderEntries = extractFromEvents(msg.events, offset);
        const scrollEl = scrollRef.current;
        const prevScrollHeight = scrollEl?.scrollHeight ?? 0;
        const prevScrollTop = scrollEl?.scrollTop ?? 0;
        setEntries((prev) => [...olderEntries, ...prev]);
        setFirstLoadedIndex(offset);
        setLoadingOlder(false);
        // Preserve scroll position so the user stays at the same content
        requestAnimationFrame(() => {
          if (scrollEl) {
            const delta = scrollEl.scrollHeight - prevScrollHeight;
            scrollEl.scrollTop = prevScrollTop + delta;
          }
        });
      } else if (msg.type === "agent:ready") {
        setAgentStatus("idle");
      } else if (msg.type === "agent:start") {
        setAgentStatus("waiting");
        setStreamingText("");
        currentTurnRef.current = { sentAt: Date.now() };
      } else if (msg.type === "agent:snapshot") {
        // Upsert: patch the optimistic user bubble with the snapshot SHA.
        // For a queued message dispatched by the server, append a new bubble.
        setEntries((prev) => {
          const updated = [...prev];
          let found = false;
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === "user" && updated[i].content === msg.message && !updated[i].snapshotSha) {
              updated[i] = { ...updated[i], snapshotSha: msg.snapshotSha, eventIndex: msg.eventIndex };
              found = true;
              break;
            }
          }
          if (!found) {
            updated.push({
              id: crypto.randomUUID(),
              role: "user",
              content: msg.message,
              snapshotSha: msg.snapshotSha,
              eventIndex: msg.eventIndex,
            });
          }
          return updated;
        });
      } else if (msg.type === "agent:running") {
        setAgentStatus("running");
      } else if (msg.type === "agent:event") {
        // Skip events already included in the history replay
        if (msg.eventIndex && msg.eventIndex <= lastEventIndexRef.current) return;
        lastEventIndexRef.current = msg.eventIndex ?? lastEventIndexRef.current;
        if (typeof msg.eventIndex === "number") setTotalEvents(msg.eventIndex);

        const ev = msg.event;

        // Latency markers (first event of the turn = process boot + first API byte arrived)
        if (currentTurnRef.current && currentTurnRef.current.firstEventAt === undefined) {
          currentTurnRef.current.firstEventAt = Date.now();
        }

        if (ev.type === "system" && ev.subtype === "init" && ev.slash_commands) {
          setSlashCommands((prev) => mergeSlashNames(prev, ev.slash_commands));
        }
        if (ev.type === "system" && ev.subtype === "init" && ev.model) {
          setResolvedModel(ev.model);
        }

        if (ev.type === "stream_event") {
          const inner = ev.event;

          // Text streaming
          if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
            if (currentTurnRef.current && currentTurnRef.current.firstTextAt === undefined) {
              currentTurnRef.current.firstTextAt = Date.now();
            }
            setStreamingText((prev) => prev + inner.delta.text);
            setAgentStatus("running");
          }

          // Tool use start: flush text and begin tracking the tool.
          if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
            if (currentTurnRef.current && currentTurnRef.current.firstToolAt === undefined) {
              currentTurnRef.current.firstToolAt = Date.now();
            }
            // Flush pending text
            setStreamingText((prev) => {
              if (prev.trim()) {
                setEntries((e) => [
                  ...e,
                  { id: crypto.randomUUID(), role: "assistant", content: prev.trim() },
                ]);
              }
              return "";
            });
            currentToolRef.current = {
              id: inner.content_block.id,
              name: inner.content_block.name,
              inputJson: "",
            };
          }

          // Tool input streaming (JSON deltas)
          if (inner?.type === "content_block_delta" && inner.delta?.type === "input_json_delta" && currentToolRef.current) {
            currentToolRef.current.inputJson += inner.delta.partial_json;
          }

          // Tool use end: parse input and add the entry.
          if (inner?.type === "content_block_stop" && currentToolRef.current) {
            const tool = currentToolRef.current;
            currentToolRef.current = null;

            let toolInput: Record<string, any> = {};
            try {
              toolInput = JSON.parse(tool.inputJson);
            } catch {}

            setEntries((prev) => [
              ...prev,
              {
                id: tool.id,
                role: "tool",
                content: tool.name,
                toolName: tool.name,
                toolInput,
              },
            ]);
            setAgentStatus("running");

            // If agent called AskUserQuestion, pause it: kill the process and wait for user
            if (tool.name === "AskUserQuestion" && toolInput?.questions?.length > 0) {
              console.log("[chat] AskUserQuestion detected, pausing agent");
              wsRef.current?.send(JSON.stringify({ type: "stop", projectId: project.id, channel }));
            }
          }
        } else if (ev.type === "assistant") {
          // Complete assistant message. It might contain tool_result.
          const blocks = ev.message?.content ?? [];
          for (const block of blocks) {
            if (block.type === "tool_result") {
              const text = Array.isArray(block.content)
                ? block.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
                : typeof block.content === "string" ? block.content : "";
              // Attach to last tool entry with matching ID
              setEntries((prev) => {
                const updated = [...prev];
                const idx = updated.map((e, i) => e.role === "tool" && e.id === block.tool_use_id ? i : -1).filter(i => i >= 0).pop() ?? -1;
                if (idx >= 0) {
                  updated[idx] = { ...updated[idx], toolResult: text };
                }
                return updated;
              });
            }
          }
          setAgentStatus("running");
        } else if (ev.type === "result") {
          setStreamingText((prev) => {
            const text = prev.trim() || (ev.result ?? "").trim();
            if (text) {
              setEntries((e) => [
                ...e,
                { id: crypto.randomUUID(), role: "assistant", content: text },
              ]);
            }
            return "";
          });

          // Capture token stats
          if (ev.usage) {
            setTokenStats((prev) => ({
              inputTokens: prev.inputTokens + (ev.usage.input_tokens ?? 0),
              outputTokens: prev.outputTokens + (ev.usage.output_tokens ?? 0),
              cacheReadTokens: prev.cacheReadTokens + (ev.usage.cache_read_input_tokens ?? 0),
              cacheWriteTokens: prev.cacheWriteTokens + (ev.usage.cache_creation_input_tokens ?? 0),
              totalCost: prev.totalCost + (ev.total_cost_usd ?? 0),
              turns: prev.turns + 1,
            }));
          }

          // Capture CLI-reported durations from the result event
          if (currentTurnRef.current) {
            currentTurnRef.current.durationApiMs = ev.duration_api_ms;
            currentTurnRef.current.durationMs = ev.duration_ms;
            currentTurnRef.current.numTurns = ev.num_turns;
          }
        }
      } else if (msg.type === "agent:raw") {
        const text = typeof msg.data === "string" ? msg.data.trim() : "";
        if (text) {
          setEntries((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "assistant", content: text },
          ]);
        }
      } else if (msg.type === "agent:done") {
        // Finalize turn timing
        if (currentTurnRef.current) {
          currentTurnRef.current.doneAt = Date.now();
          const finalized = currentTurnRef.current;
          setTurnTimings((prev) => [...prev, finalized].slice(-20));
          currentTurnRef.current = null;
        }

        setStreamingText((prev) => {
          if (prev.trim()) {
            setEntries((e) => [
              ...e,
              { id: crypto.randomUUID(), role: "assistant", content: prev.trim() },
            ]);
          }
          return "";
        });

        // The server drains the queue itself; `willContinue` means another
        // turn is about to start, so stay busy and skip the "done" notification.
        if (!msg.willContinue) {
          setAgentStatus("idle");
          notifyAgentDone(project.name);
        } else {
          setAgentStatus("running");
        }
      } else if (msg.type === "queue:state") {
        if (!msg.channel || msg.channel === channel) {
          setMessageQueue(msg.queue ?? []);
        }
      } else if (msg.type === "learnings:generating" && msg.projectId === project.id) {
        setLearningsStatus("generating");
      } else if (msg.type === "learnings:done" && msg.projectId === project.id) {
        setLearningsStatus("idle");
      }
    };

    };  // end of connect()

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [project.id, project.path, channel]);

  // Ephemeral info bubble for command output (not persisted — display only).
  const pushInfo = useCallback((text: string) => {
    setEntries((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: text }]);
  }, []);

  // Intercept Overlord-native slash commands and run them locally instead of
  // sending them to the (headless) agent, where they'd do nothing. Returns true
  // if the input was a handled command.
  const handleOverlordCommand = useCallback(
    (raw: string): boolean => {
      const m = raw.trim().match(/^\/(\w[\w-]*)\s*([\s\S]*)$/);
      if (!m) return false;
      const cmd = m[1];
      const arg = m[2].trim();
      if (!OVERLORD_COMMAND_NAMES.has(cmd)) return false;

      if (cmd === "stop") {
        wsRef.current?.send(JSON.stringify({ type: "stop", projectId: project.id, channel }));
      } else if (cmd === "cost") {
        const t = tokenStats;
        pushInfo(
          `**Session — ${t.turns} tour(s)**\n` +
            `- Entrée : ${t.inputTokens.toLocaleString()} tokens` +
            (t.cacheReadTokens ? ` (dont ${t.cacheReadTokens.toLocaleString()} en cache)` : "") + `\n` +
            `- Sortie : ${t.outputTokens.toLocaleString()} tokens\n` +
            `- Coût : $${t.totalCost.toFixed(4)}`
        );
      } else if (cmd === "model") {
        if (arg) {
          const q = arg.toLowerCase();
          const found = models.find(
            (mm) => mm.id.toLowerCase() === q || mm.short?.toLowerCase() === q || mm.label.toLowerCase().includes(q)
          );
          if (found) {
            handleModelChange(found.id);
            pushInfo(`Modèle changé pour **${found.label}**.`);
          } else {
            pushInfo(`Modèle « ${arg} » introuvable. Disponibles : ${models.map((mm) => mm.short || mm.id).join(", ")}`);
          }
        } else {
          const current = models.find((mm) => mm.id === model)?.label ?? model ?? "défaut CLI";
          pushInfo(
            `Modèle actuel : **${current}**\n` +
              `Disponibles : ${models.map((mm) => mm.short || mm.id).join(", ")}\n` +
              `Usage : \`/model <nom>\``
          );
        }
      } else if (cmd === "help") {
        pushInfo(
          `**Commandes Overlord**\n` +
            OVERLORD_COMMANDS.map((c) => `- \`/${c.name}\` — ${c.description}`).join("\n") +
            `\n\nLes autres entrées \`/\` sont des skills/commands exécutées par l'agent.`
        );
      }

      setSlashDismissed(true);
      onInputChange("");
      return true;
    },
    [project.id, channel, tokenStats, models, model, handleModelChange, pushInfo, onInputChange]
  );

  const handleSend = useCallback(() => {
    // Overlord-native command? Handle it locally and don't send to the agent.
    if (handleOverlordCommand(input)) return;

    const currentBlocks = [...pastedBlocks];
    const currentFiles = [...fileBlocks];
    const typedText = input;

    // Replace {{paste:id}} placeholders with actual content at their position
    const blocksById = new Map(currentBlocks.map((b) => [b.id, b]));
    const filesById = new Map(currentFiles.map((f) => [f.id, f]));
    let rawMessage = typedText
      .replace(/\{\{paste:([^}]+)\}\}/g, (_, id) => {
        const block = blocksById.get(id);
        return block ? `\n${block.content}\n` : "";
      })
      .replace(/\{\{file:([^}]+)\}\}/g, (_, id) => {
        const file = filesById.get(id);
        return file ? `[Joined file at ${file.path}]` : "";
      })
      .trim();

    // If there are leftover blocks never referenced (shouldn't happen normally), append them
    const usedIds = new Set<string>();
    typedText.replace(/\{\{paste:([^}]+)\}\}/g, (_, id) => { usedIds.add(id); return ""; });
    const unusedBlocks = currentBlocks.filter((b) => !usedIds.has(b.id));
    if (unusedBlocks.length > 0) {
      rawMessage = [rawMessage, ...unusedBlocks.map((b) => b.content)].filter(Boolean).join("\n\n");
    }

    const usedFileIds = new Set<string>();
    typedText.replace(/\{\{file:([^}]+)\}\}/g, (_, id) => { usedFileIds.add(id); return ""; });
    const unusedFiles = currentFiles.filter((f) => !usedFileIds.has(f.id));
    if (unusedFiles.length > 0) {
      rawMessage = [rawMessage, ...unusedFiles.map((f) => `[Joined file at ${f.path}]`)].filter(Boolean).join("\n\n");
    }

    if (!rawMessage || !wsRef.current) return;

    // Inject workspace scope if workspaces are selected
    let fullMessage = rawMessage;
    if (activeWorkspaces.length > 0) {
      const scope = activeWorkspaces.join(", ");
      fullMessage = `[Scope: focus on ${scope} in this monorepo]\n\n${rawMessage}`;
    }

    setSlashDismissed(true);
    onInputChange("");
    setPastedBlocks([]);
    setFileBlocks([]);

    // Request notification permission on first interaction
    if (Notification.permission === "default") {
      Notification.requestPermission();
    }

    // Send immediately only when the agent is idle and the queue is empty.
    // otherwise append to the persistent server-side queue to preserve order.
    if (agentStatus !== "idle" || messageQueue.length > 0) {
      wsRef.current.send(
        JSON.stringify({
          type: "queue:add",
          projectId: project.id,
          projectPath: project.path,
          content: fullMessage,
          channel,
        })
      );
      return;
    }

    setAgentStatus("waiting");
    setEntries((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: fullMessage,
        displayContent: typedText.trim() || undefined,
        pastedBlocks: currentBlocks.length > 0 ? currentBlocks : undefined,
        fileBlocks: currentFiles.length > 0 ? currentFiles : undefined,
      },
    ]);

    wsRef.current.send(
      JSON.stringify({
        type: "chat",
        projectId: project.id,
        projectPath: project.path,
        message: fullMessage,
        channel,
      })
    );
  }, [input, pastedBlocks, fileBlocks, project, onInputChange, agentStatus, channel, activeWorkspaces, messageQueue, handleOverlordCommand]);

  const handleAnswerQuestions = useCallback((answer: string) => {
    if (!wsRef.current) return;

    // Queue the answer if the agent is still busy or messages are pending.
    if (agentStatus !== "idle" || messageQueue.length > 0) {
      wsRef.current.send(
        JSON.stringify({
          type: "queue:add",
          projectId: project.id,
          projectPath: project.path,
          content: answer,
          channel,
        })
      );
      return;
    }

    setAgentStatus("waiting");
    setEntries((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: answer },
    ]);

    wsRef.current.send(
      JSON.stringify({
        type: "chat",
        projectId: project.id,
        projectPath: project.path,
        message: answer,
        channel,
      })
    );
  }, [project, agentStatus, channel, messageQueue]);

  const handleStop = useCallback(() => {
    if (!wsRef.current) return;
    wsRef.current.send(
      JSON.stringify({ type: "stop", projectId: project.id, channel })
    );
  }, [project.id, channel]);

  // Build the seed context for a branch: up to the last 10 user/assistant
  // messages ending at the clicked one, formatted as a readable transcript.
  const handleBranch = useCallback(
    (entry: ChatEntry) => {
      if (!onCreateBranch) return;
      const idx = entries.findIndex((e) => e.id === entry.id);
      if (idx < 0) return;

      const collected: ChatEntry[] = [];
      for (let i = idx; i >= 0 && collected.length < 10; i--) {
        if (entries[i].role === "tool") continue;
        collected.unshift(entries[i]);
      }

      const contextText = collected
        .map((e) => {
          const who = e.role === "user" ? "You" : "Claude";
          const text = (e.displayContent || e.content || "").trim();
          return text ? `${who}: ${text}` : "";
        })
        .filter(Boolean)
        .join("\n\n");

      const clickedText = (entry.displayContent || entry.content || "").trim();
      const title = clickedText.split("\n")[0].slice(0, 60) || "Branch";
      onCreateBranch({ contextText, title });
    },
    [entries, onCreateBranch]
  );

  // Queue management: all mutations go through the server as the source of truth.
  const sendWs = useCallback((obj: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }, []);

  const handleQueueEdit = useCallback((id: number, content: string) => {
    sendWs({ type: "queue:update", projectId: project.id, channel, id, content });
  }, [sendWs, project.id, channel]);

  const handleQueueDelete = useCallback((id: number) => {
    sendWs({ type: "queue:delete", projectId: project.id, channel, id });
  }, [sendWs, project.id, channel]);

  const handleQueueClear = useCallback(() => {
    sendWs({ type: "queue:clear", projectId: project.id, channel });
  }, [sendWs, project.id, channel]);

  const handleQueueRun = useCallback(() => {
    sendWs({ type: "queue:run", projectId: project.id, projectPath: project.path, channel });
  }, [sendWs, project.id, project.path, channel]);

  const selectSlashCommand = useCallback(
    (cmd: string) => {
      onInputChange(`/${cmd} `);
      setSlashDismissed(true);
      textareaRef.current?.focus();
    },
    [onInputChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSlash && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        selectSlashCommand(filteredCommands[slashIndex].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatElapsed = (s: number) =>
    s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;

  const formatTokens = (n: number) =>
    n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` :
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` :
    String(n);

  const isWorking = agentStatus === "waiting" || agentStatus === "running";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-mono text-sm text-primary">
            claude @ {project.name}
          </span>
          {learningsStatus === "generating" && (
            <Badge
              variant="outline"
              className="gap-1.5 text-[10px] border-purple-400/40 text-purple-400 animate-pulse"
              title="The agent is analyzing this session to extract learnings"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-purple-400" />
              Analyzing session...
            </Badge>
          )}
          {channel === "chat" && (codegraphStatus.indexed || codegraphStatus.indexing) && (
            <Badge
              variant="outline"
              className={cn(
                "gap-1.5 text-[10px]",
                codegraphStatus.indexing && "border-amber-400/40 text-amber-400 animate-pulse",
                !codegraphStatus.indexing && codegraphStatus.indexed && "border-emerald-400/40 text-emerald-400"
              )}
              title={
                codegraphStatus.indexing
                  ? "CodeGraph is indexing the project"
                  : "CodeGraph indexed. Claude uses a semantic index to explore the code"
              }
            >
              <span className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                codegraphStatus.indexing && "bg-amber-400",
                !codegraphStatus.indexing && codegraphStatus.indexed && "bg-emerald-400"
              )} />
              {codegraphStatus.indexing ? "Indexing..." : codegraphStatus.indexed ? "Indexed" : "Not indexed"}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          <select
            value={model}
            onChange={(e) => handleModelChange(e.target.value)}
            className="hidden md:block rounded border border-border bg-secondary px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground focus:outline-none cursor-pointer font-mono"
            title="Claude model for this project"
            disabled={isWorking}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.short}</option>
            ))}
          </select>
          {resolvedModel && (
            <span
              className="hidden lg:inline text-[10px] text-muted-foreground font-mono"
              title={`Model resolved by the CLI: ${resolvedModel}`}
            >
              → {formatModelVersion(resolvedModel)}
            </span>
          )}
          {tokenStats.turns > 0 && (
            <Tooltip>
              <TooltipTrigger>
                <div className="hidden sm:flex items-center gap-2 text-[10px] text-muted-foreground font-mono cursor-help">
                  <span>{formatTokens(tokenStats.inputTokens)} in</span>
                  <span>{formatTokens(tokenStats.outputTokens)} out</span>
                  {tokenStats.cacheReadTokens > 0 && (
                    <span className="text-green-400/70">
                      {formatTokens(tokenStats.cacheReadTokens)} cache
                    </span>
                  )}
                  <span className="text-primary/70">
                    ${tokenStats.totalCost.toFixed(4)}
                  </span>
                  {rtkSavings && rtkSavings.total_saved > 0 && rtkSavings.avg_savings_pct < 100 && (
                    <span className="text-emerald-400 font-semibold">
                      RTK -{Math.round(rtkSavings.avg_savings_pct)}%
                    </span>
                  )}
                  {codegraphStatus.indexed && (
                    <span className={cn(
                      "font-semibold",
                      codegraphStats.totalCalls > 0 ? "text-cyan-400" : "text-muted-foreground/60"
                    )}>
                      CG {codegraphStats.totalCalls}×{codegraphStats.totalCalls > 0 ? ` ~${formatTokens(codegraphStats.totalSaved)}` : ""}
                    </span>
                  )}
                  {latencyStats && latencyStats.lastTTFT !== null && (
                    <span className="text-amber-400/80">
                      TTFT {formatMs(latencyStats.lastTTFT)}
                    </span>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="w-[720px] max-w-[calc(100vw-2rem)] items-start border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs leading-relaxed text-zinc-100 shadow-2xl [--tooltip-bg:theme(colors.zinc.950)]"
              >
                <div className="w-full space-y-1.5 font-sans">
                  <p><strong>{formatTokens(tokenStats.inputTokens)} in</strong>: tokens sent to Claude (your message + project context)</p>
                  <p><strong>{formatTokens(tokenStats.outputTokens)} out</strong>: tokens generated by Claude (its response)</p>
                  {tokenStats.cacheReadTokens > 0 && (
                    <p><strong className="text-green-400">{formatTokens(tokenStats.cacheReadTokens)} cache</strong>: tokens read from cache instead of being reprocessed (cost savings)</p>
                  )}
                  <p><strong className="text-primary">${tokenStats.totalCost.toFixed(4)}</strong>: cumulative API cost for this session ({tokenStats.turns} exchange{tokenStats.turns > 1 ? "s" : ""})</p>
                  {rtkSavings && rtkSavings.total_saved > 0 && rtkSavings.avg_savings_pct < 100 && (
                    <p><strong className="text-emerald-400">RTK -{Math.round(rtkSavings.avg_savings_pct)}%</strong>: tokens saved by RTK across {rtkSavings.total_commands} shell commands (compresses git status, ls, etc.)</p>
                  )}
                  {codegraphStatus.indexed && (
                    <div className="border-t border-border/50 pt-1.5 mt-1.5">
                      <p><strong className="text-cyan-400">Codegraph</strong>: {codegraphStats.totalCalls} call{codegraphStats.totalCalls > 1 ? "s" : ""}</p>
                      {codegraphStats.totalCalls > 0 ? (
                        <>
                          <p className="text-muted-foreground">Consumed: <strong>{formatTokens(codegraphStats.totalConsumed)}</strong> tokens (results read by Claude)</p>
                          <p className="text-muted-foreground">Estimated savings: <strong className="text-cyan-400">~{formatTokens(codegraphStats.totalSaved)}</strong> tokens vs equivalent Read/Grep calls</p>
                          <p className="text-[10px] italic opacity-60 mt-1">Rough heuristic (8k/context, 5k/callers, 3k/search, 0.5k/files). Saved/consumed ratio = {codegraphStats.totalConsumed > 0 ? (codegraphStats.totalSaved / codegraphStats.totalConsumed).toFixed(1) : "-"}x.</p>
                          <div className="mt-1 space-y-0.5">
                            {Object.entries(codegraphStats.perTool).map(([tool, s]) => (
                              <p key={tool} className="text-[10px] text-muted-foreground font-mono">
                                {tool.replace("mcp__codegraph__codegraph_", "")}: {s.calls}x, {formatTokens(s.consumed)} in / ~{formatTokens(s.saved)} saved
                              </p>
                            ))}
                          </div>
                        </>
                      ) : (
                        <p className="text-[10px] italic opacity-60 mt-1">
                          MCP is active but Claude did not call it. Mention it in your message ("use codegraph...") or add a nudge to the project system prompt.
                        </p>
                      )}
                    </div>
                  )}
                  {latencyStats && (
                    <div className="border-t border-border/50 pt-1.5 mt-1.5">
                      <p><strong className="text-amber-400">Latence (dernier turn)</strong></p>
                      <table className="text-[10px] font-mono mt-1 w-full">
                        <tbody>
                          <tr><td className="text-muted-foreground pr-2">TTFE (1er event)</td><td>{formatMs(latencyStats.lastTTFE)}</td></tr>
                          <tr><td className="text-muted-foreground pr-2">TTFT (1er texte)</td><td>{formatMs(latencyStats.lastTTFT)}</td></tr>
                          <tr><td className="text-muted-foreground pr-2">TTFA (1er tool)</td><td>{formatMs(latencyStats.lastTTFA)}</td></tr>
                          <tr><td className="text-muted-foreground pr-2">API time</td><td>{formatMs(latencyStats.lastApi)}</td></tr>
                          <tr><td className="text-muted-foreground pr-2">Total wall</td><td>{formatMs(latencyStats.lastTotal)}</td></tr>
                          <tr><td className="text-muted-foreground pr-2">Model turns</td><td>{latencyStats.lastNumTurns ?? "-"}</td></tr>
                        </tbody>
                      </table>
                      {latencyStats.sampleSize > 1 && (
                        <>
                          <p className="mt-1.5"><strong className="text-amber-400/70">Moyenne (derniers {latencyStats.sampleSize})</strong></p>
                          <table className="text-[10px] font-mono mt-1 w-full">
                            <tbody>
                              <tr><td className="text-muted-foreground pr-2">TTFE</td><td>{formatMs(latencyStats.avgTTFE)}</td></tr>
                              <tr><td className="text-muted-foreground pr-2">TTFT</td><td>{formatMs(latencyStats.avgTTFT)}</td></tr>
                              <tr><td className="text-muted-foreground pr-2">API</td><td>{formatMs(latencyStats.avgApi)}</td></tr>
                              <tr><td className="text-muted-foreground pr-2">Total</td><td>{formatMs(latencyStats.avgTotal)}</td></tr>
                            </tbody>
                          </table>
                        </>
                      )}
                      <p className="text-[10px] italic opacity-60 mt-1">
                        TTFE = boot CLI + handshake MCP + 1er byte API. TTFT &gt; TTFE = pure latence Anthropic. Si TTFE croit, c'est notre overhead (MCP, spawn).
                      </p>
                    </div>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
          <span
            className={cn(
              "text-xs",
              connected ? "text-green-400" : "text-red-400"
            )}
          >
            {connected ? "connected" : "disconnected"}
          </span>
        </div>
      </div>

      {/* Status bar */}
      {isWorking && (
        <div
          className={cn(
            "flex items-center gap-3 overflow-hidden border-b px-5 py-2 text-xs",
            agentStatus === "waiting"
              ? "border-yellow-400/20 bg-yellow-400/5 text-yellow-400"
              : "border-green-400/20 bg-green-400/5 text-green-400"
          )}
        >
          {agentStatus === "waiting"
            ? `Claude is starting... (${formatElapsed(elapsed)})`
            : `Claude is working... (${formatElapsed(elapsed)})`}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="relative flex-1 min-h-0 overflow-y-auto p-4 space-y-3 scrollbar-visible select-text">
        {firstLoadedIndex > 0 && (
          <div className="flex justify-center pt-1 pb-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={loadOlder}
              disabled={loadingOlder}
              className="text-xs text-muted-foreground"
            >
              {loadingOlder ? "Loading..." : `Load previous messages (${firstLoadedIndex} remaining)`}
            </Button>
          </div>
        )}
        {entries.length === 0 && !streamingText && agentStatus === "idle" && (
          <p className="text-center text-sm text-muted-foreground py-12">
            Start a conversation with Claude about{" "}
            <strong className="text-foreground">{project.name}</strong>
            <br />
            <span className="text-xs mt-1 inline-block">
              Type <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 text-[10px] font-mono">/</kbd> for commands
            </span>
          </p>
        )}

        {entries.map((entry) =>
          entry.role === "tool" ? (
            <ToolUseCard
              key={entry.id}
              name={entry.toolName ?? entry.content}
              input={entry.toolInput}
              result={entry.toolResult}
              onAnswerQuestions={handleAnswerQuestions}
            />
          ) : entry.role === "user" ? (
            <UserMessage
              key={entry.id}
              entry={entry}
              projectId={project.id}
              onBranch={onCreateBranch ? () => handleBranch(entry) : undefined}
              onRollback={(content) => {
                onInputChange(content);
                // Remove this message and everything after from entries
                setEntries((prev) => {
                  const idx = prev.findIndex((e) => e.id === entry.id);
                  return idx >= 0 ? prev.slice(0, idx) : prev;
                });
              }}
            />
          ) : (
            <MessageBubble
              key={entry.id}
              content={entry.content}
              projectId={project.id}
              onBranch={onCreateBranch ? () => handleBranch(entry) : undefined}
            />
          )
        )}

        {streamingText && (
          <div className="group/msg relative max-w-[90%] rounded-lg border border-border bg-card px-4 py-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider opacity-50">
              Claude
            </div>
            <div className="select-text">
              <MarkdownContent content={streamingText} />
            </div>
            <span className="inline-block h-4 w-0.5 animate-pulse bg-primary ml-0.5" />
          </div>
        )}

        {/* Typing indicator when agent is working but no text yet */}
        {isWorking && !streamingText && (
          <div className="max-w-[90%] rounded-lg border border-border bg-card px-4 py-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider opacity-50">
              Claude
            </div>
            <div className="flex items-center gap-1 py-1">
              <span className="h-2 w-2 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.3s]" />
              <span className="h-2 w-2 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.15s]" />
              <span className="h-2 w-2 rounded-full bg-primary/60 animate-bounce" />
              <span className="ml-2 text-[11px] text-muted-foreground">
                {agentStatus === "waiting" ? `Starting... ${formatElapsed(elapsed)}` : `${formatElapsed(elapsed)}`}
              </span>
            </div>
          </div>
        )}

        {/* Scroll to bottom button */}
        {showScrollBtn && (
          <div className="sticky bottom-2 z-10 flex justify-center pointer-events-none">
            <Button
              variant="secondary"
              size="sm"
              className="h-7 gap-1.5 rounded-full px-3 text-xs shadow-lg pointer-events-auto border border-border"
              onClick={scrollToBottom}
            >
              <ArrowDown className="h-3 w-3" />
              Latest message
            </Button>
          </div>
        )}
      </div>

      {/* Workspace scope selector */}
      {workspacePackages.length > 0 && (
        <div className="relative z-10 flex shrink-0 items-center gap-1.5 border-t border-border bg-card px-5 py-1.5 overflow-x-auto scrollbar-visible">
          <span className="text-[10px] text-muted-foreground shrink-0 mr-1">Scope:</span>
          {workspacePackages.map((pkg) => (
            <button
              key={pkg.path}
              onClick={() => onToggleWorkspace(pkg.path)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-mono transition-colors shrink-0",
                activeWorkspaces.includes(pkg.path)
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground hover:text-foreground"
              )}
            >
              {pkg.name}
            </button>
          ))}
          {activeWorkspaces.length > 0 && (
            <button
              onClick={() => activeWorkspaces.forEach((p) => onToggleWorkspace(p))}
              className="text-[10px] text-muted-foreground hover:text-foreground ml-1 shrink-0"
            >
              reset
            </button>
          )}
        </div>
      )}

      {/* Input area */}
      <div className="relative shrink-0 border-t border-border bg-card p-4">
        {showSlash && filteredCommands.length > 0 && (
          <div className="absolute bottom-full left-4 right-4 mb-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg scrollbar-visible">
            {filteredCommands.map((cmd, i) => (
              <button
                key={cmd.name}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors",
                  i === slashIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectSlashCommand(cmd.name);
                }}
                onMouseEnter={() => setSlashIndex(i)}
              >
                <span className="font-mono text-xs text-primary mt-0.5 shrink-0">/</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono truncate">{cmd.name}</span>
                    {cmd.scope && cmd.scope !== "builtin" && (
                      <span
                        className={cn(
                          "shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide",
                          cmd.scope === "project" && "bg-emerald-400/15 text-emerald-400",
                          cmd.scope === "global" && "bg-sky-400/15 text-sky-400",
                          cmd.scope === "plugin" && "bg-purple-400/15 text-purple-400",
                          cmd.scope === "overlord" && "bg-primary/20 text-primary"
                        )}
                      >
                        {cmd.scope}
                      </span>
                    )}
                  </span>
                  {cmd.description && (
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {cmd.description}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Tool-access requests from the agent — approve to add to allowedTools */}
        {toolRequests.length > 0 && (
          <div className="mb-2 flex flex-col gap-2">
            {toolRequests.map((req) => (
              <div
                key={req.id}
                className="flex items-start justify-between gap-3 rounded-md border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-amber-400 font-medium">
                    L'agent demande l'accès à{" "}
                    <code className="font-mono text-foreground">{req.tool}</code>
                  </span>
                  {req.reason && (
                    <span className="text-muted-foreground text-[10px]">{req.reason}</span>
                  )}
                  <span className="text-muted-foreground/70 text-[10px]">
                    Approuver l'ajoute à l'allowlist de ce projet.
                  </span>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 border-amber-400/40 text-amber-400 hover:bg-amber-400/10"
                    onClick={() => resolveToolRequest(req.id, "approve")}
                  >
                    Approuver
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-muted-foreground"
                    onClick={() => resolveToolRequest(req.id, "deny")}
                  >
                    Refuser
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* CodeGraph index suggestion */}
        {channel === "chat" && !codegraphStatus.indexed && !codegraphStatus.indexing && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-xs">
            <div className="flex flex-col gap-0.5">
              <span className="text-emerald-400 font-medium">Activer CodeGraph</span>
              <span className="text-muted-foreground text-[10px]">
                Index sémantique du code, -94% de tool calls pour Claude
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="text-xs gap-1.5 shrink-0"
              onClick={handleIndexCodegraph}
            >
              Indexer
            </Button>
          </div>
        )}

        {/* Queued messages — persisted, editable, deletable */}
        <QueuePanel
          queue={messageQueue}
          agentIdle={agentStatus === "idle"}
          onEdit={handleQueueEdit}
          onDelete={handleQueueDelete}
          onClear={handleQueueClear}
          onRun={handleQueueRun}
        />

        <div
          className="relative flex items-stretch"
          style={{ minHeight: "12vh", maxHeight: "20vh" }}
        >
          <RichPasteInput
            ref={textareaRef}
            value={input}
            onChange={onInputChange}
            onKeyDown={handleKeyDown}
            blocks={pastedBlocks}
            onPasteBlock={(block) => setPastedBlocks((prev) => [...prev, block])}
            onRemoveBlock={(id) => setPastedBlocks((prev) => prev.filter((b) => b.id !== id))}
            fileBlocks={fileBlocks}
            onFileSelect={async (file) => {
              const fd = new FormData();
              fd.append("file", file);
              fd.append("projectId", String(project.id));
              try {
                const res = await fetch("/api/uploads", { method: "POST", body: fd });
                if (!res.ok) return null;
                const data = await res.json();
                const block: FileBlock = {
                  id: data.id,
                  filename: data.filename,
                  path: data.path,
                  size: data.size,
                  mimeType: data.mimeType,
                };
                setFileBlocks((prev) => [...prev, block]);
                return block;
              } catch {
                return null;
              }
            }}
            onRemoveFileBlock={(id) => {
              setFileBlocks((prev) => prev.filter((f) => f.id !== id));
              fetch(`/api/uploads/${id}?projectId=${project.id}`, { method: "DELETE" }).catch(() => {});
            }}
            enableSpeech
            speechLang="fr-FR"
            placeholder={
              isWorking
                ? `Type a message (it will be sent when Claude is done)...`
                : `Message or / for commands...`
            }
            disabled={!connected}
            className={cn(
              "pb-12 pr-16",
              isWorking ? "border-yellow-400/30" : "border-border"
            )}
          />
          <div className="absolute bottom-2 right-2 z-20 flex items-center gap-1.5">
            {isWorking && (
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon-sm"
                    onClick={handleStop}
                  >
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Stop
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger>
                <Button
                  type="button"
                  onClick={handleSend}
                  disabled={!connected || (!input.trim() && pastedBlocks.length === 0 && fileBlocks.length === 0)}
                  variant={isWorking ? "secondary" : "default"}
                  size="icon-sm"
                >
                  <SendHorizontal className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {isWorking ? `Add to queue (${messageQueue.length + 1})` : "Send"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
