import { useStore } from "../../store";
import { IconPlus } from "../icons";
import { Field } from "../ui";
import { Section, listSummary, type SectionProps } from "./Section";
import { SubagentRow } from "./SubagentRow";

/** The persona's named sub-agents and the limits on them. */
export function SubagentsSection({ d, update, errors }: SectionProps) {
  const { state } = useStore();
  return (
    <Section
      id="subagents"
      title="Sub-agents"
      summary={`${d.subagents.agents.length ? listSummary(d.subagents.agents.map((a) => a.name), "sub-agent") : "None"} · ${
        Number.isFinite(d.subagents.maxBackground) ? d.subagents.maxBackground : "?"
      } at once`}
      invalid={Object.keys(errors).some((k) => k.startsWith("sa-")) || !!errors.maxBackground || !!errors.maxTurns}
    >
      <div className="field">
        <span className="field-label">Sub-agents</span>
        {d.subagents.agents.map((a, i) => (
          <SubagentRow
            key={i}
            index={i}
            name={a.name}
            model={a.model}
            models={state.models}
            error={errors[`sa-${i}`]}
            onName={(v) => update((x) => void (x.subagents.agents[i].name = v))}
            onModel={(v) => update((x) => void (x.subagents.agents[i].model = v))}
            onRemove={() => update((x) => void x.subagents.agents.splice(i, 1))}
          />
        ))}
        <button type="button" className="link-btn" onClick={() => update((x) => void x.subagents.agents.push({ name: "", model: "auto" }))}>
          <IconPlus /> Add sub-agent
        </button>
        <p className="hint">Auto lets the agent choose the model and effort for each task.</p>
      </div>
      <Field label="Background agents at once" error={errors.maxBackground}>
        {(f) => (
          <input
            {...f}
            className="input short"
            type="number"
            min={0}
            max={32}
            value={Number.isFinite(d.subagents.maxBackground) ? d.subagents.maxBackground : ""}
            aria-invalid={!!errors.maxBackground}
            onChange={(e) => update((x) => void (x.subagents.maxBackground = e.target.value === "" ? Number.NaN : Number(e.target.value)))}
          />
        )}
      </Field>
      <Field label="Most turns per agent" error={errors.maxTurns}>
        {(f) => (
          <input
            {...f}
            className="input short"
            type="number"
            min={1}
            max={1000}
            value={Number.isFinite(d.subagents.maxTurns) ? d.subagents.maxTurns : ""}
            aria-invalid={!!errors.maxTurns}
            onChange={(e) => update((x) => void (x.subagents.maxTurns = e.target.value === "" ? Number.NaN : Number(e.target.value)))}
          />
        )}
      </Field>
      <p className="hint">
        The agent picks a sub-agent, its context and turns for each task, within these limits. Sub-agents can't start sub-agents.
      </p>
    </Section>
  );
}
