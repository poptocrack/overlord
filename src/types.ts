export interface Project {
  id: number;
  name: string;
  path: string;
  status: "active" | "paused" | "blocked";
  favorite: boolean;
  hidden: boolean;
  summary: string | null;
  lastSummaryAt: string | null;
  systemPrompt: string | null;
  model: string | null;
  allowedTools: string | null;
  tagline: string | null;
  shortDescription: string | null;
  longDescription: string | null;
  links: string | null;
  learningsEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  latestSession?: Session | null;
}

export interface Session {
  id: number;
  projectId: number;
  summary: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface Conversation {
  id: number;
  projectId: number;
  claudeSessionId: string | null;
  title: string | null;
  createdAt: string;
  lastResumedAt: string | null;
}

// A branch spun off from a message in the main chat. Returned by
// GET /api/conversations/sub/:projectId with live status merged in.
export interface SubConversation {
  id: number;
  projectId: number;
  title: string | null;
  contextText: string | null;
  parentConversationId: number | null;
  createdAt: string;
  unread: boolean;
  running: boolean;
  hasEvents: boolean;
  preview: string;
}

export interface WorkspaceInfo {
  type: "pnpm" | "yarn" | "npm" | "nx" | "lerna" | null;
  packages: WorkspacePackage[];
}

export interface WorkspacePackage {
  name: string;
  path: string;
  fullPath: string;
  category: "app" | "package" | "other";
  packageJson?: { name?: string; version?: string; description?: string };
}

export interface MarketingAsset {
  id: number;
  projectId: number;
  type: string;
  name: string;
  filePath: string;
  mimeType: string | null;
  createdAt: string;
}

export interface MarketingDraft {
  id: number;
  projectId: number;
  platform: string;
  title: string | null;
  content: string;
  status: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Learning {
  id: number;
  projectId: number;
  conversationId: number;
  deadEnds: string | null;
  missingContext: string | null;
  recommendations: string | null;
  rawReport: string;
  exported: boolean;
  reviewed: boolean;
  createdAt: string;
}

export interface Todo {
  id: number;
  projectId: number;
  title: string;
  description: string | null;
  done: boolean;
  sortOrder: number;
  createdAt: string;
}
