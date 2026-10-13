import { useState, useEffect } from "react";
import type { ModelCatalog, ModelOption, Provider } from "@sinapse/core";

let catalogCache: ModelCatalog | null = null;
let catalogPromise: Promise<ModelCatalog> | null = null;

export async function getModelCatalog(): Promise<ModelCatalog> {
  if (catalogCache) return catalogCache;
  if (!catalogPromise) {
    catalogPromise = (async () => {
      try {
        const res = await window.sinapse?.models?.list();
        if (res) {
          catalogCache = res;
          return res;
        }
      } catch (err) {
        console.error("Erro ao carregar catálogo de modelos:", err);
      }
      return { claude: [], agy: [] };
    })().finally(() => {
      catalogPromise = null;
    });
  }
  return catalogPromise;
}

export interface ModelSelectProps {
  provider: Provider;
  value?: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
  resolvedModel?: string;
  className?: string;
  id?: string;
}

export function ModelSelect({
  provider,
  value,
  onChange,
  disabled = false,
  resolvedModel,
  className = "",
  id,
}: ModelSelectProps) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(catalogCache);

  useEffect(() => {
    if (!catalogCache) {
      getModelCatalog().then((cat) => setCatalog(cat));
    }
  }, []);

  const providerKey = provider === "agy" ? "agy" : "claude";
  const options: ModelOption[] = catalog?.[providerKey] || [];
  const selectedValue = value ?? "";

  const hasDiffHint = Boolean(
    resolvedModel &&
      resolvedModel.trim() !== "" &&
      resolvedModel.trim() !== selectedValue
  );

  const hintText = selectedValue
    ? `${selectedValue} → ${resolvedModel}`
    : `padrão → ${resolvedModel}`;

  return (
    <div className={`model-select-wrapper ${className}`}>
      <select
        id={id}
        value={selectedValue}
        disabled={disabled}
        onChange={(e) => {
          const val = e.target.value.trim();
          onChange(val === "" ? null : val);
        }}
        className="model-select-dropdown"
      >
        <option value="">Padrão</option>
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label || opt.id}
          </option>
        ))}
        {selectedValue && !options.some((o) => o.id === selectedValue) && (
          <option value={selectedValue}>{selectedValue}</option>
        )}
      </select>
      {hasDiffHint && (
        <span
          className="model-resolved-hint"
          title={`Modelo resolvido pelo CLI: ${resolvedModel}`}
        >
          {hintText}
        </span>
      )}
    </div>
  );
}
