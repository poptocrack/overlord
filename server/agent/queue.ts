import { db } from "../db/index.js";
import { queuedMessages } from "../db/schema.js";
import { and, asc, eq } from "drizzle-orm";
import { broadcast } from "./sessions.js";
import type { AgentSession, Channel } from "./types.js";

// Persistent message queue — messages typed while the agent is busy.
// Stored in SQLite so they survive page reloads, app kills and reconnects.

export interface QueuedMessage {
  id: number;
  content: string;
  createdAt: string;
}

const cols = {
  id: queuedMessages.id,
  content: queuedMessages.content,
  createdAt: queuedMessages.createdAt,
};

export function listQueue(projectId: number, channel: Channel): QueuedMessage[] {
  return db
    .select(cols)
    .from(queuedMessages)
    .where(and(eq(queuedMessages.projectId, projectId), eq(queuedMessages.channel, channel)))
    .orderBy(asc(queuedMessages.id))
    .all();
}

export function enqueue(projectId: number, channel: Channel, content: string): QueuedMessage {
  return db
    .insert(queuedMessages)
    .values({ projectId, channel, content })
    .returning(cols)
    .get();
}

export function updateQueued(id: number, content: string): void {
  db.update(queuedMessages).set({ content }).where(eq(queuedMessages.id, id)).run();
}

export function deleteQueued(id: number): void {
  db.delete(queuedMessages).where(eq(queuedMessages.id, id)).run();
}

export function clearQueue(projectId: number, channel: Channel): void {
  db.delete(queuedMessages)
    .where(and(eq(queuedMessages.projectId, projectId), eq(queuedMessages.channel, channel)))
    .run();
}

// Remove and return the oldest queued message for this project/channel.
export function dequeueNext(projectId: number, channel: Channel): QueuedMessage | null {
  const next = db
    .select(cols)
    .from(queuedMessages)
    .where(and(eq(queuedMessages.projectId, projectId), eq(queuedMessages.channel, channel)))
    .orderBy(asc(queuedMessages.id))
    .limit(1)
    .get();
  if (!next) return null;
  db.delete(queuedMessages).where(eq(queuedMessages.id, next.id)).run();
  return next;
}

export function broadcastQueueState(session: AgentSession): void {
  broadcast(session, {
    type: "queue:state",
    channel: session.channel,
    queue: listQueue(session.projectId, session.channel),
  });
}
