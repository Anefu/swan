import { useStore } from "../../store";
import { Field } from "../ui";
import { Section, type SectionProps } from "./Section";

/** The persona's name, description and instructions; for a new one, its file name and model too. */
export function NameSection({ d, update, errors, isNew, newId, onNewId, newModel, onNewModel }: SectionProps & { isNew: boolean; newId: string; onNewId: (id: string) => void; newModel: { provider: string; id: string }; onNewModel: (m: { provider: string; id: string }) => void }) {
  const { state } = useStore();
  return (
    <Section id="name" title="Name and instructions" invalid={!!(errors.name || errors.id)}>
      {isNew && (
        <Field label="File name" error={errors.id} hint={`Saved as personas/${newId || "<name>"}.yaml`}>
          {(f) => (
            <input
              {...f}
              className="input mono"
              value={newId}
              placeholder="backend-dev"
              spellCheck={false}
              onChange={(e) =>
                onNewId(e.target.value.toLowerCase().replace(/[\s_]+/g, "-"))
              }
            />
          )}
        </Field>
      )}
      <Field label="Name" error={errors.name}>
        {(f) => <input {...f} className="input" value={d.name} onChange={(e) => update((x) => void (x.name = e.target.value))} />}
      </Field>
      <Field label="Description">
        {(f) => (
          <input {...f} className="input" value={d.description} onChange={(e) => update((x) => void (x.description = e.target.value))} />
        )}
      </Field>
      <Field label="Instructions">
        {(f) => (
          <textarea
            {...f}
            className="input"
            rows={6}
            value={d.instructions}
            onChange={(e) => update((x) => void (x.instructions = e.target.value))}
          />
        )}
      </Field>
      {isNew && (
        <Field label="Model" hint="Change it later under the composer.">
          {(f) =>
            state.models && state.models.length > 0 ? (
              <select
                {...f}
                className="input"
                value={`${newModel.provider}\u0001${newModel.id}`}
                onChange={(e) => {
                  const [provider, mid] = e.target.value.split("\u0001");
                  onNewModel({ provider, id: mid });
                }}
              >
                {state.models.map((m) => (
                  <option key={`${m.provider}/${m.id}`} value={`${m.provider}\u0001${m.id}`}>
                    {m.label} · {m.provider}
                    {m.ready ? "" : " · needs key"}
                  </option>
                ))}
              </select>
            ) : (
              <div className="row gap">
                <input
                  {...f}
                  className="input"
                  placeholder="provider"
                  aria-label="Provider"
                  value={newModel.provider}
                  onChange={(e) => onNewModel({ ...newModel, provider: e.target.value })}
                />
                <input
                  className="input mono"
                  placeholder="model id"
                  aria-label="Model id"
                  value={newModel.id}
                  onChange={(e) => onNewModel({ ...newModel, id: e.target.value })}
                />
              </div>
            )
          }
        </Field>
      )}
    </Section>
  );
}
