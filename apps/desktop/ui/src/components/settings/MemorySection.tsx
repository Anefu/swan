import { Field } from "../ui";
import { Section, type SectionProps } from "./Section";

/** The memory brief and /dream. */
export function MemorySection({ d, update, errors }: SectionProps) {
  return (
    <Section
      id="memory"
      title="Memory"
      summary={[
        d.memory.autoBrief ? (Number.isFinite(d.memory.briefTokens) ? `Brief · ${d.memory.briefTokens.toLocaleString()} tokens` : "Brief on") : "No brief",
        d.memory.autoDream !== false ? "auto /dream" : "",
      ]
        .filter(Boolean)
        .join(" · ")}
      invalid={!!errors.briefTokens}
    >
      <label className="check-row">
        <input type="checkbox" checked={d.memory.autoBrief} onChange={(e) => update((x) => void (x.memory.autoBrief = e.target.checked))} />
        <span>Load a memory brief at the start of each context</span>
      </label>
      <Field label="Brief size (tokens)" error={errors.briefTokens}>
        {(f) => (
          <input
            {...f}
            className="input"
            type="number"
            min={0}
            step={100}
            value={Number.isFinite(d.memory.briefTokens) ? d.memory.briefTokens : ""}
            onChange={(e) => update((x) => void (x.memory.briefTokens = e.target.value === "" ? Number.NaN : Number(e.target.value)))}
          />
        )}
      </Field>
      <label className="check-row">
        <input type="checkbox" checked={d.memory.autoDream !== false} onChange={(e) => update((x) => void (x.memory.autoDream = e.target.checked))} />
        <span>Tidy memory with /dream when a context fills up, and when a conversation you wrote in has been quiet for 10 minutes</span>
      </label>
      <p className="hint">Memory is private to this persona. Review it in Memory &amp; Usage.</p>
    </Section>
  );
}
