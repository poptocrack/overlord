import { Hono } from "hono";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const app = new Hono();

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const HOME_PREFIX = homedir().replace(/\//g, "-"); // e.g. "-Users-tristandebroise"

// Idle gap above which we stop counting "active" time between two events.
const IDLE_CAP_MS = 5 * 60 * 1000;
// Approx Anthropic pricing for the Opus 4.x family ($ per 1M tokens). ~99% of
// usage here is Opus; the handful of Sonnet/Haiku calls are priced at this rate
// too (negligible error). Cost is an estimate — subscriptions may not bill it.
const PRICE = { input: 15, cacheRead: 1.5, cacheCreate: 18.75, output: 75 };

// Claude Code encodes a project's cwd by replacing "/" with "-". Real folder
// names containing "-" become ambiguous, so we can't just split. Projects live
// as direct subfolders of ROOT_DIR, so stripping encode(ROOT_DIR + "/") yields
// the exact folder name (hyphens intact).
function makePretty(rootDir: string) {
  const rootPrefix = rootDir.replace(/\//g, "-") + "-";
  return (dir: string): string => {
    if (dir.startsWith(rootPrefix)) return dir.slice(rootPrefix.length);
    let rest = dir.startsWith(HOME_PREFIX) ? dir.slice(HOME_PREFIX.length) : dir;
    rest = rest.replace(/^-+/, "");
    return rest || dir;
  };
}

interface ProjectStat {
  name: string;
  dir: string;
  sessions: number;
  prompts: number;
  assistantMsgs: number;
  toolUses: number;
  inputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  outputTokens: number;
  cost: number;
  activeMin: number;
  first: number | null;
  last: number | null;
  days: number;
  recent: number; // prompts+toolUses in last 7 days
  prev: number;   // prompts+toolUses in the 7 days before that
  tools: Record<string, number>;
}

interface InsightsData {
  generatedAt: string;
  days: number;
  totals: {
    sessions: number; prompts: number; assistantMsgs: number; toolUses: number;
    inputTokens: number; cacheTokens: number; outputTokens: number;
    cost: number; activeMin: number;
  };
  streak: { current: number; longest: number };
  peakHour: number;
  peakDow: number;
  busiestDay: { date: string; count: number } | null;
  longestSession: { project: string; ms: number; date: string } | null;
  byProject: ProjectStat[];
  byDay: Record<string, { prompts: number; toolUses: number }>;
  byHour: number[];
  byDow: number[];
  tools: Record<string, number>;
  models: Record<string, number>;
}

function projectCost(p: { inputTokens: number; cacheRead: number; cacheCreate: number; outputTokens: number }): number {
  return (
    (p.inputTokens * PRICE.input +
      p.cacheRead * PRICE.cacheRead +
      p.cacheCreate * PRICE.cacheCreate +
      p.outputTokens * PRICE.output) /
    1e6
  );
}

// Sum gaps between consecutive timestamps, ignoring idle stretches > IDLE_CAP.
function activeMinutes(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;
  timestamps.sort((a, b) => a - b);
  let ms = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap > 0 && gap <= IDLE_CAP_MS) ms += gap;
  }
  return Math.round(ms / 60000);
}

// Longest uninterrupted "sitting": max run of events with no gap > IDLE_CAP.
// (A resumed session file can span weeks, so raw first→last span is useless.)
function longestBlock(timestamps: number[]): { ms: number; startTs: number } {
  if (timestamps.length < 2) return { ms: 0, startTs: timestamps[0] || 0 };
  timestamps.sort((a, b) => a - b);
  let best = 0, bestStart = timestamps[0];
  let blockStart = timestamps[0];
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap > IDLE_CAP_MS) blockStart = timestamps[i];
    const span = timestamps[i] - blockStart;
    if (span > best) { best = span; bestStart = blockStart; }
  }
  return { ms: best, startTs: bestStart };
}

// Human-typed prompt vs auto-generated meta-prompt noise.
function isNoise(t: string): boolean {
  if (!t) return true;
  return (
    t.startsWith("<") ||
    t.startsWith("Caveat") ||
    t.startsWith("[Request") ||
    t.startsWith("This session") ||
    t.startsWith("You are analyzing a completed") ||
    t.startsWith("Tu es un assistant qui genere des resumes") ||
    t.startsWith("You are an independent technical advisor")
  );
}

function computeStreak(dayset: Set<string>): { current: number; longest: number } {
  if (dayset.size === 0) return { current: 0, longest: 0 };
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  // longest run
  const sorted = [...dayset].sort();
  let longest = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + "T00:00:00Z");
    const cur = new Date(sorted[i] + "T00:00:00Z");
    const diff = Math.round((cur.getTime() - prev.getTime()) / 86400000);
    run = diff === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  // current run ending today or yesterday
  const today = new Date();
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (!dayset.has(dayKey(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let current = 0;
  while (dayset.has(dayKey(cursor))) {
    current++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return { current, longest };
}

function compute(days: number, rootDir: string): InsightsData {
  const prettyName = makePretty(rootDir);
  const now = Date.now();
  const cutoff = now - days * 24 * 3600 * 1000;
  const win7 = now - 7 * 24 * 3600 * 1000;
  const win14 = now - 14 * 24 * 3600 * 1000;

  const data: InsightsData = {
    generatedAt: new Date(now).toISOString(),
    days,
    totals: { sessions: 0, prompts: 0, assistantMsgs: 0, toolUses: 0, inputTokens: 0, cacheTokens: 0, outputTokens: 0, cost: 0, activeMin: 0 },
    streak: { current: 0, longest: 0 },
    peakHour: 0,
    peakDow: 0,
    busiestDay: null,
    longestSession: null,
    byProject: [],
    byDay: {},
    byHour: Array(24).fill(0),
    byDow: Array(7).fill(0),
    tools: {},
    models: {},
  };

  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return data;
  }

  const allActiveDays = new Set<string>();

  for (const dir of dirs) {
    const dpath = join(PROJECTS_DIR, dir);
    let files: string[];
    try {
      files = readdirSync(dpath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    const p: ProjectStat = {
      name: prettyName(dir), dir, sessions: 0, prompts: 0, assistantMsgs: 0, toolUses: 0,
      inputTokens: 0, cacheRead: 0, cacheCreate: 0, outputTokens: 0, cost: 0, activeMin: 0,
      first: null, last: null, days: 0, recent: 0, prev: 0, tools: {},
    };
    const activeDays = new Set<string>();

    for (const f of files) {
      const fp = join(dpath, f);
      let st;
      try { st = statSync(fp); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;

      let content: string;
      try { content = readFileSync(fp, "utf8"); } catch { continue; }
      let sessionActive = false;
      const sessionTs: number[] = [];

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        const ts = ev.timestamp ? Date.parse(ev.timestamp) : null;
        if (ts && ts < cutoff) continue;
        const d = ev.timestamp ? String(ev.timestamp).slice(0, 10) : null;
        const dt = ts ? new Date(ts) : null;
        if (ts) sessionTs.push(ts);

        if (ev.type === "user" && !ev.isMeta) {
          const c = ev.message?.content;
          const text = typeof c === "string"
            ? c
            : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") : "";
          if (text && !isNoise(text.trim())) {
            p.prompts++;
            sessionActive = true;
            if (d) { (data.byDay[d] ??= { prompts: 0, toolUses: 0 }).prompts++; activeDays.add(d); allActiveDays.add(d); }
            if (dt) { data.byHour[dt.getHours()]++; data.byDow[dt.getDay()]++; }
            if (ts) {
              p.first = p.first ? Math.min(p.first, ts) : ts;
              p.last = p.last ? Math.max(p.last, ts) : ts;
              if (ts >= win7) p.recent++; else if (ts >= win14) p.prev++;
            }
          }
        } else if (ev.type === "assistant") {
          p.assistantMsgs++;
          const m = ev.message;
          if (m?.model && m.model !== "<synthetic>") data.models[m.model] = (data.models[m.model] || 0) + 1;
          if (m?.usage) {
            p.inputTokens += m.usage.input_tokens || 0;
            p.cacheRead += m.usage.cache_read_input_tokens || 0;
            p.cacheCreate += m.usage.cache_creation_input_tokens || 0;
            p.outputTokens += m.usage.output_tokens || 0;
          }
          if (Array.isArray(m?.content)) {
            for (const b of m.content) {
              if (b.type === "tool_use") {
                p.toolUses++;
                sessionActive = true;
                const tn = b.name || "?";
                p.tools[tn] = (p.tools[tn] || 0) + 1;
                data.tools[tn] = (data.tools[tn] || 0) + 1;
                if (d) (data.byDay[d] ??= { prompts: 0, toolUses: 0 }).toolUses++;
                if (ts) { if (ts >= win7) p.recent++; else if (ts >= win14) p.prev++; }
              }
            }
          }
        }
      }

      if (sessionActive) {
        p.sessions++;
        p.activeMin += activeMinutes(sessionTs);
        const block = longestBlock(sessionTs);
        if (block.ms > 0 && (!data.longestSession || block.ms > data.longestSession.ms)) {
          data.longestSession = { project: p.name, ms: block.ms, date: new Date(block.startTs).toISOString().slice(0, 10) };
        }
      }
    }

    if (p.prompts > 0 || p.toolUses > 0) {
      p.days = activeDays.size;
      p.cost = projectCost(p);
      data.byProject.push(p);
      data.totals.sessions += p.sessions;
      data.totals.prompts += p.prompts;
      data.totals.assistantMsgs += p.assistantMsgs;
      data.totals.toolUses += p.toolUses;
      data.totals.inputTokens += p.inputTokens;
      data.totals.cacheTokens += p.cacheRead + p.cacheCreate;
      data.totals.outputTokens += p.outputTokens;
      data.totals.cost += p.cost;
      data.totals.activeMin += p.activeMin;
    }
  }

  data.byProject.sort((a, b) => b.prompts + b.toolUses - (a.prompts + a.toolUses));
  data.streak = computeStreak(allActiveDays);
  data.peakHour = data.byHour.indexOf(Math.max(...data.byHour));
  data.peakDow = data.byDow.indexOf(Math.max(...data.byDow));
  for (const [date, v] of Object.entries(data.byDay)) {
    const count = v.prompts + v.toolUses;
    if (!data.busiestDay || count > data.busiestDay.count) data.busiestDay = { date, count };
  }
  return data;
}

// Reading every transcript is heavy; cache per-window for a couple of minutes.
const cache = new Map<number, { ts: number; data: InsightsData }>();
const TTL = 2 * 60 * 1000;

// GET /api/insights?days=30
app.get("/", (c) => {
  const days = Math.min(365, Math.max(1, Number(c.req.query("days")) || 30));
  const force = c.req.query("refresh") === "1";
  const hit = cache.get(days);
  if (hit && !force && Date.now() - hit.ts < TTL) return c.json(hit.data);
  const rootDir = (c.get("rootDir" as never) as string) || join(homedir(), "Developer");
  const data = compute(days, rootDir);
  cache.set(days, { ts: Date.now(), data });
  return c.json(data);
});

export default app;
