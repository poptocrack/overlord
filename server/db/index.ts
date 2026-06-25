import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";

const dataDir = join(homedir(), ".overlord");
mkdirSync(dataDir, { recursive: true });

const dbPath = join(dataDir, "overlord.db");
const sqlite = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

export function initDb() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      summary TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      claude_session_id TEXT,
      title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_resumed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      thinking TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrations
  const msgCols = sqlite.pragma("table_info(messages)") as { name: string }[];
  if (!msgCols.some((c) => c.name === "thinking")) {
    sqlite.exec("ALTER TABLE messages ADD COLUMN thinking TEXT");
  }

  const convCols = sqlite.pragma("table_info(conversations)") as { name: string }[];
  if (!convCols.some((c) => c.name === "events_json")) {
    sqlite.exec("ALTER TABLE conversations ADD COLUMN events_json TEXT");
  }
  if (!convCols.some((c) => c.name === "channel")) {
    sqlite.exec("ALTER TABLE conversations ADD COLUMN channel TEXT NOT NULL DEFAULT 'chat'");
  }

  const projCols = sqlite.pragma("table_info(projects)") as { name: string }[];
  if (!projCols.some((c) => c.name === "favorite")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0");
  }
  if (!projCols.some((c) => c.name === "hidden")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  }
  if (!projCols.some((c) => c.name === "summary")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN summary TEXT");
  }
  if (!projCols.some((c) => c.name === "last_summary_at")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN last_summary_at TEXT");
  }
  if (!projCols.some((c) => c.name === "system_prompt")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN system_prompt TEXT");
  }
  if (!projCols.some((c) => c.name === "model")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN model TEXT");
  }
  if (!projCols.some((c) => c.name === "allowed_tools")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN allowed_tools TEXT");
  }
  if (!projCols.some((c) => c.name === "tagline")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN tagline TEXT");
  }
  if (!projCols.some((c) => c.name === "short_description")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN short_description TEXT");
  }
  if (!projCols.some((c) => c.name === "long_description")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN long_description TEXT");
  }
  if (!projCols.some((c) => c.name === "links")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN links TEXT");
  }
  if (!projCols.some((c) => c.name === "learnings_enabled")) {
    sqlite.exec("ALTER TABLE projects ADD COLUMN learnings_enabled INTEGER NOT NULL DEFAULT 1");
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      dead_ends TEXT,
      missing_context TEXT,
      recommendations TEXT,
      raw_report TEXT NOT NULL,
      exported INTEGER NOT NULL DEFAULT 0,
      reviewed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS marketing_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS marketing_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      platform TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      description TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      sort_order REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS queued_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      channel TEXT NOT NULL DEFAULT 'chat',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
