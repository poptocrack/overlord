import { WebSocket } from "ws";
import { db } from "../db/index.js";
import { conversations } from "../db/schema.js";
import { eq, desc, and } from "drizzle-orm";
import type { AgentSession, Channel } from "./types.js";

// In-memory sessions keyed by `${projectId}:${channel}`
export const agentSessions = new Map<string, AgentSession>();

export function sessionKey(projectId: number, channel: Channel) {
  return `${projectId}:${channel}`;
}

export function broadcast(session: AgentSession, msg: object) {
  const data = JSON.stringify(msg);
  for (const ws of session.subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// Debounced save to avoid blocking the event loop during heavy streaming.
const saveTimers = new Map<number, ReturnType<typeof setTimeout>>();

export function saveEvents(session: AgentSession) {
  const existing = saveTimers.get(session.projectId);
  if (existing) clearTimeout(existing);

  saveTimers.set(
    session.projectId,
    setTimeout(() => {
      saveTimers.delete(session.projectId);
      db.update(conversations)
        .set({
          eventsJson: JSON.stringify(session.events),
          claudeSessionId: session.claudeSessionId,
        })
        .where(eq(conversations.id, session.conversationId))
        .run();
    }, 2000)
  );
}

export function saveEventsNow(session: AgentSession) {
  const existing = saveTimers.get(session.projectId);
  if (existing) clearTimeout(existing);
  saveTimers.delete(session.projectId);

  db.update(conversations)
    .set({
      eventsJson: JSON.stringify(session.events),
      claudeSessionId: session.claudeSessionId,
    })
    .where(eq(conversations.id, session.conversationId))
    .run();
}

export function loadSessionFromDb(projectId: number, projectPath: string, channel: Channel): AgentSession | null {
  const conv = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.projectId, projectId), eq(conversations.channel, channel)))
    .orderBy(desc(conversations.createdAt))
    .limit(1)
    .get();

  // Bind to the existing conversation row even when it has no events yet:
  // sub-conversations ("branches") are created up-front (empty) and their first
  // message must attach to that exact row, not spawn a duplicate.
  if (!conv) return null;

  let events: object[] = [];
  if (conv.eventsJson) {
    try {
      events = JSON.parse(conv.eventsJson);
    } catch {
      events = [];
    }
  }

  return {
    projectId,
    projectPath,
    channel,
    conversationId: conv.id,
    claudeSessionId: conv.claudeSessionId,
    events,
    currentProcess: null,
    status: "idle",
    subscribers: new Set(),
  };
}

export function getOrCreateSession(projectId: number, projectPath: string, channel: Channel): AgentSession {
  const key = sessionKey(projectId, channel);
  const existing = agentSessions.get(key);
  if (existing) return existing;

  const restored = loadSessionFromDb(projectId, projectPath, channel);
  if (restored) {
    agentSessions.set(key, restored);
    return restored;
  }

  const conv = db
    .insert(conversations)
    .values({ projectId, channel, title: `${channel} session` })
    .returning()
    .get();

  const session: AgentSession = {
    projectId,
    projectPath,
    channel,
    conversationId: conv.id,
    claudeSessionId: null,
    events: [],
    currentProcess: null,
    status: "idle",
    subscribers: new Set(),
  };

  agentSessions.set(key, session);
  return session;
}

export function stopAgent(projectId: number, channel: Channel = "chat") {
  const session = agentSessions.get(sessionKey(projectId, channel));
  if (!session || !session.currentProcess) return false;
  console.log(`[agent:${projectId}:${channel}] stopping (SIGTERM)`);
  session.currentProcess.kill("SIGTERM");
  return true;
}
