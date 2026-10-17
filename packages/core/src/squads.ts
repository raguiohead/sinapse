import fs from "node:fs/promises";
import path from "node:path";
import { sinapseDir } from "./paths.js";
import type { SquadCatalog, SquadMember, SquadPreset } from "./types.js";

const MEMBER_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const MODEL_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$/;

export const BUILTIN_SQUADS: SquadPreset[] = [
  {
    name: "review",
    description: "Arquiteto e revisor, ambos somente leitura",
    source: "embutido",
    members: [
      {
        name: "arquiteto",
        provider: "claude",
        autonomy: "read",
        role: "Arquiteto: analisa a estrutura e as decisões de design do código, aponta acoplamento, riscos e alternativas. Não edita arquivos.",
      },
      {
        name: "revisor",
        provider: "claude",
        autonomy: "read",
        role: "Revisor: lê as mudanças com olhar crítico em busca de bugs, casos de borda e falta de testes. Não edita arquivos.",
      },
    ],
  },
  {
    name: "tdd",
    description: "Implementador e testador, ambos com permissão de edição",
    source: "embutido",
    members: [
      {
        name: "implementador",
        provider: "claude",
        autonomy: "edit",
        role: "Implementador: escreve o código mínimo para fazer os testes passarem, sem alterar os testes.",
      },
      {
        name: "testador",
        provider: "claude",
        autonomy: "edit",
        role: "Testador: escreve testes que descrevem o comportamento esperado antes da implementação e cobre casos de borda.",
      },
    ],
  },
  {
    name: "bug-hunt",
    description: "Investigador somente leitura e corretor com permissão de edição",
    source: "embutido",
    members: [
      {
        name: "investigador",
        provider: "claude",
        autonomy: "read",
        role: "Investigador: reproduz o bug, rastreia a causa raiz e descreve a correção proposta. Não edita arquivos.",
      },
      {
        name: "corretor",
        provider: "claude",
        autonomy: "edit",
        role: "Corretor: aplica a menor correção possível para a causa raiz apontada e confirma que o problema sumiu.",
      },
    ],
  },
];

function parseMember(raw: unknown): SquadMember | string {
  if (!raw || typeof raw !== "object") return "membro inválido";
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== "string" || !MEMBER_NAME_REGEX.test(m.name)) return "membro sem name válido";
  if (m.provider !== "claude" && m.provider !== "agy") return `membro "${m.name}": provider deve ser claude ou agy`;
  if (m.autonomy !== "read" && m.autonomy !== "edit" && m.autonomy !== "full") {
    return `membro "${m.name}": autonomy deve ser read, edit ou full`;
  }
  if (typeof m.role !== "string" || !m.role.trim()) return `membro "${m.name}": role é obrigatório`;
  if (m.model !== undefined && m.model !== null && m.model !== "") {
    if (typeof m.model !== "string" || !MODEL_REGEX.test(m.model)) return `membro "${m.name}": model inválido`;
  }
  return {
    name: m.name,
    provider: m.provider,
    autonomy: m.autonomy,
    role: m.role.trim(),
    ...(typeof m.model === "string" && m.model ? { model: m.model } : {}),
  };
}

function parsePreset(raw: unknown): SquadPreset | string {
  if (!raw || typeof raw !== "object") return "preset inválido";
  const p = raw as Record<string, unknown>;
  if (typeof p.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(p.name)) {
    return "preset sem name válido";
  }
  if (!Array.isArray(p.members) || p.members.length === 0) return `preset "${p.name}": members vazio`;
  const members: SquadMember[] = [];
  const seen = new Set<string>();
  for (const rawMember of p.members) {
    const member = parseMember(rawMember);
    if (typeof member === "string") return `preset "${p.name}": ${member}`;
    if (seen.has(member.name)) return `preset "${p.name}": membro "${member.name}" repetido`;
    seen.add(member.name);
    members.push(member);
  }
  return {
    name: p.name,
    members,
    source: "usuario",
    ...(typeof p.description === "string" && p.description ? { description: p.description } : {}),
  };
}

/** Built-in presets overlaid with `<sinapse dir>/squads.json` (array of presets, or `{ "presets": [...] }`); the user's wins on equal names. */
export async function loadSquadCatalog(): Promise<SquadCatalog> {
  const warnings: string[] = [];
  const byName = new Map<string, SquadPreset>();
  for (const preset of BUILTIN_SQUADS) byName.set(preset.name, preset);

  const file = path.join(sinapseDir(), "squads.json");
  let content: string | undefined;
  try {
    content = await fs.readFile(file, "utf-8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") warnings.push(`não foi possível ler ${file}: ${err?.message ?? err}`);
  }

  if (content !== undefined) {
    try {
      const data = JSON.parse(content);
      const list: unknown = Array.isArray(data) ? data : data?.presets;
      if (!Array.isArray(list)) {
        warnings.push(`${file}: esperado um array de presets ou { "presets": [...] }`);
      } else {
        for (const raw of list) {
          const preset = parsePreset(raw);
          if (typeof preset === "string") warnings.push(`${file}: ${preset}`);
          else byName.set(preset.name, preset);
        }
      }
    } catch (err: any) {
      warnings.push(`${file}: JSON inválido (${err?.message ?? err})`);
    }
  }

  return { presets: [...byName.values()], warnings };
}
