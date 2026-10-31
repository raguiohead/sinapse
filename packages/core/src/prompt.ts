// Text the daemon and the adapters put in front of a worker's prompt.

export function rolePreamble(role: string): string {
  return `Seu papel neste time: ${role}`;
}

export function handoffPreamble(note: string): string {
  return (
    `Antes de qualquer coisa, rode \`sinapse note read ${note}\`: é o handoff da sua sessão anterior ` +
    `(objetivo, estado, decisões, arquivos e pendências). Continue o trabalho a partir dele.`
  );
}

export const PINNED_NOTE_MAX_BYTES = 16 * 1024;
export const PINNED_NOTES_TOTAL_BYTES = 48 * 1024;

export interface PinnedNoteInput {
  name: string;
  /** Current content to inject; undefined = already delivered in this session, only remind. */
  content?: string;
}

function truncateUtf8(text: string, maxBytes: number): string {
  // Cutting mid-character leaves a replacement char at the end; drop it.
  return Buffer.from(text, "utf-8").subarray(0, maxBytes).toString("utf-8").replace(/�+$/, "");
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Preamble with the pinned notes: full content for the ones given `content` (per-note and total byte caps),
 * a short reminder for the rest. `delivered` lists the notes whose content went in, even if truncated.
 */
export function pinnedNotesPreamble(notes: PinnedNoteInput[]): { text?: string; delivered: string[] } {
  const delivered: string[] = [];
  const blocks: string[] = [];
  const omitted: string[] = [];
  const reminded: string[] = [];
  let budget = PINNED_NOTES_TOTAL_BYTES;

  for (const note of notes) {
    if (note.content === undefined) {
      reminded.push(note.name);
      continue;
    }
    const size = Buffer.byteLength(note.content, "utf-8");
    const limit = Math.min(PINNED_NOTE_MAX_BYTES, budget);
    if (limit < 512 && size > limit) {
      omitted.push(note.name);
      continue;
    }
    let body = note.content.replace(/\s+$/, "");
    let warning = "";
    if (size > limit) {
      body = truncateUtf8(body, limit);
      warning =
        `\n[nota "${note.name}" truncada: ${kb(limit)} de ${kb(size)}; ` +
        `leia o resto com \`sinapse note read ${note.name}\`]`;
    }
    budget -= Buffer.byteLength(body, "utf-8");
    blocks.push(`<nota nome="${note.name}">\n${body}\n</nota>${warning}`);
    delivered.push(note.name);
  }

  const parts: string[] = [];
  if (blocks.length > 0) {
    parts.push(
      "Notas fixadas neste worker pelo Sinapse (contexto do seu trabalho; esta é a versão atual de cada uma):\n\n" +
        blocks.join("\n\n")
    );
  }
  if (omitted.length > 0) {
    parts.push(
      `Notas fixadas que não couberam no limite de ${kb(PINNED_NOTES_TOTAL_BYTES)}: ${omitted.join(", ")}. ` +
        "Leia com `sinapse note read <nome>`."
    );
  }
  if (reminded.length > 0) {
    parts.push(
      `Notas fixadas neste worker, sem mudanças desde que você as recebeu nesta sessão: ${reminded.join(", ")}. ` +
        "Releia com `sinapse note read <nome>` se precisar."
    );
  }
  return { text: parts.length > 0 ? parts.join("\n\n") : undefined, delivered };
}

/** Prefixes the prompt with the non-empty preambles, separated by blank lines. */
export function withPreamble(prompt: string, preambles: Array<string | undefined>): string {
  const parts = preambles.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  if (parts.length === 0) return prompt;
  return `${parts.join("\n\n")}\n\n${prompt}`;
}
