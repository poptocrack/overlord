import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import { spawn, execSync } from "child_process";
import { resolve } from "path";

import { initDb, db } from "./db/index.js";
import { conversations, projects } from "./db/schema.js";
import { eq, sql } from "drizzle-orm";

import projectRoutes from "./routes/projects.js";
import sessionRoutes from "./routes/sessions.js";
import conversationRoutes from "./routes/conversations.js";
import todoRoutes from "./routes/todos.js";
import marketingRoutes from "./routes/marketing.js";
import skillsRoutes from "./routes/skills.js";
import learningsRoutes from "./routes/learnings.js";
import codegraphRoutes from "./routes/codegraph.js";
import uploadsRoutes from "./routes/uploads.js";
import insightsRoutes from "./routes/insights.js";

import { setWebSocketServer } from "./ws.js";
import { attachWsHandlers } from "./agent/ws-handler.js";
import { agentSessions, sessionKey, saveEventsNow } from "./agent/sessions.js";
import { getCommitsSince, rollbackToSnapshot } from "./agent/git-snapshot.js";
import type { Channel } from "./agent/types.js";

const PORT = Number(process.env.PORT) || 4747;
const ROOT_DIR = process.env.OVERLORD_ROOT || resolve(process.cwd(), "..");
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

initDb();

const app = new Hono();
app.use("/api/*", cors());
app.use("/api/*", async (c, next) => {
  c.set("rootDir" as never, ROOT_DIR as never);
  await next();
});

app.route("/api/projects", projectRoutes);
app.route("/api/sessions", sessionRoutes);
app.route("/api/conversations", conversationRoutes);
app.route("/api/todos", todoRoutes);
app.route("/api/marketing", marketingRoutes);
app.route("/api/skills", skillsRoutes);
app.route("/api/learnings", learningsRoutes);
app.route("/api/codegraph", codegraphRoutes);
app.route("/api/uploads", uploadsRoutes);
app.route("/api/insights", insightsRoutes);

app.post("/api/terminal/open", async (c) => {
  const body = await c.req.json();
  const dir = body.path;
  if (!dir) return c.json({ error: "Path required" }, 400);

  const platform = process.platform;
  if (platform === "darwin") {
    spawn("open", ["-a", "Terminal", dir], { detached: true, stdio: "ignore" });
  } else if (platform === "linux") {
    for (const term of ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"]) {
      try {
        spawn(term, ["--working-directory", dir], { detached: true, stdio: "ignore" });
        break;
      } catch { continue; }
    }
  } else if (platform === "win32") {
    spawn("cmd", ["/c", "start", "cmd", "/K", `cd /d ${dir}`], { detached: true, stdio: "ignore" });
  }

  return c.json({ ok: true });
});

const EDITORS = [
  { id: "cursor", name: "Cursor", cmd: "cursor", test: "cursor" },
  { id: "vscode", name: "VS Code", cmd: "code", test: "code" },
  { id: "zed", name: "Zed", cmd: "zed", test: "zed" },
  { id: "webstorm", name: "WebStorm", cmd: "webstorm", test: "webstorm" },
  { id: "idea", name: "IntelliJ IDEA", cmd: "idea", test: "idea" },
  { id: "sublime", name: "Sublime Text", cmd: "subl", test: "subl" },
  { id: "vim", name: "Vim", cmd: "vim", test: "vim" },
  { id: "nano", name: "Nano", cmd: "nano", test: "nano" },
];

app.get("/api/editors", (c) => {
  const available = EDITORS.filter((e) => {
    try {
      execSync(`which ${e.test}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  return c.json(available);
});

app.post("/api/editor/open", async (c) => {
  const body = await c.req.json();
  const { filePath, editor } = body;
  if (!filePath || !editor) return c.json({ error: "filePath and editor required" }, 400);

  const editorConfig = EDITORS.find((e) => e.id === editor);
  if (!editorConfig) return c.json({ error: "Unknown editor" }, 404);

  spawn(editorConfig.cmd, [filePath], { detached: true, stdio: "ignore" });
  return c.json({ ok: true });
});

app.get("/api/rtk/gain/:projectId", (c) => {
  const projectId = Number(c.req.param("projectId"));
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return c.json({ error: "Not found" }, 404);

  try {
    const output = execSync("rtk gain --project --format json", {
      cwd: project.path,
      encoding: "utf-8",
      timeout: 5000,
    });
    return c.json(JSON.parse(output));
  } catch {
    return c.json({ summary: null });
  }
});

// --- Résolution dynamique des versions de modèles (alias -> ID versionné) ---
// On lance la CLI avec un alias et on lit le 1er event `system/init` (émis au
// démarrage, AVANT toute inférence), puis on tue le process. C'est quasi gratuit
// et ne requiert aucune clé API : on s'appuie sur l'auth de la CLI Claude.
interface ResolvedModelOption { id: string; label: string; short: string; version: string | null; }

// opus/sonnet supportent le contexte 1M, pas haiku.
const MODEL_ALIASES = [
  { alias: "opus", oneM: true },
  { alias: "sonnet", oneM: true },
  { alias: "haiku", oneM: false },
];
const MODEL_CACHE_TTL = 60 * 60 * 1000; // 1h
let modelCache: { at: number; models: ResolvedModelOption[] } | null = null;

function resolveAlias(alias: string): Promise<string | null> {
  return new Promise((resolveP) => {
    const proc = spawn(
      CLAUDE_PATH,
      ["--model", alias, "--print", "--output-format", "stream-json", "--verbose", "hi"],
      { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let buf = "";
    let done = false;
    const finish = (val: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill("SIGTERM"); } catch {}
      resolveP(val);
    };
    const timer = setTimeout(() => finish(null), 20000);
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === "system" && ev.subtype === "init" && ev.model) {
            finish(ev.model);
            return;
          }
        } catch {}
      }
    });
    proc.on("error", () => finish(null));
    proc.on("close", () => finish(null));
  });
}

function formatModelVersion(id: string): string {
  const m = id.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return id.replace(/^claude-/, "");
}

app.get("/api/models", async (c) => {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_TTL) {
    return c.json(modelCache.models);
  }

  const resolved = await Promise.all(
    MODEL_ALIASES.map(async (spec) => ({ ...spec, id: await resolveAlias(spec.alias) })),
  );

  const models: ResolvedModelOption[] = [
    { id: "", label: "Default (Claude CLI default)", short: "Default", version: null },
  ];
  for (const r of resolved) {
    const ver = r.id ? formatModelVersion(r.id) : r.alias[0].toUpperCase() + r.alias.slice(1);
    models.push({ id: r.alias, label: `Claude ${ver}`, short: ver, version: r.id });
    if (r.oneM) {
      models.push({
        id: `${r.alias}[1m]`,
        label: `Claude ${ver} (1M context)`,
        short: `${ver} 1M`,
        version: r.id ? `${r.id}[1m]` : null,
      });
    }
  }

  // On ne met en cache qu'un résultat où au moins un alias a été résolu, pour
  // éviter de figer un échec transitoire (CLI absente, offline...).
  if (resolved.some((r) => r.id)) modelCache = { at: Date.now(), models };
  return c.json(models);
});

app.post("/api/agent/ask", async (c) => {
  const body = await c.req.json();
  const { projectId, question } = body;
  if (!projectId || !question) return c.json({ error: "projectId and question required" }, 400);

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);

  console.log(`[ask:${project.name}] "${question.slice(0, 80)}..."`);

  const result = await new Promise<{ ok: boolean; answer?: string; error?: string; code?: number | null }>((resolveP) => {
    const proc = spawn(CLAUDE_PATH, ["--print", "--", question], {
      cwd: project.path,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    proc.stdout!.on("data", (data: Buffer) => { output += data.toString(); });
    proc.stderr!.on("data", () => {});

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolveP({ ok: false, error: "Timeout (3min)", answer: output.trim() });
    }, 3 * 60 * 1000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      console.log(`[ask:${project.name}] done code=${code} (${output.length} chars)`);
      resolveP({ ok: true, answer: output.trim(), code });
    });
  });

  return c.json({ ...result, project: project.name });
});

app.post("/api/agent/rollback", async (c) => {
  const body = await c.req.json();
  const { projectId, snapshotSha, messageIndex, channel = "chat" } = body;

  if (!projectId || !snapshotSha) return c.json({ error: "projectId and snapshotSha required" }, 400);

  const session = agentSessions.get(sessionKey(projectId, channel));
  if (!session) return c.json({ error: "No session found" }, 404);

  const commitsSince = getCommitsSince(session.projectPath, snapshotSha);
  if (commitsSince > 0) {
    return c.json({
      error: `${commitsSince} commit(s) ont ete faits depuis ce point. Le rollback ecraserait ces changements.`,
      commitsSince,
      needsConfirm: true,
    });
  }

  const result = rollbackToSnapshot(session.projectPath, snapshotSha);
  if (!result.ok) return c.json({ error: result.error }, 500);

  if (typeof messageIndex === "number" && messageIndex >= 0) {
    session.events = session.events.slice(0, messageIndex);
    saveEventsNow(session);
  }

  return c.json({ ok: true });
});

app.post("/api/agent/rollback/force", async (c) => {
  const body = await c.req.json();
  const { projectId, snapshotSha, messageIndex, channel = "chat" } = body;

  if (!projectId || !snapshotSha) return c.json({ error: "projectId and snapshotSha required" }, 400);

  const session = agentSessions.get(sessionKey(projectId, channel));
  if (!session) return c.json({ error: "No session found" }, 404);

  const result = rollbackToSnapshot(session.projectPath, snapshotSha);
  if (!result.ok) return c.json({ error: result.error }, 500);

  if (typeof messageIndex === "number" && messageIndex >= 0) {
    session.events = session.events.slice(0, messageIndex);
    saveEventsNow(session);
  }

  return c.json({ ok: true });
});

app.get("/api/agent/:projectId/status", (c) => {
  const projectId = Number(c.req.param("projectId"));
  const channel = (c.req.query("channel") as Channel) || "chat";
  const session = agentSessions.get(sessionKey(projectId, channel));
  if (!session) return c.json({ active: false, status: "none" });
  return c.json({
    active: session.status === "running",
    status: session.status,
    conversationId: session.conversationId,
    claudeSessionId: session.claudeSessionId,
    eventsCount: session.events.length,
  });
});

app.get("/api/agent/statuses", (c) => {
  const statuses: Record<number, string> = {};

  for (const [, session] of agentSessions) {
    if (session.channel !== "chat") continue;
    const projectId = session.projectId;
    if (session.status === "running") {
      statuses[projectId] = "running";
    } else if (session.events.length > 0) {
      const lastResult = [...session.events].reverse().find((e: any) => e.type === "result");
      statuses[projectId] = (lastResult as any)?.is_error ? "error" : "done";
    } else {
      statuses[projectId] = "idle";
    }
  }

  const allConvs = db
    .select()
    .from(conversations)
    .where(sql`channel = 'chat' AND events_json IS NOT NULL AND events_json != '[]'`)
    .all();

  for (const conv of allConvs) {
    if (!(conv.projectId in statuses)) {
      statuses[conv.projectId] = "done";
    }
  }

  return c.json(statuses);
});

app.use("/*", serveStatic({ root: "./dist/client" }));
app.get("/*", serveStatic({ root: "./dist/client", path: "index.html" }));

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`🏰 Overlord running at http://localhost:${info.port}`);
  console.log(`📁 Root directory: ${ROOT_DIR}`);
});

const wss = new WebSocketServer({ server: server as never, path: "/ws" });
setWebSocketServer(wss);
attachWsHandlers(wss);

export { app, PORT, ROOT_DIR };
