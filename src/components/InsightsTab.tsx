import { useState } from "react";
import { useApi } from "../hooks/useApi.js";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw, Clock, Sparkles, Flame, Zap, TrendingUp, TrendingDown, Minus, Trophy } from "lucide-react";

interface ProjectStat {
  name: string; dir: string; sessions: number; prompts: number; assistantMsgs: number;
  toolUses: number; inputTokens: number; cacheRead: number; cacheCreate: number;
  outputTokens: number; cost: number; activeMin: number; first: number | null; last: number | null;
  days: number; recent: number; prev: number; tools: Record<string, number>;
}
interface InsightsData {
  generatedAt: string; days: number;
  totals: { sessions: number; prompts: number; assistantMsgs: number; toolUses: number; inputTokens: number; cacheTokens: number; outputTokens: number; cost: number; activeMin: number };
  streak: { current: number; longest: number };
  peakHour: number; peakDow: number;
  busiestDay: { date: string; count: number } | null;
  longestSession: { project: string; ms: number; date: string } | null;
  byProject: ProjectStat[];
  byDay: Record<string, { prompts: number; toolUses: number }>;
  byHour: number[]; byDow: number[];
  tools: Record<string, number>; models: Record<string, number>;
}

const DOWS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " G";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " k";
  return String(n);
}
function fmtUsd(n: number): string {
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "k";
  return "$" + n.toFixed(0);
}
function fmtDur(min: number): string {
  if (min < 60) return min + " min";
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}
function prettyTool(t: string): string {
  return t.replace(/^mcp__plugin_[^_]*-mcp_/, "").replace(/^mcp__/, "").replace(/__/g, ":").replace(/_/g, " ");
}
function mcpServer(t: string): string {
  return t.slice(5).split("__")[0].replace(/^plugin_/, "").replace(/-mcp.*/, "");
}
function heat(t: number): string {
  if (t <= 0) return "var(--muted)";
  if (t < 0.25) return "#0e4429";
  if (t < 0.5) return "#006d32";
  if (t < 0.75) return "#26a641";
  return "#39d353";
}

function FeatureCard({ icon, value, label, sub, from, to }: { icon: React.ReactNode; value: string; label: string; sub?: string; from: string; to: string }) {
  return (
    <Card className="relative overflow-hidden p-5">
      <div className={`absolute -right-6 -top-6 h-24 w-24 rounded-full bg-gradient-to-br ${from} ${to} opacity-20 blur-xl`} />
      <div className="relative">
        <div className={`inline-flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br ${from} ${to} text-white mb-3`}>{icon}</div>
        <div className="text-3xl font-bold tracking-tight text-foreground leading-none">{value}</div>
        <div className="text-sm text-foreground/80 mt-1.5">{label}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </div>
    </Card>
  );
}

function Kpi({ value, label }: { value: string; label: string }) {
  return (
    <Card className="p-3.5">
      <div className="text-xl font-bold tracking-tight text-foreground">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
    </Card>
  );
}

function Momentum({ recent, prev }: { recent: number; prev: number }) {
  if (prev === 0 && recent === 0) return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
  if (recent > prev * 1.15) return <span className="inline-flex items-center gap-0.5 text-emerald-400 text-[11px]"><TrendingUp className="h-3.5 w-3.5" />{prev ? "+" + Math.round(((recent - prev) / prev) * 100) + "%" : "neuf"}</span>;
  if (recent < prev * 0.85) return <span className="inline-flex items-center gap-0.5 text-orange-400 text-[11px]"><TrendingDown className="h-3.5 w-3.5" />{Math.round(((recent - prev) / prev) * 100) + "%"}</span>;
  return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
}

function Bars({ rows, max }: { rows: [string, number][]; max: number }) {
  return (
    <div className="space-y-2.5">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[150px_1fr_52px] items-center gap-3 text-[13px]">
          <div className="truncate text-foreground">{label}</div>
          <div className="h-[18px] rounded bg-muted overflow-hidden">
            <div className="h-full rounded bg-gradient-to-r from-indigo-500 to-violet-400" style={{ width: `${Math.round((value / max) * 100)}%` }} />
          </div>
          <div className="text-right tabular-nums text-muted-foreground">{fmt(value)}</div>
        </div>
      ))}
    </div>
  );
}

// GitHub-style contribution grid: columns = weeks, rows = weekday (Sun..Sat).
function buildCalendar(byDay: Record<string, { prompts: number; toolUses: number }>, days: number) {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setDate(start.getDate() - start.getDay()); // back to Sunday
  const weeks: { date: string; count: number; future: boolean }[][] = [];
  let cur = new Date(start);
  while (cur <= end) {
    const week: { date: string; count: number; future: boolean }[] = [];
    for (let i = 0; i < 7; i++) {
      const key = cur.toISOString().slice(0, 10);
      const v = byDay[key];
      week.push({ date: key, count: v ? v.prompts + v.toolUses : 0, future: cur > end });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function achievements(d: InsightsData): { emoji: string; title: string; sub: string }[] {
  const out: { emoji: string; title: string; sub: string }[] = [];
  if (d.streak.current >= 7) out.push({ emoji: "🔥", title: "En feu", sub: `${d.streak.current} jours d'affilée` });
  if (d.peakHour >= 22 || d.peakHour < 5) out.push({ emoji: "🦉", title: "Noctambule", sub: `pic à ${d.peakHour}h` });
  if (d.longestSession && d.longestSession.ms >= 90 * 60000) out.push({ emoji: "🏃", title: "Marathonien", sub: `${fmtDur(Math.round(d.longestSession.ms / 60000))} d'affilée` });
  if (d.totals.toolUses >= 5000) out.push({ emoji: "🛠️", title: "Forgeron", sub: `${fmt(d.totals.toolUses)} appels d'outils` });
  if (d.byProject.length >= 8) out.push({ emoji: "🤹", title: "Jongleur", sub: `${d.byProject.length} projets en parallèle` });
  if (d.totals.activeMin / 60 >= 40) out.push({ emoji: "⚡", title: "Grosse cadence", sub: `${Math.round(d.totals.activeMin / 60)}h de travail actif` });
  const wkend = d.byDow[0] + d.byDow[6], total = d.byDow.reduce((a, b) => a + b, 0);
  if (total > 0 && wkend / total > 0.3) out.push({ emoji: "🌙", title: "Weekend warrior", sub: `${Math.round((wkend / total) * 100)}% le week-end` });
  if (d.totals.cost >= 5000) out.push({ emoji: "💎", title: "Power user", sub: `${fmtUsd(d.totals.cost)} de valeur générée` });
  return out.slice(0, 6);
}

export function InsightsTab() {
  const [days, setDays] = useState(30);
  const { data, loading, refetch } = useApi<InsightsData>(`/insights?days=${days}`);

  if (loading && !data) return <div className="p-8 text-muted-foreground text-sm">Analyse des transcripts…</div>;
  if (!data || data.byProject.length === 0) return <div className="p-8 text-muted-foreground text-sm">Aucune activité trouvée sur la période.</div>;

  const dayKeys = Object.keys(data.byDay).sort();
  const maxDay = Math.max(1, ...dayKeys.map((d) => data.byDay[d].prompts + data.byDay[d].toolUses));
  const maxHour = Math.max(1, ...data.byHour);
  const maxDow = Math.max(1, ...data.byDow);
  const maxProj = Math.max(1, ...data.byProject.map((p) => p.prompts + p.toolUses));
  const nativeTools = Object.entries(data.tools).filter(([t]) => !t.startsWith("mcp__")).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxNative = nativeTools.length ? nativeTools[0][1] : 1;
  const mcpAgg: Record<string, number> = {};
  for (const [t, c] of Object.entries(data.tools)) if (t.startsWith("mcp__")) mcpAgg[mcpServer(t)] = (mcpAgg[mcpServer(t)] || 0) + c;
  const mcpRows = Object.entries(mcpAgg).sort((a, b) => b[1] - a[1]);
  const maxMcp = mcpRows.length ? mcpRows[0][1] : 1;
  const models = Object.entries(data.models).sort((a, b) => b[1] - a[1]);
  const maxModel = Math.max(1, ...models.map((m) => m[1]));
  const calendar = buildCalendar(data.byDay, data.days);
  const achv = achievements(data);
  const medals = ["🥇", "🥈", "🥉"];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-9">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400 bg-clip-text text-transparent">Insights</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {dayKeys[0]} → {dayKeys[dayKeys.length - 1]} · {data.byProject.length} projets actifs
          </p>
        </div>
        <div className="flex items-center gap-2">
          {[7, 30, 90].map((dd) => (
            <Button key={dd} size="sm" variant={days === dd ? "default" : "outline"} onClick={() => setDays(dd)}>{dd}j</Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => fetch(`/api/insights?days=${days}&refresh=1`).then(refetch)} title="Recalculer">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Feature band */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <FeatureCard icon={<Clock className="h-5 w-5" />} value={fmtDur(data.totals.activeMin)} label="Temps de travail actif" sub="estimé, hors temps mort" from="from-sky-500" to="to-blue-500" />
        <FeatureCard icon={<Sparkles className="h-5 w-5" />} value={fmtUsd(data.totals.cost)} label="Valeur générée" sub="coût API équivalent" from="from-violet-500" to="to-fuchsia-500" />
        <FeatureCard icon={<Flame className="h-5 w-5" />} value={`${data.streak.current} j`} label="Streak en cours" sub={`record : ${data.streak.longest} j`} from="from-orange-500" to="to-red-500" />
        <FeatureCard icon={<Zap className="h-5 w-5" />} value={data.longestSession ? fmtDur(Math.round(data.longestSession.ms / 60000)) : "—"} label="Plus longue session" sub={data.longestSession ? `${data.longestSession.project} · ${data.longestSession.date}` : ""} from="from-amber-500" to="to-yellow-500" />
      </div>

      {/* Achievements */}
      {achv.length > 0 && (
        <div className="flex flex-wrap gap-2.5">
          {achv.map((a) => (
            <div key={a.title} className="flex items-center gap-2.5 rounded-full border border-border bg-card pl-2.5 pr-4 py-1.5">
              <span className="text-lg leading-none">{a.emoji}</span>
              <div className="leading-tight">
                <div className="text-[13px] font-semibold text-foreground">{a.title}</div>
                <div className="text-[11px] text-muted-foreground">{a.sub}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* KPI grid */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi value={String(data.totals.prompts)} label="Prompts" />
        <Kpi value={String(data.totals.sessions)} label="Sessions" />
        <Kpi value={fmt(data.totals.toolUses)} label="Appels d'outils" />
        <Kpi value={fmt(data.totals.assistantMsgs)} label="Réponses agent" />
        <Kpi value={fmt(data.totals.outputTokens)} label="Tokens générés" />
        <Kpi value={`${dayKeys.length}/${data.days}`} label="Jours actifs" />
      </div>

      {/* Calendar */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Activité quotidienne</h2>
          {data.busiestDay && <span className="text-xs text-muted-foreground">Pic : <b className="text-foreground">{data.busiestDay.date}</b> ({fmt(data.busiestDay.count)})</span>}
        </div>
        <Card className="p-5">
          <div className="flex gap-[3px] overflow-x-auto">
            {calendar.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-[3px]">
                {week.map((cell) => (
                  <div key={cell.date} className="w-[13px] h-[13px] rounded-[3px]"
                    style={{ background: cell.future ? "transparent" : heat(cell.count / maxDay) }}
                    title={cell.future ? "" : `${cell.date} · ${cell.count}`} />
                ))}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-1.5 justify-end text-[11px] text-muted-foreground mt-3">
            Moins
            {[0, 0.2, 0.45, 0.7, 1].map((t, i) => <span key={i} className="w-[12px] h-[12px] rounded-[3px]" style={{ background: heat(t) }} />)}
            Plus
          </div>
        </Card>
      </section>

      {/* Hour + DOW */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <section>
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3">Par heure <span className="normal-case text-foreground/70">· pic à {data.peakHour}h</span></h2>
          <Card className="p-5">
            <div className="flex items-end gap-1 h-[110px]">
              {data.byHour.map((v, i) => (
                <div key={i} className={`flex-1 rounded-t min-h-[2px] ${i === data.peakHour ? "bg-gradient-to-t from-violet-500 to-fuchsia-400" : "bg-gradient-to-t from-indigo-600 to-indigo-400"}`} style={{ height: `${Math.round((v / maxHour) * 100)}%` }} title={`${i}h · ${v}`} />
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
          </Card>
        </section>
        <section>
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3">Par jour <span className="normal-case text-foreground/70">· {DOWS[data.peakDow]} en tête</span></h2>
          <Card className="p-5">
            <div className="flex gap-2.5 items-end">
              {DOWS.map((d, i) => (
                <div key={d} className="flex-1 text-center">
                  <div className="h-[80px] rounded bg-muted flex items-end overflow-hidden">
                    <div className={`w-full rounded ${i === data.peakDow ? "bg-gradient-to-t from-violet-500 to-fuchsia-400" : "bg-gradient-to-t from-emerald-600 to-emerald-400"}`} style={{ height: `${Math.round((data.byDow[i] / maxDow) * 100)}%` }} />
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1.5">{d}<br />{data.byDow[i]}</div>
                </div>
              ))}
            </div>
          </Card>
        </section>
      </div>

      {/* Project leaderboard */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3">Classement projets</h2>
        <Card className="p-5 space-y-3">
          {data.byProject.map((p, i) => (
            <div key={p.dir} className="grid grid-cols-[20px_150px_1fr_auto] items-center gap-3 text-[13px]">
              <div className="text-center">{medals[i] ?? <span className="text-muted-foreground text-xs">{i + 1}</span>}</div>
              <div className="truncate text-foreground font-medium">{p.name}</div>
              <div className="h-[20px] rounded bg-muted overflow-hidden">
                <div className="h-full rounded bg-gradient-to-r from-indigo-500 to-violet-400" style={{ width: `${Math.round((p.prompts + p.toolUses) / maxProj * 100)}%` }} />
              </div>
              <div className="flex items-center gap-3 justify-end w-[210px]">
                <Momentum recent={p.recent} prev={p.prev} />
                <span className="text-muted-foreground tabular-nums w-[44px] text-right" title="prompts + outils">{fmt(p.prompts + p.toolUses)}</span>
                <span className="text-muted-foreground tabular-nums w-[40px] text-right" title="temps actif">{fmtDur(p.activeMin)}</span>
                <span className="text-violet-400/80 tabular-nums w-[46px] text-right" title="coût API équivalent">{fmtUsd(p.cost)}</span>
              </div>
            </div>
          ))}
        </Card>
      </section>

      {/* Tools + MCP */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <section>
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3">Outils natifs</h2>
          <Card className="p-5"><Bars rows={nativeTools.map(([t, c]) => [prettyTool(t), c])} max={maxNative} /></Card>
        </section>
        <section>
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3">Serveurs MCP</h2>
          <Card className="p-5">{mcpRows.length ? <Bars rows={mcpRows} max={maxMcp} /> : <div className="text-sm text-muted-foreground">Aucun appel MCP.</div>}</Card>
        </section>
      </div>

      {/* Models */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3">Modèles</h2>
        <Card className="p-5"><Bars rows={models} max={maxModel} /></Card>
      </section>

      {/* Per-project detail */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Trophy className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Détail par projet</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.byProject.map((p) => {
            const dr = p.first ? `${new Date(p.first).toISOString().slice(0, 10)} → ${new Date(p.last!).toISOString().slice(0, 10)}` : "";
            return (
              <Card key={p.dir} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-foreground">{p.name}</div>
                  <Momentum recent={p.recent} prev={p.prev} />
                </div>
                <div className="text-[11px] text-muted-foreground tabular-nums mt-0.5">{dr}</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground mt-3 pt-3 border-t border-border">
                  <span><b className="text-indigo-400">{p.prompts}</b> prompts</span>
                  <span><b className="text-indigo-400">{fmt(p.toolUses)}</b> outils</span>
                  <span><b className="text-indigo-400">{p.sessions}</b> sessions</span>
                  <span><b className="text-indigo-400">{p.days}</b> j actifs</span>
                  <span><b className="text-indigo-400">{fmtDur(p.activeMin)}</b> actif</span>
                  <span><b className="text-violet-400">{fmtUsd(p.cost)}</b> valeur</span>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      <p className="text-xs text-muted-foreground border-t border-border pt-4">
        Source : ~/.claude/projects (sessions locales, par répertoire). Prompts = messages humains hors méta-prompts auto-générés.
        « Valeur générée » = coût équivalent aux tarifs API Opus ({fmt(data.totals.cacheTokens)} tokens de cache inclus) — indicatif, non facturé sous abonnement.
        Temps actif estimé en sommant les intervalles &lt; 5 min entre événements. Recalculé toutes les 2 min.
      </p>
    </div>
  );
}
