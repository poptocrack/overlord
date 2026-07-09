import { Hono } from "hono";
import { db } from "../db/index.js";
import { conversations, messages, queuedMessages } from "../db/schema.js";
import { eq, desc, and, like } from "drizzle-orm";
import { agentSessions, sessionKey } from "../agent/sessions.js";
import type { Channel } from "../agent/types.js";

const app = new Hono();

// Derive a short, human-friendly title + preview from a stored context excerpt.
function deriveTitle(contextText: string | null | undefined): string {
  if (!contextText) return "Branch";
  const firstLine = contextText
    .split("\n")
    .map((l) => l.replace(/^\s*(You|Claude|User|Assistant):\s*/i, "").trim())
    .find((l) => l.length > 0);
  const base = (firstLine ?? contextText).trim();
  return base.length > 60 ? base.slice(0, 60) + "…" : base || "Branch";
}

// Last readable snippet from a sub-conversation's stored events, for the list.
function previewFromEvents(eventsJson: string | null): { preview: string; lastActivityAt: string | null } {
  if (!eventsJson) return { preview: "", lastActivityAt: null };
  try {
    const events = JSON.parse(eventsJson) as any[];
    let preview = "";
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === "result" && typeof ev.result === "string" && ev.result.trim()) {
        preview = ev.result.trim();
        break;
      }
      if (ev.type === "user_message" && typeof ev.content === "string" && ev.content.trim()) {
        preview = ev.content.trim();
        break;
      }
    }
    return {
      preview: preview.length > 140 ? preview.slice(0, 140) + "…" : preview,
      lastActivityAt: null,
    };
  } catch {
    return { preview: "", lastActivityAt: null };
  }
}

function liveRunning(projectId: number, conversationId: number): boolean {
  const channel = `sub:${conversationId}` as Channel;
  const session = agentSessions.get(sessionKey(projectId, channel));
  return session?.status === "running";
}

// --- Sub-conversations ("branches") ---------------------------------------

// POST /api/conversations/sub - spin off a new branch from a message.
// Body: { projectId, parentConversationId?, contextText, title? }
app.post("/sub", async (c) => {
  const body = await c.req.json();
  const projectId = Number(body.projectId);
  if (!projectId) return c.json({ error: "projectId required" }, 400);

  const contextText: string = typeof body.contextText === "string" ? body.contextText : "";
  const title: string = (body.title && String(body.title).trim()) || deriveTitle(contextText);
  const parentConversationId =
    body.parentConversationId != null ? Number(body.parentConversationId) : null;

  // Insert first to obtain the id, then encode it into the channel so the
  // agent session machinery keys this branch independently (`sub:<id>`).
  const created = db
    .insert(conversations)
    .values({
      projectId,
      channel: "sub:pending",
      title,
      contextText: contextText || null,
      parentConversationId,
      unread: false,
    })
    .returning()
    .get();

  const updated = db
    .update(conversations)
    .set({ channel: `sub:${created.id}` })
    .where(eq(conversations.id, created.id))
    .returning()
    .get();

  return c.json(updated);
});

// GET /api/conversations/sub/:projectId - list branches for a project, newest first.
app.get("/sub/:projectId", (c) => {
  const projectId = Number(c.req.param("projectId"));
  const rows = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.projectId, projectId), like(conversations.channel, "sub:%")))
    .orderBy(desc(conversations.createdAt))
    .all();

  const result = rows
    // Guard against a half-created row that never got its final channel.
    .filter((r) => r.channel !== "sub:pending")
    .map((r) => {
      const { preview } = previewFromEvents(r.eventsJson);
      return {
        id: r.id,
        projectId: r.projectId,
        title: r.title,
        contextText: r.contextText,
        parentConversationId: r.parentConversationId,
        createdAt: r.createdAt,
        unread: !!r.unread,
        running: liveRunning(projectId, r.id),
        hasEvents: !!r.eventsJson && r.eventsJson !== "[]",
        preview,
      };
    });

  return c.json(result);
});

// POST /api/conversations/:id/read - clear the unread flag for a branch.
app.post("/:id/read", (c) => {
  const id = Number(c.req.param("id"));
  db.update(conversations).set({ unread: false }).where(eq(conversations.id, id)).run();
  return c.json({ ok: true });
});

// DELETE /api/conversations/:id - remove a branch and its dependent rows.
app.delete("/:id", (c) => {
  const id = Number(c.req.param("id"));
  const conv = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (!conv) return c.json({ error: "Not found" }, 404);

  // Only branches are deletable through this endpoint.
  if (!conv.channel.startsWith("sub:")) {
    return c.json({ error: "Only branches can be deleted" }, 400);
  }

  // Stop any live process and drop the in-memory session.
  const key = sessionKey(conv.projectId, conv.channel as Channel);
  const session = agentSessions.get(key);
  if (session?.currentProcess) {
    try { session.currentProcess.kill("SIGTERM"); } catch {}
  }
  agentSessions.delete(key);

  db.delete(messages).where(eq(messages.conversationId, id)).run();
  db.delete(queuedMessages)
    .where(and(eq(queuedMessages.projectId, conv.projectId), eq(queuedMessages.channel, conv.channel)))
    .run();
  db.delete(conversations).where(eq(conversations.id, id)).run();

  return c.json({ ok: true });
});

// --- Existing endpoints ----------------------------------------------------

// GET /api/conversations/:projectId - list conversations for a project
app.get("/:projectId", (c) => {
  const projectId = Number(c.req.param("projectId"));
  const result = db
    .select()
    .from(conversations)
    .where(eq(conversations.projectId, projectId))
    .orderBy(desc(conversations.createdAt))
    .all();
  return c.json(result);
});

// GET /api/conversations/:id/messages - get messages for a conversation
app.get("/:id/messages", (c) => {
  const id = Number(c.req.param("id"));
  const result = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .all();
  return c.json(result);
});

// GET /api/conversations/latest/:projectId - get latest conversation with messages
app.get("/latest/:projectId", (c) => {
  const projectId = Number(c.req.param("projectId"));
  const conv = db
    .select()
    .from(conversations)
    .where(eq(conversations.projectId, projectId))
    .orderBy(desc(conversations.createdAt))
    .limit(1)
    .get();

  if (!conv) return c.json({ conversation: null, messages: [] });

  const msgs = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .all();

  return c.json({ conversation: conv, messages: msgs });
});

export default app;
