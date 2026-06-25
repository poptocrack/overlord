import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  status: text("status", { enum: ["active", "paused", "blocked"] })
    .notNull()
    .default("active"),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  summary: text("summary"),
  lastSummaryAt: text("last_summary_at"),
  systemPrompt: text("system_prompt"),
  model: text("model"),
  allowedTools: text("allowed_tools"),
  tagline: text("tagline"),
  shortDescription: text("short_description"),
  longDescription: text("long_description"),
  links: text("links"),
  learningsEnabled: integer("learnings_enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  summary: text("summary"),
  startedAt: text("started_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  endedAt: text("ended_at"),
});

export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  channel: text("channel").notNull().default("chat"),
  claudeSessionId: text("claude_session_id"),
  title: text("title"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  lastResumedAt: text("last_resumed_at"),
  eventsJson: text("events_json"),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  thinking: text("thinking"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const marketingAssets = sqliteTable("marketing_assets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  type: text("type").notNull(), // logo | screenshot | video | other
  name: text("name").notNull(),
  filePath: text("file_path").notNull(),
  mimeType: text("mime_type"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const marketingDrafts = sqliteTable("marketing_drafts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  platform: text("platform").notNull(), // twitter | linkedin | blog | release_notes | other
  title: text("title"),
  content: text("content").notNull(),
  status: text("status").notNull().default("draft"), // draft | published
  publishedAt: text("published_at"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const learnings = sqliteTable("learnings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id),
  deadEnds: text("dead_ends"),
  missingContext: text("missing_context"),
  recommendations: text("recommendations"),
  rawReport: text("raw_report").notNull(),
  exported: integer("exported", { mode: "boolean" }).notNull().default(false),
  reviewed: integer("reviewed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  description: text("description"),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  sortOrder: real("sort_order").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// Messages typed while the agent is busy — persisted so they survive
// reloads, app kills, and WebSocket reconnects. Drained server-side.
export const queuedMessages = sqliteTable("queued_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  channel: text("channel").notNull().default("chat"),
  content: text("content").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
