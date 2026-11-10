import { useStore } from "../../store";
import { errorMessage } from "../../util";
import { Field, Fold } from "../ui";
import { Section, plural, type SectionProps } from "./Section";

/** The skills the persona loads and its MCP servers, edited as JSON. */
export function ToolsSection({ d, update, errors, mcp }: SectionProps & { mcp: { text: string | null; setText: (t: string) => void; setError: (e: string | null) => void } }) {
  const { state } = useStore();
  const allSkills = Array.from(new Set([...state.skills.map((s) => s.name), ...d.skills])).sort();
  const mcpValue = mcp.text ?? JSON.stringify(d.mcpServers, null, 2);
  return (
    <Section
      id="tools"
      title="MCP servers and skills"
      summary={`${plural(Object.keys(d.mcpServers).length, "server")}, ${plural(d.skills.length, "skill")}`}
      invalid={!!errors.mcp}
    >
      <h4>Skills</h4>
      {allSkills.length === 0 && <p className="muted small">No skills installed.</p>}
      {allSkills.length > 0 && (
      <Fold summary={`${d.skills.length} of ${allSkills.length} on`}>
      {allSkills.map((name) => {
        const s = state.skills.find((x) => x.name === name);
        return (
          <label key={name} className="check-row">
            <input
              type="checkbox"
              checked={d.skills.includes(name)}
              onChange={(e) =>
                update((x) => {
                  x.skills = e.target.checked ? [...x.skills, name] : x.skills.filter((n) => n !== name);
                })
              }
            />
            <span className="mono">{name}</span>
            <span className="muted small">· {s ? s.description : "not installed"}</span>
          </label>
        );
      })}
      </Fold>
      )}
      <Field
        label="MCP servers (JSON)"
        error={errors.mcp}
        hint="stdio servers run in the sandbox and see placeholders; http servers run on the host."
      >
        {(f) => (
          <textarea
            {...f}
            className="input mono"
            rows={Math.min(14, Math.max(3, mcpValue.split("\n").length))}
            value={mcpValue}
            spellCheck={false}
            onChange={(e) => {
              mcp.setText(e.target.value);
              try {
                const v = JSON.parse(e.target.value || "{}") as unknown;
                if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("Use an object keyed by server name.");
                mcp.setError(null);
                update((x) => void (x.mcpServers = v as Record<string, unknown>));
              } catch (err) {
                mcp.setError(err instanceof SyntaxError ? "Not valid JSON yet." : errorMessage(err));
              }
            }}
          />
        )}
      </Field>
    </Section>
  );
}
