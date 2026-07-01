import type { ChildProcess } from "child_process";
import type { WebSocket } from "ws";

// Sub-conversations ("branches") are encoded as `sub:<conversationId>` so each
// one gets its own independent in-memory session, queue and Claude session while
// reusing the exact same machinery as the regular chat/marketing channels.
export type Channel = "chat" | "marketing" | `sub:${number}`;

export function isSubChannel(channel: Channel): channel is `sub:${number}` {
  return typeof channel === "string" && channel.startsWith("sub:");
}

export function subConversationId(channel: Channel): number | null {
  if (!isSubChannel(channel)) return null;
  const id = Number(channel.slice("sub:".length));
  return Number.isFinite(id) ? id : null;
}

// Channels that operate on the project's code (chat + branches). These get the
// CodeGraph index/tools; marketing does not.
export function isCodeChannel(channel: Channel): boolean {
  return channel === "chat" || isSubChannel(channel);
}

export interface AgentSession {
  projectId: number;
  projectPath: string;
  channel: Channel;
  conversationId: number;
  claudeSessionId: string | null;
  events: object[];
  currentProcess: ChildProcess | null;
  status: "idle" | "running";
  subscribers: Set<WebSocket>;
}
