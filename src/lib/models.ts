export interface ModelOption {
  /** Valeur passée à `claude --model`. Vide = défaut de la CLI. */
  id: string;
  /** Libellé complet (SettingsTab). */
  label: string;
  /** Libellé compact (barre du chat). */
  short: string;
}

// On utilise des ALIAS (opus / sonnet / haiku…) et non des IDs versionnés.
// La CLI Claude les résout automatiquement vers la dernière version disponible
// (cf. `claude --help`: « Provide an alias for the latest model »).
// => aucune mise à jour manuelle à faire quand un nouveau modèle sort.
export const AVAILABLE_MODELS: ModelOption[] = [
  { id: "", label: "Default (Claude CLI default)", short: "Default" },
  { id: "opus", label: "Claude Opus (latest)", short: "Opus" },
  { id: "opus[1m]", label: "Claude Opus (latest, 1M context)", short: "Opus 1M" },
  { id: "sonnet", label: "Claude Sonnet (latest)", short: "Sonnet" },
  { id: "sonnet[1m]", label: "Claude Sonnet (latest, 1M context)", short: "Sonnet 1M" },
  { id: "haiku", label: "Claude Haiku (latest)", short: "Haiku" },
];

// Transforme l'ID complet renvoyé par la CLI (event system/init) en libellé lisible.
// ex: "claude-opus-4-8-20260115" -> "Opus 4.8" ; "claude-sonnet-4-6[1m]" -> "Sonnet 4.6 (1M)"
export function formatModelVersion(id: string): string {
  if (!id) return "";
  const oneM = /\[1m\]/i.test(id) ? " (1M)" : "";
  const m = id.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (m) {
    const fam = m[1][0].toUpperCase() + m[1].slice(1);
    return `${fam} ${m[2]}.${m[3]}${oneM}`;
  }
  return id.replace(/^claude-/, "") + oneM;
}
