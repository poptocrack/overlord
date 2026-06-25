import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, FolderEdit, Trash2, AlertTriangle } from "lucide-react";
import { patch } from "../hooks/useApi.js";
import type { Project } from "../types.js";

// Source unique de la liste des modèles (cf. src/lib/models.ts).
// Ré-exportée ici pour compat avec les imports existants.
export { AVAILABLE_MODELS } from "../lib/models.js";
import { useModels } from "../hooks/useModels.js";

export const DEFAULT_TOOLS = [
  "Edit", "Write", "Read", "Bash", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "ToolSearch", "Agent",
];

export const OVERLORD_MCP_TOOLS = [
  "mcp__overlord__overlord_list_todos",
  "mcp__overlord__overlord_add_todo",
  "mcp__overlord__overlord_complete_todo",
  "mcp__overlord__overlord_delete_todo",
  "mcp__overlord__overlord_list_projects",
  "mcp__overlord__overlord_get_project",
  "mcp__overlord__overlord_ask_project",
];

const DEFAULT_SYSTEM_PROMPT = "Match the language of the user's message in your response. When you respond in French, always use proper accents (é, è, ê, à, â, ù, û, ç, ô, etc.) — never write French without accents.";

interface Props {
  project: Project;
}

export function SettingsTab({ project }: Props) {
  const [systemPrompt, setSystemPrompt] = useState(project.systemPrompt ?? "");
  const [model, setModel] = useState(project.model ?? "");
  const models = useModels();
  const [learningsEnabled, setLearningsEnabled] = useState(project.learningsEnabled ?? true);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(() => {
    if (project.allowedTools) {
      try { return new Set(JSON.parse(project.allowedTools)); } catch {}
    }
    return new Set([...DEFAULT_TOOLS, ...OVERLORD_MCP_TOOLS]);
  });
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [effectivePrompt, setEffectivePrompt] = useState<{
    base: string;
    nudges: { name: string; content: string; reason: string }[];
    full: string;
  } | null>(null);
  const [showEffective, setShowEffective] = useState(false);

  useEffect(() => {
    setSystemPrompt(project.systemPrompt ?? "");
    setModel(project.model ?? "");
    setLearningsEnabled(project.learningsEnabled ?? true);
    setDirty(false);
  }, [project.id]);

  // Re-fetch the effective prompt whenever the saved settings change
  useEffect(() => {
    fetch(`/api/projects/${project.id}/system-prompt?channel=chat`)
      .then((r) => r.json())
      .then((data) => setEffectivePrompt(data))
      .catch(() => setEffectivePrompt(null));
  }, [project.id, saved]);

  const toggleTool = useCallback((tool: string) => {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (next.has(tool)) next.delete(tool);
      else next.add(tool);
      return next;
    });
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    await patch(`/projects/${project.id}`, {
      systemPrompt: systemPrompt || null,
      model: model || null,
      allowedTools: JSON.stringify([...selectedTools]),
      learningsEnabled,
    });
    setSaved(true);
    setDirty(false);
    setTimeout(() => setSaved(false), 2000);
  }, [project.id, systemPrompt, model, selectedTools, learningsEnabled]);

  const handleReset = useCallback(() => {
    setSystemPrompt("");
    setModel("");
    setSelectedTools(new Set([...DEFAULT_TOOLS, ...OVERLORD_MCP_TOOLS]));
    setDirty(true);
  }, []);

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-6">
      {/* Header actions */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Agent settings for {project.name}</h3>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={handleReset}>
            Reset to defaults
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!dirty && !saved}>
            {saved ? (
              <>
                <Check className="h-3 w-3 mr-1" /> Saved
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </div>

      {/* Location */}
      <LocationCard project={project} />

      {/* Model */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Model</CardTitle>
          <CardDescription className="text-xs">
            Claude model to use for this project. Empty = use Claude CLI default.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <select
            value={model}
            onChange={(e) => { setModel(e.target.value); setDirty(true); }}
            className="w-full rounded-md border border-border bg-secondary px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </CardContent>
      </Card>

      {/* System prompt */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">System prompt</CardTitle>
          <CardDescription className="text-xs">
            Appended to Claude's default system prompt. Default: {DEFAULT_SYSTEM_PROMPT}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            value={systemPrompt}
            onChange={(e) => { setSystemPrompt(e.target.value); setDirty(true); }}
            placeholder={DEFAULT_SYSTEM_PROMPT}
            className="min-h-[120px] resize-y font-mono text-xs"
          />

          {effectivePrompt && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold">
                  Effective prompt sent to Claude
                  {effectivePrompt.nudges.length > 0 && (
                    <span className="ml-2 text-[10px] text-emerald-400 font-normal">
                      + {effectivePrompt.nudges.length} auto-nudge{effectivePrompt.nudges.length > 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={() => setShowEffective((s) => !s)}>
                  {showEffective ? "Masquer" : "Afficher"}
                </Button>
              </div>
              {effectivePrompt.nudges.length > 0 && (
                <div className="space-y-1">
                  {effectivePrompt.nudges.map((n) => (
                    <div key={n.name} className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5 text-[11px]">
                      <span className="font-semibold text-emerald-400">{n.name}</span>
                      <span className="ml-2 text-muted-foreground">{n.reason}</span>
                    </div>
                  ))}
                </div>
              )}
              {showEffective && (
                <pre className="max-h-[300px] overflow-auto rounded-md border border-border bg-secondary/50 p-3 text-[11px] font-mono whitespace-pre-wrap select-text">
                  {effectivePrompt.full}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Session analysis */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Analyse de session</CardTitle>
          <CardDescription className="text-xs">
            A la fin de chaque conversation chat (≥3 tool uses ou messages), Overlord lance un agent Claude qui analyse la session et extrait les apprentissages (dead ends, missing context, recommandations) — visibles dans l'onglet Summary.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={learningsEnabled}
              onChange={(e) => { setLearningsEnabled(e.target.checked); setDirty(true); }}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span>Activer l'analyse automatique apres chaque session</span>
          </label>
          {!learningsEnabled && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Desactive : les sessions ne seront plus analysees. Ca economise tokens + temps mais tu n'auras plus de retro auto.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Allowed tools */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Allowed tools</CardTitle>
          <CardDescription className="text-xs">
            Tools the agent is allowed to use without asking permission.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Built-in tools
            </div>
            <div className="flex flex-wrap gap-1.5">
              {DEFAULT_TOOLS.map((tool) => (
                <ToolToggle key={tool} tool={tool} selected={selectedTools.has(tool)} onToggle={toggleTool} />
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Overlord MCP tools
            </div>
            <div className="flex flex-wrap gap-1.5">
              {OVERLORD_MCP_TOOLS.map((tool) => (
                <ToolToggle
                  key={tool}
                  tool={tool}
                  label={tool.replace("mcp__overlord__overlord_", "")}
                  selected={selectedTools.has(tool)}
                  onToggle={toggleTool}
                />
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Danger zone */}
      <DangerZoneCard project={project} />
    </div>
  );
}

function DangerZoneCard({ project }: { project: Project }) {
  const [confirming, setConfirming] = useState(false);
  const [deleteFolder, setDeleteFolder] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expected = project.name;
  const canDelete = confirmText === expected;

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${project.id}?deleteFolder=${deleteFolder}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setDeleting(false);
        return;
      }
      localStorage.removeItem("overlord:projectId");
      window.location.reload();
    } catch (err) {
      setError(String(err));
      setDeleting(false);
    }
  }, [project.id, deleteFolder]);

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          Zone dangereuse
        </CardTitle>
        <CardDescription className="text-xs">
          Supprime ce projet d'Overlord et toutes ses donnees (chats, todos, marketing, settings).
          Optionnellement, supprime aussi le dossier du disque.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!confirming ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirming(true)}
            className="gap-1.5 w-fit"
          >
            <Trash2 className="h-3 w-3" />
            Supprimer ce projet...
          </Button>
        ) : (
          <div className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={deleteFolder}
                onChange={(e) => setDeleteFolder(e.target.checked)}
              />
              <span>
                Supprimer aussi le dossier sur le disque
                <span className="text-muted-foreground font-mono ml-1">({project.path})</span>
              </span>
            </label>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground">
                Pour confirmer, tape le nom du projet : <strong className="text-foreground">{expected}</strong>
              </label>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={expected}
                className="h-8 text-xs font-mono"
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={!canDelete || deleting}
              >
                {deleting ? "Suppression..." : deleteFolder ? "Supprimer projet + dossier" : "Supprimer projet"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setConfirming(false); setConfirmText(""); setError(null); setDeleteFolder(false); }}
                disabled={deleting}
              >
                Annuler
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LocationCard({ project }: { project: Project }) {
  const [editing, setEditing] = useState(false);
  const [newPath, setNewPath] = useState(project.path);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setNewPath(project.path);
    setEditing(false);
    setError(null);
  }, [project.id, project.path]);

  const handleSave = useCallback(async () => {
    if (!newPath.trim() || newPath === project.path) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: newPath.trim() }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setEditing(false);
        // Trigger a full reload so the project list refreshes with new path
        window.location.reload();
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [newPath, project.id, project.path]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <FolderEdit className="h-4 w-4" />
          Location
        </CardTitle>
        <CardDescription className="text-xs">
          Renomme ou déplace le dossier du projet. Si le dossier actuel existe, il sera déplacé. Sinon un nouveau dossier sera créé. Erreur si un dossier existe déjà à la nouvelle location.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {editing ? (
          <>
            <Input
              value={newPath}
              onChange={(e) => { setNewPath(e.target.value); setError(null); }}
              placeholder="/Users/you/Developer/new-name"
              className="font-mono text-xs"
              autoFocus
            />
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving || newPath === project.path}>
                {saving ? "Verification..." : "Mettre à jour"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setEditing(false); setNewPath(project.path); setError(null); }}
              >
                Annuler
              </Button>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <code className="font-mono text-xs text-muted-foreground truncate">{project.path}</code>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Changer
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ToolToggle({ tool, label, selected, onToggle }: { tool: string; label?: string; selected: boolean; onToggle: (t: string) => void }) {
  return (
    <button
      onClick={() => onToggle(tool)}
      className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-mono transition-colors ${
        selected
          ? "bg-primary text-primary-foreground"
          : "bg-secondary text-muted-foreground hover:text-foreground"
      }`}
    >
      {label ?? tool}
    </button>
  );
}
