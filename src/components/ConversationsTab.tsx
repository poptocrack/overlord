import { useCallback } from "react";
import type { Project, SubConversation } from "../types.js";
import { GitBranch, Loader2, Trash2, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  project: Project;
  conversations: SubConversation[];
  onOpen: (conv: SubConversation) => void;
  onDelete: (id: number) => void;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function ConversationsTab({ project, conversations, onOpen, onDelete }: Props) {
  const handleDelete = useCallback(
    (e: React.MouseEvent, id: number) => {
      e.stopPropagation();
      onDelete(id);
    },
    [onDelete]
  );

  return (
    <div className="mx-auto max-w-3xl p-5">
      <div className="mb-4 flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Conversations</h2>
        <span className="text-xs text-muted-foreground">— {project.name}</span>
      </div>

      {conversations.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <MessageSquare className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No branches yet.</p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Click the <GitBranch className="inline h-3 w-3" /> icon on any chat message to start one.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => onOpen(conv)}
              className={cn(
                "group flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:bg-accent/40",
                conv.unread ? "border-primary/40 bg-primary/5" : "border-border"
              )}
            >
              {/* Status dot */}
              <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
                {conv.running ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-green-400" />
                ) : conv.unread ? (
                  <span className="h-2 w-2 rounded-full bg-primary" title="New reply" />
                ) : (
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                )}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={cn("truncate text-sm", conv.unread ? "font-semibold" : "font-medium")}>
                    {conv.title || "Branch"}
                  </span>
                  {conv.running && (
                    <span className="shrink-0 rounded bg-green-400/15 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                      running
                    </span>
                  )}
                  {!conv.running && conv.unread && (
                    <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      unread
                    </span>
                  )}
                </div>
                {conv.preview && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{conv.preview}</p>
                )}
                <p className="mt-0.5 text-[10px] text-muted-foreground/60">{timeAgo(conv.createdAt)}</p>
              </div>

              <span
                role="button"
                onClick={(e) => handleDelete(e, conv.id)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition-opacity hover:bg-secondary hover:text-destructive group-hover:opacity-100"
                title="Delete branch"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
