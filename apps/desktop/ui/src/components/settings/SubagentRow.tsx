// One named sub-agent of the persona.
import { useId } from "react";
import type { ModelOption } from "@ph/shared";
import { IconTrash } from "../icons";

export function SubagentRow({
  index,
  name,
  model,
  models,
  error,
  onName,
  onModel,
  onRemove,
}: {
  index: number;
  name: string;
  model: string;
  models: ModelOption[] | null;
  error?: string;
  onName: (v: string) => void;
  onModel: (v: string) => void;
  onRemove: () => void;
}) {
  const nameId = useId();
  const modelId = useId();
  const label = name.trim() || `sub-agent ${index + 1}`;
  const listed = models?.some((m) => `${m.provider}/${m.id}` === model) ?? false;
  return (
    <div className="folder-row">
      <div className="row gap even">
        <label htmlFor={nameId} className="sr-only">
          Name of sub-agent {index + 1}
        </label>
        <input
          id={nameId}
          className="input mono"
          value={name}
          placeholder="researcher"
          maxLength={32}
          spellCheck={false}
          aria-invalid={!!error}
          onChange={(e) => onName(e.target.value.toLowerCase().replace(/[\s_]+/g, "-"))}
        />
        <label htmlFor={modelId} className="sr-only">
          Model for {label}
        </label>
        {models && models.length > 0 ? (
          <select id={modelId} className="input" value={model} onChange={(e) => onModel(e.target.value)}>
            <option value="auto">Auto</option>
            {!listed && model !== "auto" && <option value={model}>{model}</option>}
            {models.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.label} · {m.provider}
                {m.ready ? "" : " · needs key"}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={modelId}
            className="input mono"
            value={model}
            placeholder="provider/model or auto"
            spellCheck={false}
            onChange={(e) => onModel(e.target.value)}
          />
        )}
        <button type="button" className="icon-btn" aria-label={`Remove sub-agent ${name.trim() || index + 1}`} onClick={onRemove}>
          <IconTrash />
        </button>
      </div>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}
