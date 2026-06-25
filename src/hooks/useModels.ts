import { useEffect, useState } from "react";
import { AVAILABLE_MODELS, type ModelOption } from "../lib/models.js";

// Récupère la liste des modèles depuis le backend (alias résolus en versions
// réelles via l'event system/init de la CLI). Repli sur la liste statique tant
// que la requête n'a pas répondu, ou en cas d'échec.
export function useModels(): ModelOption[] {
  const [models, setModels] = useState<ModelOption[]>(AVAILABLE_MODELS);

  useEffect(() => {
    let alive = true;
    fetch("/api/models")
      .then((r) => r.json())
      .then((data) => {
        if (alive && Array.isArray(data) && data.length) setModels(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return models;
}
