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
sinapse spawn <nome> --provider agy|claude --cwd <dir> --role "<papel>" [--autonomy read|edit|full] [--model <modelo>]
sinapse ask <nome> "<prompt>"            # bloqueia e imprime a resposta
sinapse ask <nome> "<prompt>" --async    # devolve um turnId e segue
sinapse check <nome>                     # status e últimos eventos
sinapse stop <nome>                      # cancela o turno atual
sinapse models [claude|agy]              # lista modelos disponíveis
sinapse model <nome> <modelo|padrao>     # altera o modelo do worker (padrao limpa)
sinapse note list                        # lista notas
sinapse note read <nome>                 # lê o conteúdo bruto da nota
sinapse note write <nome> "<texto>"|-        # cria/sobrescreve; "-" lê do stdin
sinapse note append <nome> "<texto>"|-       # adiciona ao fim; "-" lê do stdin
sinapse note rm <nome>                   # remove nota
```

- Autonomia padrão: `edit`. Use `read` para análise e revisão. `full` só quando o usuário pedir.
- Para trabalho em paralelo, dispare vários `ask --async` em workers diferentes e acompanhe com `check`.

## Modelos

- Use `--model <modelo>` no `sinapse spawn` ou consulte os disponíveis com `sinapse models agy` (ou `claude`).
- Para alterar o modelo de um worker existente, use `sinapse model <nome> <modelo>` (ou `padrao` para restaurar o padrão do provedor).
- **Diretrizes de seleção**: use `gemini-3.8-flash-*` para trabalho mecânico, boilerplate, scaffolding, CSS, testes e tarefas volumosas; use Claude Opus/Sonnet (via provider `claude`) para raciocínio refinado e tarefas com alto peso de julgamento.
- O comando `sinapse list` exibe o uso de contexto de cada worker (ex: `38k/200k 19%` ou com `≈` quando estimado).
- **Handoff aos ~80%**: quando o contexto do worker passar de ~80% da sua janela, escreva uma nota de handoff (`sinapse note write <nome-handoff>`) e crie um novo worker zerado em vez de continuar inflando a sessão antiga.

## Notas

- Comandos: `sinapse note list`, `sinapse note read <nome>`, `sinapse note write <nome> "<texto>"|-`, `sinapse note append <nome> "<texto>"|-`, `sinapse note rm <nome>`.
- Notas são a **memória compartilhada** entre o usuário, o cérebro e os workers. O usuário as visualiza ao vivo no canvas.
- Use notas para planos de ataque, handoffs entre workers e consolidação de resultados.
- Nomes de notas devem seguir o padrão minúsculo com hífens (`lowercase-with-hyphens`, ex: `plano-migracao`, `handoff-refactor`).
- **Instrução aos workers**: em vez de colar blocos extensos de contexto diretamente nos prompts, oriente os workers a ler a nota relevante (`sinapse note read <nome>`).
