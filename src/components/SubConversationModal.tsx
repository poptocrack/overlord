import { useState, useCallback } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ChatTab } from "./ChatTab.js";
import type { Project } from "../types.js";
import type { SubConversation } from "../types.js";
import { GitBranch, X, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  project: Project;
  conversation: SubConversation;
  onClose: () => void;
}

// A branch chat rendered in a modal. It reuses the full ChatTab against the
// `sub:<id>` channel, so streaming, queue, stop and resume all work exactly like
// the main chat. Closing the modal only unsubscribes — the server-side process
// keeps running, so a busy branch can be reopened later to see its progress.
export function SubConversationModal({ project, conversation, onClose }: Props) {
  const [input, setInput] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [activeWorkspaces, setActiveWorkspaces] = useState<string[]>([]);

  const channel = `sub:${conversation.id}`;

  const toggleWorkspace = useCallback((path: string) => {
    setActiveWorkspaces((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  }, []);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[86vh] w-[94vw] max-w-[980px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[980px]"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <GitBranch className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate text-sm font-semibold" title={conversation.title ?? undefined}>
            {conversation.title || "Branch"}
          </span>
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            branch
          </span>
          <div className="ml-auto flex items-center gap-1">
            {conversation.contextText && (
              <button
                type="button"
                onClick={() => setContextOpen((o) => !o)}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                title="Context inherited from the parent conversation"
              >
                {contextOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Context
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label="Close"
              title="Close (the agent keeps running in the background)"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Inherited context excerpt */}
        {contextOpen && conversation.contextText && (
          <div className="max-h-[28vh] shrink-0 overflow-auto border-b border-border bg-muted/40 px-4 py-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Context provided to the agent
            </p>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80">
              {conversation.contextText}
            </pre>
          </div>
        )}

        {/* The branch chat */}
        <div className={cn("min-h-0 flex-1 overflow-hidden")}>
          <ChatTab
            key={channel}
            project={project}
            channel={channel}
            input={input}
            onInputChange={setInput}
            activeWorkspaces={activeWorkspaces}
            onToggleWorkspace={toggleWorkspace}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
