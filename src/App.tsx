import { useState, useCallback, useEffect, useRef } from "react";
import type { Project } from "./types.js";
import { useApi, post } from "./hooks/useApi.js";
import { ProjectSidebar } from "./components/Sidebar.js";
import { SummaryTab } from "./components/SummaryTab.js";
import { ChatTab } from "./components/ChatTab.js";
import { SettingsTab } from "./components/SettingsTab.js";
import { MarketingTab } from "./components/MarketingTab.js";
import { SkillsTab } from "./components/SkillsTab.js";
import { OpenInEditorButton } from "./components/OpenInEditorButton.js";
import { TodosTab } from "./components/TodosTab.js";
import { TerminalTab } from "./components/TerminalTab.js";
import { WorkspacesTab } from "./components/WorkspacesTab.js";
import { InsightsTab } from "./components/InsightsTab.js";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ExternalLink } from "lucide-react";

export type AgentStatusMap = Record<number, "none" | "idle" | "running" | "done" | "error">;

export function App() {
  const { data: projects, refetch } = useApi<Project[]>("/projects");
  const [selected, setSelected] = useState<Project | null>(null);
  const [tab, setTab] = useState(() => localStorage.getItem("overlord:tab") ?? "chat");
  const [chatInputs, setChatInputs] = useState<Record<number, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("overlord:chatInputs") ?? "{}");
    } catch { return {}; }
  });
  const [marketingInputs, setMarketingInputs] = useState<Record<number, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("overlord:marketingInputs") ?? "{}");
    } catch { return {}; }
  });
  const [restored, setRestored] = useState(false);
  const [agentStatuses, setAgentStatuses] = useState<AgentStatusMap>({});
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  // Active workspaces per project (for monorepo scope)
  const [activeWorkspaces, setActiveWorkspaces] = useState<Record<number, string[]>>(() => {
    try {
      return JSON.parse(localStorage.getItem("overlord:workspaces") ?? "{}");
    } catch { return {}; }
  });
  const statusWsRef = useRef<WebSocket | null>(null);

  // Restore selected project from localStorage when projects load
  useEffect(() => {
    if (restored || !projects?.length) return;
    const savedId = localStorage.getItem("overlord:projectId");
    if (savedId) {
      const found = projects.find((p) => p.id === Number(savedId));
      if (found) setSelected(found);
    }
    setRestored(true);
  }, [projects, restored]);

  // Persist selected project + fetch remote URL
  useEffect(() => {
    if (selected) {
      localStorage.setItem("overlord:projectId", String(selected.id));
      fetch(`/api/projects/${selected.id}`)
        .then((r) => r.json())
        .then((data) => setRemoteUrl(data.remoteUrl ?? null))
        .catch(() => setRemoteUrl(null));
    } else {
      setRemoteUrl(null);
    }
  }, [selected]);

  // Persist tab
  useEffect(() => {
    localStorage.setItem("overlord:tab", tab);
  }, [tab]);

  // Persist chat inputs (debounced to not lag the input during typing)
  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem("overlord:chatInputs", JSON.stringify(chatInputs));
    }, 500);
    return () => clearTimeout(t);
  }, [chatInputs]);

  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem("overlord:marketingInputs", JSON.stringify(marketingInputs));
    }, 500);
    return () => clearTimeout(t);
  }, [marketingInputs]);

  // Persist workspaces
  useEffect(() => {
    localStorage.setItem("overlord:workspaces", JSON.stringify(activeWorkspaces));
  }, [activeWorkspaces]);

  const handleToggleWorkspace = useCallback((projectId: number, path: string) => {
    setActiveWorkspaces((prev) => {
      const current = prev[projectId] ?? [];
      const next = current.includes(path)
        ? current.filter((p) => p !== path)
        : [...current, path];
      return { ...prev, [projectId]: next };
    });
  }, []);

  // Keep screen awake while at least one agent is running
  useEffect(() => {
    const anyRunning = Object.values(agentStatuses).some((s) => s === "running");
    if (!anyRunning) return;
    if (!("wakeLock" in navigator)) return;

    let wakeLock: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        wakeLock = await (navigator as any).wakeLock.request("screen");
        wakeLock?.addEventListener("release", () => { wakeLock = null; });
      } catch {
        // ignore (e.g. tab hidden, OS denied)
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible" && !wakeLock) acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      wakeLock?.release().catch(() => {});
    };
  }, [agentStatuses]);

  // Fetch initial agent statuses + listen for changes via WS (with auto-reconnect)
  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const refetchStatuses = () => {
      fetch("/api/agent/statuses")
        .then((r) => r.json())
        .then((data: Record<string, string>) => {
          const mapped: AgentStatusMap = {};
          for (const [k, v] of Object.entries(data)) {
            mapped[Number(k)] = v as AgentStatusMap[number];
          }
          setAgentStatuses(mapped);
        })
        .catch(() => {});
    };

    const connect = () => {
      if (cancelled) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      statusWsRef.current = ws;

      ws.onopen = () => {
        attempts = 0;
        // Resync after reconnect — server-side state may have changed
        refetchStatuses();
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "agent:status_change") {
          setAgentStatuses((prev) => ({
            ...prev,
            [msg.projectId]: msg.status,
          }));
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        const delay = Math.min(10000, 500 * Math.pow(2, attempts++));
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    refetchStatuses();
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      statusWsRef.current?.close();
    };
  }, []);

  const handleScan = useCallback(async () => {
    await post("/projects/scan");
    refetch();
  }, [refetch]);

  const handleSelect = useCallback((p: Project) => {
    setSelected(p);
    setTab("chat");
  }, []);

  // "Lancer" from Todos: put text in chat input and switch to chat tab
  const handleSendToChat = useCallback(
    (message: string) => {
      if (!selected) return;
      setChatInputs((prev) => ({ ...prev, [selected.id]: message }));
      setTab("chat");
    },
    [selected]
  );

  // Stable callbacks for the chat/marketing inputs — keyed by current project
  const handleChatInputChange = useCallback(
    (v: string) => {
      if (!selected) return;
      setChatInputs((prev) => ({ ...prev, [selected.id]: v }));
    },
    [selected]
  );
  const handleMarketingInputChange = useCallback(
    (v: string) => {
      if (!selected) return;
      setMarketingInputs((prev) => ({ ...prev, [selected.id]: v }));
    },
    [selected]
  );

  return (
    <TooltipProvider>
      <SidebarProvider>
        <ProjectSidebar
          projects={projects ?? []}
          selected={selected}
          agentStatuses={agentStatuses}
          onSelect={handleSelect}
          onScan={handleScan}
          onProjectUpdate={refetch}
        />
        <SidebarInset className="flex flex-col overflow-hidden min-h-0 h-screen">
          {selected ? (
            <div className="flex flex-1 flex-col overflow-hidden">
              <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
                <SidebarTrigger className="-ml-1" />
                <Separator orientation="vertical" className="mr-2 !h-4" />
                <h2 className="flex-1 flex items-center gap-2 text-sm font-semibold">
                  {selected.name}
                  {remoteUrl && (
                    <Tooltip>
                      <TooltipTrigger>
                        <a
                          href={remoteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">{remoteUrl}</TooltipContent>
                    </Tooltip>
                  )}
                  <OpenInEditorButton path={selected.path} />
                </h2>
                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList>
                    <TabsTrigger value="chat">Chat</TabsTrigger>
                    <TabsTrigger value="todos">Todos</TabsTrigger>
                    <TabsTrigger value="marketing">Marketing</TabsTrigger>
                    <TabsTrigger value="skills">Skills</TabsTrigger>
                    <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
                    <TabsTrigger value="summary">Resume</TabsTrigger>
                    <TabsTrigger value="insights">Insights</TabsTrigger>
                    <TabsTrigger value="terminal">Terminal</TabsTrigger>
                    <TabsTrigger value="settings">Settings</TabsTrigger>
                  </TabsList>
                </Tabs>
              </header>

              <div className="flex-1 overflow-hidden min-h-0">
                {tab === "summary" && (
                  <div className="h-full overflow-auto">
                    <SummaryTab project={selected} />
                  </div>
                )}
                {tab === "settings" && (
                  <div className="h-full overflow-auto">
                    <SettingsTab key={selected.id} project={selected} />
                  </div>
                )}
                {tab === "marketing" && (
                  <div className="h-full">
                    <MarketingTab
                      key={selected.id}
                      project={selected}
                      input={marketingInputs[selected.id] ?? ""}
                      onInputChange={handleMarketingInputChange}
                    />
                  </div>
                )}
                {tab === "skills" && (
                  <div className="h-full overflow-auto">
                    <SkillsTab key={selected.id} project={selected} />
                  </div>
                )}
                {tab === "todos" && (
                  <div className="h-full overflow-auto">
                    <TodosTab
                      project={selected}
                      onSendToChat={handleSendToChat}
                    />
                  </div>
                )}
                {tab === "workspaces" && (
                  <div className="h-full overflow-auto">
                    <WorkspacesTab project={selected} />
                  </div>
                )}
                {tab === "insights" && (
                  <div className="h-full overflow-auto">
                    <InsightsTab />
                  </div>
                )}
                {tab === "terminal" && (
                  <div className="h-full">
                    <TerminalTab project={selected} />
                  </div>
                )}
                {tab === "chat" && (
                  <ChatTab
                    key={selected.id}
                    project={selected}
                    input={chatInputs[selected.id] ?? ""}
                    onInputChange={handleChatInputChange}
                    activeWorkspaces={activeWorkspaces[selected.id] ?? []}
                    onToggleWorkspace={(path) => handleToggleWorkspace(selected.id, path)}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <SidebarTrigger className="absolute left-4 top-4" />
              <h2 className="text-3xl font-bold tracking-wider text-primary">
                Overlord
              </h2>
              <p className="text-sm text-muted-foreground">
                Selectionne un projet ou scanne le repertoire.
              </p>
            </div>
          )}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
