// Minimal YAML emitter for creating a persona file from the Settings form.
// Strings are double-quoted (JSON escapes are valid YAML) unless they span lines.

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function key(k: string): string {
  return PLAIN_KEY.test(k) ? k : JSON.stringify(k);
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(String(v));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function block(s: string, indent: string): string {
  // A block scalar cannot start with indentation or carry trailing spaces safely; quote those.
  if (/^[ \t]/.test(s) || /[ \t]$/m.test(s)) return JSON.stringify(s);
  const body = s.replace(/\n+$/, "");
  return `|\n${body
    .split("\n")
    .map((l) => (l ? `${indent}  ${l}` : ""))
    .join("\n")}`;
}

function emit(v: unknown, indent: string): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return " []";
    return (
      "\n" +
      v
        .map((item) => {
          if (isPlainObject(item) && Object.keys(item).length > 0) {
            const inner = emitObject(item, `${indent}  `);
            return `${indent}- ${inner.slice(indent.length + 2)}`;
          }
          return `${indent}-${emit(item, `${indent}  `)}`;
        })
        .join("\n")
    );
  }
  if (isPlainObject(v)) {
    if (Object.keys(v).length === 0) return " {}";
    return `\n${emitObject(v, indent)}`;
  }
  if (typeof v === "string" && v.includes("\n")) return ` ${block(v, indent.slice(0, -2) || "")}`;
  return ` ${scalar(v)}`;
}

function emitObject(o: Record<string, unknown>, indent: string): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      if (typeof v === "string" && v.includes("\n")) return `${indent}${key(k)}: ${block(v, indent)}`;
      return `${indent}${key(k)}:${emit(v, `${indent}  `)}`;
    })
    .join("\n");
}

export function toYaml(o: Record<string, unknown>): string {
  return `${emitObject(o, "")}\n`;
}
