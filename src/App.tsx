import { useState, useCallback, useEffect, useRef } from "react";
import type { Project, SubConversation } from "./types.js";
import { useApi, post } from "./hooks/useApi.js";
import { ProjectSidebar } from "./components/Sidebar.js";
import { SummaryTab } from "./components/SummaryTab.js";
import { ChatTab } from "./components/ChatTab.js";
import { ConversationsTab } from "./components/ConversationsTab.js";
import { SubConversationModal } from "./components/SubConversationModal.js";
import { SettingsTab } from "./components/SettingsTab.js";
import { MarketingTab } from "./components/MarketingTab.js";
import { SkillsTab } from "./components/SkillsTab.js";
import { OpenInEditorButton } from "./components/OpenInEditorButton.js";
import { OpenTerminalButton } from "./components/OpenTerminalButton.js";
import { TodosTab } from "./components/TodosTab.js";
import { WorkspacesTab } from "./components/WorkspacesTab.js";
import { WorkspaceOnboarding } from "./components/WorkspaceOnboarding.js";
import { InsightsTab } from "./components/InsightsTab.js";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ExternalLink, Menu } from "lucide-react";

export type AgentStatusMap = Record<number, "none" | "idle" | "running" | "done" | "error">;

type WorkspaceSettings = {
  path: string;
  configured: boolean;
  source: "user" | "env" | "default";
};

const VISIBLE_TABS = ["chat", "conversations", "todos", "marketing", "skills", "summary", "insights", "settings"] as const;
type VisibleTab = typeof VISIBLE_TABS[number];

const TAB_LABELS: Record<VisibleTab, string> = {
  chat: "Chat",
  conversations: "Conversations",
  todos: "Todos",
  marketing: "Marketing",
  skills: "Skills",
  summary: "Summary",
  insights: "Insights",
  settings: "Settings",
};

function normalizeTab(value: string | null | undefined): VisibleTab {
  return VISIBLE_TABS.includes(value as VisibleTab) ? (value as VisibleTab) : "chat";
}

function readRouteFromPathname() {
  const [projectSegment, tabSegment] = window.location.pathname
    .split("/")
    .filter(Boolean);
  const decodedProjectSegment = projectSegment ? decodeURIComponent(projectSegment) : null;
  const idMatch = decodedProjectSegment?.match(/^(\d+)(?:-|$)/);

  return {
    projectId: idMatch ? Number(idMatch[1]) : null,
    projectName: decodedProjectSegment,
    tab: normalizeTab(tabSegment),
  };
}

function getProjectRoute(project: Project, tab: string) {
  return `/${encodeURIComponent(`${project.id}-${project.name}`)}/${normalizeTab(tab)}`;
}

export function App() {
  const { data: workspaceSettings, refetch: refetchWorkspaceSettings } = useApi<WorkspaceSettings>("/settings/workspace");
  // Load hidden projects too — the sidebar filters them client-side, and its
  // "Afficher les cachés" toggle needs them present to reveal anything.
  const { data: projects, refetch } = useApi<Project[]>("/projects?hidden=true");
  const [selected, setSelected] = useState<Project | null>(null);
  const [tab, setTab] = useState<string>(() => {
    const route = readRouteFromPathname();
    return route.projectName ? route.tab : normalizeTab(localStorage.getItem("overlord:tab"));
  });
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
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

  // Sub-conversations ("branches") for the selected project + the one shown in
  // the modal. Kept at the top level so the modal survives tab switches and a
  // busy branch keeps running while the user navigates elsewhere.
  const [subConvs, setSubConvs] = useState<SubConversation[]>([]);
  const [openSubConv, setOpenSubConv] = useState<SubConversation | null>(null);
  const selectedRef = useRef<Project | null>(null);
  const openSubConvRef = useRef<SubConversation | null>(null);

  const refreshSubConvs = useCallback(() => {
    const proj = selectedRef.current;
    if (!proj) { setSubConvs([]); return; }
    fetch(`/api/conversations/sub/${proj.id}`)
      .then((r) => r.json())
      .then((d) => setSubConvs(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  useEffect(() => { openSubConvRef.current = openSubConv; }, [openSubConv]);

  // Refetch the branch list whenever the selected project changes.
  useEffect(() => {
    selectedRef.current = selected;
    setOpenSubConv(null);
    if (selected) refreshSubConvs();
    else setSubConvs([]);
  }, [selected, refreshSubConvs]);

  const subConvBadge = subConvs.filter((c) => c.running || c.unread).length;

  const handleCreateBranch = useCallback(
    async ({ contextText, title }: { contextText: string; title: string }) => {
      const proj = selectedRef.current;
      if (!proj) return;
      try {
        const res = await fetch("/api/conversations/sub", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: proj.id, contextText, title }),
        });
        if (!res.ok) return;
        const conv: SubConversation = await res.json();
        setOpenSubConv(conv);
        refreshSubConvs();
      } catch {
        // ignore
      }
    },
    [refreshSubConvs]
  );

  const handleOpenSubConv = useCallback((conv: SubConversation) => {
    setOpenSubConv(conv);
    if (conv.unread) {
      fetch(`/api/conversations/${conv.id}/read`, { method: "POST" })
        .then(() => refreshSubConvs())
        .catch(() => {});
    }
  }, [refreshSubConvs]);

  const handleCloseSubConv = useCallback(() => {
    const conv = openSubConvRef.current;
    setOpenSubConv(null);
    if (conv) {
      fetch(`/api/conversations/${conv.id}/read`, { method: "POST" })
        .then(() => refreshSubConvs())
        .catch(() => {});
    }
  }, [refreshSubConvs]);

  const handleDeleteSubConv = useCallback((id: number) => {
    if (openSubConvRef.current?.id === id) setOpenSubConv(null);
    fetch(`/api/conversations/${id}`, { method: "DELETE" })
      .then(() => refreshSubConvs())
      .catch(() => {});
  }, [refreshSubConvs]);

  // Restore selected project from URL first, then localStorage.
  useEffect(() => {
    if (restored || !projects?.length) return;
    const route = readRouteFromPathname();
    if (route.projectName) {
      const found = route.projectId
        ? projects.find((p) => p.id === route.projectId)
        : projects.find((p) => p.name === route.projectName);
      if (found) {
        setSelected(found);
        setTab(route.tab);
        setRestored(true);
        return;
      }
    }

    const savedId = localStorage.getItem("overlord:projectId");
    if (savedId) {
      const found = projects.find((p) => p.id === Number(savedId));
      if (found) setSelected(found);
    }
    setRestored(true);
  }, [projects, restored]);

  // Keep `selected` in sync with the refetched list, so edits made elsewhere
  // (e.g. saving allowedTools in Settings) are reflected in the prop instead of
  // reverting to a stale snapshot on remount.
  useEffect(() => {
    if (!selected || !projects) return;
    const fresh = projects.find((p) => p.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [projects, selected]);

  useEffect(() => {
    if (!projects?.length) return;

    const handlePopState = () => {
      const route = readRouteFromPathname();
      if (!route.projectName) return;

      const found = route.projectId
        ? projects.find((p) => p.id === route.projectId)
        : projects.find((p) => p.name === route.projectName);
      if (!found) return;

      setSelected(found);
      setTab(route.tab);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [projects]);

  useEffect(() => {
    if (!projects) return;
    if (selected && projects.some((project) => project.id === selected.id)) return;
    setSelected(projects[0] ?? null);
  }, [projects, selected]);

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

  useEffect(() => {
    if (!restored || !selected) return;

    const nextPath = getProjectRoute(selected, tab);
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", nextPath);
    }
  }, [restored, selected, tab]);

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
        // Resync after reconnect. Server-side state may have changed.
        refetchStatuses();
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "agent:status_change") {
          setAgentStatuses((prev) => ({
            ...prev,
            [msg.projectId]: msg.status,
          }));
        } else if (msg.type === "subchat:update") {
          const proj = selectedRef.current;
          if (proj && msg.projectId === proj.id) refreshSubConvs();
          // Keep the currently-open branch marked read as its turns finish, so
          // it never contributes to the notification badge while being viewed.
          const open = openSubConvRef.current;
          if (open && open.id === msg.conversationId && msg.status !== "running") {
            fetch(`/api/conversations/${msg.conversationId}/read`, { method: "POST" })
              .then(() => refreshSubConvs())
              .catch(() => {});
          }
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

  const handleWorkspaceConfigured = useCallback(async () => {
    setWorkspaceModalOpen(false);
    refetchWorkspaceSettings();
    setSelected(null);
    await post("/projects/scan");
    refetch();
  }, [refetch, refetchWorkspaceSettings]);

  const handleSelect = useCallback((p: Project) => {
    setSelected(p);
  }, []);

  // "Start" from Todos: put text in chat input and switch to chat tab
  const handleSendToChat = useCallback(
    (message: string) => {
      if (!selected) return;
      setChatInputs((prev) => ({ ...prev, [selected.id]: message }));
      setTab("chat");
    },
    [selected]
  );

  // Stable callbacks for chat and marketing inputs, keyed by current project.
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

  const handleTabChange = useCallback((value: string) => {
    setTab(normalizeTab(value));
    setTabMenuOpen(false);
  }, []);

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
          onOpenWorkspaceSettings={() => setWorkspaceModalOpen(true)}
        />
        {workspaceSettings && (!workspaceSettings.configured || workspaceModalOpen) && (
          <WorkspaceOnboarding
            initialPath={workspaceSettings.path}
            onComplete={handleWorkspaceConfigured}
            onCancel={workspaceSettings.configured ? () => setWorkspaceModalOpen(false) : undefined}
          />
        )}
        <SidebarInset className="flex flex-col overflow-hidden min-h-0 h-screen">
          {selected ? (
            <div className="flex flex-1 flex-col overflow-hidden">
              <header className="desktop-titlebar-drag flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
                <SidebarTrigger className="-ml-2" />
                <Separator orientation="vertical" className="mr-2" />
                <h2 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
                  <span className="truncate">{selected.name}</span>
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
                  <OpenTerminalButton path={selected.path} />
                </h2>
                <Tabs value={tab} onValueChange={handleTabChange} className="desktop-titlebar-no-drag hidden xl:flex">
                  <TabsList>
                    <TabsTrigger value="chat">Chat</TabsTrigger>
                    <TabsTrigger value="conversations" className="gap-1.5">
                      Conversations
                      {subConvBadge > 0 && (
                        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                          {subConvBadge}
                        </span>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="todos">Todos</TabsTrigger>
                    <TabsTrigger value="marketing">Marketing</TabsTrigger>
                    <TabsTrigger value="skills">Skills</TabsTrigger>
                    <TabsTrigger value="summary">Summary</TabsTrigger>
                    <TabsTrigger value="insights">Insights</TabsTrigger>
                    <TabsTrigger value="settings">Settings</TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="desktop-titlebar-no-drag relative xl:hidden">
                  <button
                    type="button"
                    onClick={() => setTabMenuOpen((open) => !open)}
                    className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-secondary px-2 text-xs text-muted-foreground hover:text-foreground"
                    aria-label="Open section menu"
                    aria-expanded={tabMenuOpen}
                  >
                    <Menu className="h-4 w-4" />
                    <span className="hidden sm:inline">{TAB_LABELS[normalizeTab(tab)]}</span>
                    {subConvBadge > 0 && (
                      <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                        {subConvBadge}
                      </span>
                    )}
                  </button>
                  {tabMenuOpen && (
                    <div className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg">
                      {VISIBLE_TABS.map((value) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => handleTabChange(value)}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                            normalizeTab(tab) === value ? "text-foreground" : "text-muted-foreground"
                          }`}
                        >
                          {TAB_LABELS[value]}
                          {value === "conversations" && subConvBadge > 0 && (
                            <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                              {subConvBadge}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </header>

              <div className="flex-1 overflow-hidden min-h-0">
                {tab === "summary" && (
                  <div className="h-full overflow-auto">
                    <SummaryTab project={selected} />
                  </div>
                )}
                {tab === "settings" && (
                  <div className="h-full overflow-auto">
                    <SettingsTab key={selected.id} project={selected} onProjectUpdate={refetch} />
                  </div>
                )}
                {tab === "marketing" && (
                  <div className="h-full">
                    <MarketingTab
                      key={selected.id}
                      project={selected}
                      input={marketingInputs[selected.id] ?? ""}
                      onInputChange={handleMarketingInputChange}
                      activeWorkspaces={activeWorkspaces[selected.id] ?? []}
                      onToggleWorkspace={(path) => handleToggleWorkspace(selected.id, path)}
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
                {tab === "conversations" && (
                  <div className="h-full overflow-auto">
                    <ConversationsTab
                      project={selected}
                      conversations={subConvs}
                      onOpen={handleOpenSubConv}
                      onDelete={handleDeleteSubConv}
                    />
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
                    onCreateBranch={handleCreateBranch}
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
                Select a project or scan the directory.
              </p>
            </div>
          )}
        </SidebarInset>
        {selected && openSubConv && (
          <SubConversationModal
            project={selected}
            conversation={openSubConv}
            onClose={handleCloseSubConv}
          />
        )}
      </SidebarProvider>
    </TooltipProvider>
  );
}
