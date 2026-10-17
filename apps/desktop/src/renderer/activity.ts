import type { TurnEvent, TurnRecord } from "@sinapse/core";

export type ActivityEntry =
  | { kind: "prompt"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "error"; text: string }
  | {
      kind: "tool";
      /** Provider call id (Claude tool_use.id), used to pair the result. */
      id?: string;
      name: string;
      /** Short one-line hint of the arguments (command, file path...). */
      summary: string;
      input: string;
      result?: string;
      resultIsError?: boolean;
    };

const MAX_ENTRIES = 300;
const MAX_TEXT = 20_000;
const MAX_THINKING = 8_000;
const MAX_INPUT = 2_000;
const MAX_RESULT = 4_000;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function tailClip(s: string, max: number): string {
  return s.length > max ? `…${s.slice(-max)}` : s;
}

function parseJson(raw: string): Record<string, any> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function toolName(p: Record<string, any> | null, raw: string): string {
  if (!p) return raw.slice(0, 30) || "ferramenta";
  return p.name || p.tool_name || p.tool || p.call?.name || p.call?.tool_name || "ferramenta";
}

function summarize(p: Record<string, any>): string {
  const input = p.input && typeof p.input === "object" ? p.input : p;
  const keys = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"];
  for (const k of keys) {
    const v = input[k] ?? p[k];
    if (typeof v === "string" && v.trim()) return clip(v.trim().replace(/\s+/g, " "), 80);
  }
  const changes = p.changes;
  if (Array.isArray(changes) && changes.length > 0) {
    const paths = changes.map((c: any) => (typeof c === "string" ? c : c?.path)).filter(Boolean);
    if (paths.length > 0) return clip(paths.join(", "), 80);
  }
  if (typeof p.input === "string" && p.input.trim()) return clip(p.input.trim().replace(/\s+/g, " "), 80);
  return "";
}

function inputText(p: Record<string, any>): string {
  if (p.input !== undefined) return clip(stringify(p.input), MAX_INPUT);
  const { name: _n, id: _i, type: _t, ...rest } = p;
  return Object.keys(rest).length > 0 ? clip(stringify(rest), MAX_INPUT) : "";
}

function resultText(p: Record<string, any> | null, raw: string): string {
  if (!p) return clip(raw, MAX_RESULT);
  if (p.output !== undefined) {
    let out = stringify(p.output);
    if (p.exit_code !== undefined && p.exit_code !== null && p.exit_code !== 0) out = `(exit ${p.exit_code})\n${out}`;
    return clip(out, MAX_RESULT);
  }
  if (p.changes !== undefined) return clip(`${p.status ?? ""}\n${stringify(p.changes)}`.trim(), MAX_RESULT);
  if (p.content !== undefined) return clip(stringify(p.content), MAX_RESULT);
  return clip(stringify(p), MAX_RESULT);
}

function cap(entries: ActivityEntry[]): ActivityEntry[] {
  return entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries;
}

export function appendPrompt(entries: ActivityEntry[], prompt: string): ActivityEntry[] {
  return cap([...entries, { kind: "prompt", text: clip(prompt, MAX_TEXT) }]);
}

/** Pure: returns a new array (or the same one when the event adds nothing). Used for live events and for disk history. */
export function appendTurnEvent(entries: ActivityEntry[], event: TurnEvent): ActivityEntry[] {
  const last = entries[entries.length - 1];
  switch (event.type) {
    case "text":
    case "thinking": {
      const max = event.type === "text" ? MAX_TEXT : MAX_THINKING;
      if (last && last.kind === event.type) {
        return [...entries.slice(0, -1), { kind: event.type, text: tailClip(last.text + event.data, max) }];
      }
      return cap([...entries, { kind: event.type, text: tailClip(event.data, max) }]);
    }
    case "error":
      return cap([...entries, { kind: "error", text: clip(event.data, MAX_RESULT) }]);
    case "tool_use": {
      const p = parseJson(event.data);
      return cap([
        ...entries,
        {
          kind: "tool",
          ...(typeof p?.id === "string" ? { id: p.id } : {}),
          name: toolName(p, event.data),
          summary: p ? summarize(p) : "",
          input: p ? inputText(p) : clip(event.data, MAX_INPUT),
        },
      ]);
    }
    case "tool_result": {
      const p = parseJson(event.data);
      const name = toolName(p, "");
      const text = resultText(p, event.data);
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const callId = typeof p?.tool_use_id === "string" ? p.tool_use_id : undefined;
        const matches = callId ? e.kind === "tool" && e.id === callId : e.kind === "tool" && (e.name === name || name === "ferramenta");
        if (e.kind === "tool" && e.result === undefined && matches) {
          const next = entries.slice();
          next[i] = { ...e, result: text, resultIsError: p?.is_error === true || (typeof p?.exit_code === "number" && p.exit_code !== 0) };
          return next;
        }
      }
      return cap([...entries, { kind: "tool", name, summary: p ? summarize(p) : "", input: "", result: text }]);
    }
    default:
      return entries;
  }
}

export function turnRecordEntries(record: TurnRecord): ActivityEntry[] {
  let entries = appendPrompt([], record.prompt);
  for (const e of record.events) entries = appendTurnEvent(entries, e);
  return entries;
}
