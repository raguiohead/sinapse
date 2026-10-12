---
name: sinapse
description: Delegar trabalho para workers de outros provedores (AGY/Gemini, outros Claudes) pelo orquestrador Sinapse. Use quando a tarefa for operacional, pesada em tokens, paralelizável, ou quando uma segunda opinião de outro modelo ajudar (revisão cruzada). Requer a CLI `sinapse` no PATH.
---

# Sinapse — delegação para workers

Você é o **cérebro**. Os workers rodam turnos headless com sessão persistente; cada turno que você dispara aparece ao vivo no canvas do Sinapse.

## Regras

1. **Sempre comece com `sinapse list`.** Reaproveite um worker existente antes de criar outro; a sessão dele guarda o contexto dos turnos anteriores.
2. **Um turno por worker.** Se o worker estiver `thinking`, espere ou use outro.
3. **Nunca reenvie um prompt depois de timeout ou erro de conexão.** O turno pode ainda estar rodando: use `sinapse check <nome>`.
4. **Prompts autocontidos.** O worker não vê esta conversa. Diga o caminho dos arquivos, o que fazer, o que não tocar e o formato da resposta.
5. **Revise o que o worker entregou** antes de reportar ao usuário. Leia os arquivos alterados.

## Comandos

```bash
sinapse list
sinapse spawn <nome> --provider agy|claude --cwd <dir> --role "<papel>" [--autonomy read|edit|full]
sinapse ask <nome> "<prompt>"            # bloqueia e imprime a resposta
sinapse ask <nome> "<prompt>" --async    # devolve um turnId e segue
sinapse check <nome>                     # status e últimos eventos
sinapse stop <nome>                      # cancela o turno atual
```

- Autonomia padrão: `edit`. Use `read` para análise e revisão. `full` só quando o usuário pedir.
- O provider `agy` usa Gemini 3.8 Flash (High): bom para boilerplate, scaffolding, CSS, testes e tarefas mecânicas longas.
- Para trabalho em paralelo, dispare vários `ask --async` em workers diferentes e acompanhe com `check`.
