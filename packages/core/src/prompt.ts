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

/** Prefixes the prompt with the non-empty preambles, separated by blank lines. */
export function withPreamble(prompt: string, preambles: Array<string | undefined>): string {
  const parts = preambles.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  if (parts.length === 0) return prompt;
  return `${parts.join("\n\n")}\n\n${prompt}`;
}
