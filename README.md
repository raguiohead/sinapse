# Sinapse

Orquestrador pessoal de agentes: o Claude Code é o cérebro e delega turnos para workers de outros provedores, tudo visível ao vivo num canvas.

## Como funciona

São quatro peças. O app desktop abre o Claude Code interativo num terminal embutido: esse é o **cérebro**. Seguindo a skill `sinapse`, o cérebro usa a CLI `sinapse` para criar workers e delegar turnos. A CLI conversa por HTTP com o daemon `sinapsed`, que roda os workers como turnos headless com sessão persistente (um turno por vez em cada worker) e transmite tudo por Server-Sent Events (`agent_spawned`, `turn_started`, `turn_event`, `turn_finished`). O canvas escuta esses eventos, por isso qualquer delegação aparece ao vivo, mesmo as disparadas no terminal.

```text
┌──────────────────── app desktop (Electron) ────────────────────┐
│  terminal do cérebro (claude, via PTY)   cards dos workers     │
└──────────┬───────────────────────────────────────▲─────────────┘
           │ o cérebro roda a CLI                  │ SSE /events
           ▼                                       │
     CLI `sinapse` ──── HTTP + token ────▶  daemon `sinapsed`  (127.0.0.1)
                                                   │
                                     adapters headless, sessão persistente
                                  ┌───────────────────┼───────────────────┐
                                  ▼                   ▼                   ▼
                            worker Claude       worker Codex         worker AGY
                             (claude -p)      (codex exec --json)     (agy -p)
```

## Requisitos

| Dependência | Linux | Windows |
|---|---|---|
| Node.js e npm | Node.js 22+ e npm 10+ | Node.js 22+ e npm 10+ |
| Git | Git instalado | Git instalado |
| Claude Code CLI | `claude` instalado e autenticado | Instalador **NATIVO** (`claude.exe` no PATH, não pacote npm) |
| AGY CLI | `agy` instalado e autenticado | `agy.exe` no PATH |
| OpenAI Codex CLI (opcional, para workers `codex`) | `codex` instalado e autenticado no PATH | Executável `codex` no PATH |
| Compilador C++ (opcional) | `build-essential python3` | Visual Studio Build Tools (Desktop development with C++) |

> [!IMPORTANT]
> **Por que executáveis nativos no Windows?**
> O prompt de cada turno é passado ao CLI do worker (via argumento no `agy` ou `stdin` no `claude`/`codex`). Se a chamada passasse pelo `cmd.exe` (o que acontece com os atalhos `.cmd` que o npm instala), aspas e caracteres especiais quebrariam o comando ou seriam interpretados como comandos. Com os executáveis nativos no PATH, o Sinapse cria o processo diretamente, sem shell, e o Node faz o escape correto dos argumentos.
>
> O pacote `node-pty` normalmente já fornece binários pré-compilados. Se o ambiente exigir compilação de código nativo, as ferramentas de compilação acima serão necessárias.

## Instalação — Linux

1. Clone o repositório (privado):
   ```bash
   gh repo clone raguiohead/sinapse
   # ou
   git clone https://github.com/raguiohead/sinapse.git
   ```

2. Acesse a pasta do projeto e instale as dependências:
   ```bash
   cd sinapse
   npm install
   ```
   > [!NOTE]
   > Se o npm 11 exibir avisos bloqueando scripts de ciclo de vida e o Electron falhar ao iniciar, aprove as dependências necessárias:
   > ```bash
   > npm install-scripts approve electron esbuild node-pty
   > ```

3. Compile todos os pacotes:
   ```bash
   npm run build
   ```

4. Vincule a CLI globalmente ao ambiente:
   ```bash
   npm link -w @sinapse/cli
   ```

5. Inicie a aplicação desktop:
   ```bash
   npm start
   ```

### Configurações opcionais no Linux

- **Instalar atalho no sistema e área de trabalho:**
  ```bash
  ./scripts/install-shortcut.sh
  ```
  Instala o ícone SVG em `~/.local/share/icons/hicolor/scalable/apps/sinapse.svg`, cria a entrada `~/.local/share/applications/sinapse.desktop` apontando para o launcher `sinapse-desktop.sh`, atualiza o banco de dados do desktop e, se detectada área de trabalho, cria o atalho confiável.

- **Vincular o skill do Sinapse no Claude Code:**
  ```bash
  ./scripts/link-skill.sh
  ```
  Cria o link simbólico de `skill/sinapse` em `~/.claude/skills/sinapse`.

## Instalação — Windows (PowerShell)

> [!WARNING]
> **Suporte experimental:** o Sinapse foi desenvolvido e testado no Linux (Zorin OS 17, GNOME/Wayland). No Windows o código foi adaptado (PATH com delimitador de plataforma, encerramento de árvores de processos com `taskkill`, atalhos em PowerShell), mas ainda não foi executado. Relate problemas.

Execute no terminal PowerShell:

1. Permita a execução de scripts no escopo do usuário atual (caso bloqueado):
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```

2. Clone o repositório:
   ```powershell
   gh repo clone raguiohead/sinapse
   # ou
   git clone https://github.com/raguiohead/sinapse.git
   ```

3. Instale as dependências:
   ```powershell
   cd sinapse
   npm install
   ```
   Se o npm 11 emitir alerta de scripts:
   ```powershell
   npm install-scripts approve electron esbuild node-pty
   ```

4. Compile o monorepo:
   ```powershell
   npm run build
   ```

5. Vincule a CLI ao PATH:
   ```powershell
   npm link -w @sinapse/cli
   ```

6. Inicie o Sinapse:
   ```powershell
   npm start
   ```

### Configurações opcionais no Windows

- **Instalar atalhos no Menu Iniciar e Desktop:**
  ```powershell
  .\scripts\install-shortcut.ps1
  ```
  Cria atalhos `Sinapse.lnk` apontando para `sinapse-desktop.ps1` com execução silenciosa (`-WindowStyle Hidden`) e ícone `icon.ico`.

- **Vincular o skill do Sinapse no Claude Code:**
  ```powershell
  .\scripts\link-skill.ps1
  ```
  Cria a junção de diretório de `skill\sinapse` para `$env:USERPROFILE\.claude\skills\sinapse`.

## Uso

### Interface Visual (Canvas)

- **Terminal do Cérebro:** Painel interativo com o terminal do Claude Code embutido via `node-pty` e xterm.js. É nele onde você conversa com o cérebro do projeto.
- **Barra da janela:** o app desenha a própria barra, com o status do daemon, o número de workers pensando, o botão de configurações (⚙) e os controles da janela. Uma faixa cromática na base pode ficar animada, estática ou desligada. Arraste pela barra; duplo clique maximiza.
- **Menu de contexto:** clique com o botão direito no canvas para criar um worker ou uma nota e para abrir as configurações. O diálogo de novo worker já vem com os padrões definidos nas configurações (provedor, modelo, autonomia e pasta).
- **Configurações** (⚙ ou `Ctrl+,`): modelo do cérebro e uso de contexto; padrões de novos workers; status do daemon e atalhos para as pastas de dados, do cérebro e de notas; aparência (barra cromática, movimento reduzido e tamanho da fonte do terminal). Cada mudança é salva na hora.
- **Perguntar / Parar:** cada worker aceita prompts direto pelo card e permite interromper o turno em andamento.
- **Atividade estruturada:** o card mostra o prompt em destaque, a resposta em Markdown, cada ferramenta como bloco colapsável (comando ou arquivo no título; argumentos e resultado no corpo), o raciocínio (`thinking`) colapsado e os erros em vermelho. Guarda as últimas 300 entradas; o scroll acompanha o fim, a menos que você role para cima.
- **Autonomia e papel no card:** o seletor `read/edit/full` ao lado do modelo e o clique no papel (Enter salva, Shift+Enter quebra linha, Esc cancela) equivalem ao `PATCH` do daemon; ficam bloqueados enquanto o worker pensa.
- **Ver diff:** o botão "Ver diff" abre um modal com `git status` e `git diff HEAD` do diretório do worker (arquivos não rastreados só listados; limite de 200 KB). Fora de um repositório git, o modal mostra o erro.
- **Excluir worker:** pela lixeira no card ou com clique direito no card. Pede confirmação; um turno em andamento é interrompido e tudo o que o worker abriu é encerrado.
- **Redimensionar:** arraste a alça no canto inferior direito de qualquer card. O terminal do cérebro se reajusta ao novo tamanho.
- **Notas:** "Editar" ou duplo clique abre um editor fora do canvas, em tamanho normal; `Ctrl+S` salva e Esc cancela.
- **Arestas:** partículas vão do cérebro ao worker quando um turno começa e voltam na cor do provedor quando ele termina.
- Workers criados pelo cérebro no terminal entram no canvas sozinhos, e a câmera se reajusta.

### Workspaces

Cada workspace é um projeto (uma pasta que você escolhe), com o próprio orquestrador, workers e notas.

- **Seletor** (canto superior direito): lista os workspaces, troca entre eles, cria um novo ("＋ Novo workspace": nome, pasta, orquestrador e modelo) e apaga existentes (🗑).
- **Orquestrador por workspace:** Claude Code ou AGY, com o modelo que você quiser; dá para trocar na seção "Orquestrador" das configurações. Mudar só o modelo retoma a conversa; mudar de provedor começa uma nova.
- **Seu projeto fica intocado:** o orquestrador roda numa pasta do Sinapse (`~/.sinapse/workspaces/<id>/orquestrador`) e acessa o projeto via `--add-dir`. Nada é criado dentro do repositório do projeto. Na primeira vez, o Claude Code ou o AGY pede confiança nessa pasta.
- **Em segundo plano:** ao trocar de workspace, o anterior continua rodando (orquestrador e turnos dos workers); ao voltar, os cards mostram o que aconteceu nesse meio-tempo.
- **Apagar:** interrompe e remove os workers do workspace, encerra o orquestrador e apaga as notas e a sessão dele. A pasta do projeto não é tocada. O último workspace não pode ser apagado.
- **Atualização de versões anteriores:** os workers e notas que existiam antes viram o workspace "Geral" (pasta: sua pasta pessoal) na primeira abertura.

### Autoria

Notas e workers ficam ligados a quem os criou:

- O orquestrador e cada worker rodam com uma identidade (`SINAPSE_AGENT_ID`), que a CLI envia ao daemon.
- **Nota:** aresta do autor até a nota, e uma aresta mais tênue de cada agente que escreveu nela depois. A aresta pulsa quando o agente escreve. Notas criadas por você, ou fora do Sinapse, ficam sem aresta.
- **Worker criado por outro worker:** aresta tracejada do criador, além da ligação de delegação com o orquestrador.

### Comandos da CLI

A CLI `sinapse` gerencia os workers e se comunica com o daemon `sinapsed`. Os comandos atuam num workspace, escolhido nesta ordem: `--workspace <nome|id>`, a variável `SINAPSE_WORKSPACE` (o orquestrador e os workers já a recebem), o workspace cuja pasta contém o diretório atual e, por fim, "geral".

| Comando | Descrição |
|---|---|
| `sinapse workspaces` | Lista os workspaces, com pasta, orquestrador e número de workers. |
| `sinapse workspace create <nome> --folder <dir> [--orchestrator claude\|agy] [--model <m>]` | Cria um workspace. |
| `sinapse workspace rm <nome\|id>` | Apaga um workspace (a pasta do projeto não é tocada). |
| `sinapse list` | Lista todos os workers cadastrados, provedor, modelo, uso de contexto, status, autonomia e diretório de trabalho. |
| `sinapse spawn <nome> --provider <p> [--cwd <dir>] --role "<r>" [--autonomy edit] [--model <m>]` | Cria um novo worker (`--provider claude\|codex\|agy`, `--role`, `--autonomy read\|edit\|full`, `--model <m>`). Sem `--cwd`, ele roda na pasta do projeto. |
| `sinapse spawn <nome> ... --worktree` | Isola o worker numa git worktree própria (veja [Isolamento por git worktree](#isolamento-por-git-worktree)). |
| `sinapse squad list` | Lista os presets de squad (embutidos e de `~/.sinapse/squads.json`). |
| `sinapse squad apply <preset> [--prefix <p>] [--worktree]` | Cria os workers do preset, nomeados `<prefix>-<membro>` (prefixo padrão: nome do preset). Workers que já existem são pulados com aviso. |
| `sinapse ask <nome> "<prompt>"` | Envia prompt ao worker de modo síncrono, exibindo a saída em tempo real no terminal. |
| `sinapse ask <nome> "<prompt>" --async` | Envia prompt de modo assíncrono, retornando imediatamente o `turnId` gerado. |
| `sinapse ask <nome> "<prompt>" --queue` | Como `--async`, mas se o worker estiver ocupado o prompt entra numa fila (em memória) e roda quando o turno atual terminar. Sem `--queue`, um worker ocupado recusa o prompt. |
| `sinapse wait <n1> [n2 ...] [--any] [--timeout <seg>]` | Bloqueia até todos os workers (ou o primeiro, com `--any`) terminarem o turno e a fila. Imprime, para cada um, o status, o contexto e o texto completo da última resposta. Sai com código 2 em timeout e 1 se algum worker terminou em erro. |
| `sinapse check <nome> [--full]` | Consulta o status atual do worker, modelo, contexto, ID do turno em execução, tamanho da fila e últimos eventos registrados. Com `--full`, imprime o texto completo da última resposta no lugar dos eventos. |
| `sinapse stop <nome>` | Interrompe o turno em execução e descarta os prompts da fila (a saída informa quantos). |
| `sinapse handoff <nome> [--note <nota>]` | Pede ao worker um resumo estruturado (objetivo, estado, decisões, arquivos, pendências), salva na nota `handoff-<nome>` (ou `--note`), zera a sessão e mantém nome, papel, modelo, autonomia e pasta. O próximo turno começa lendo a nota. |
| `sinapse rm <nome> [--force]` | Remove o worker. Um turno em andamento é interrompido antes, e a sessão do worker deixa de ser usada. Se ele tinha worktree, ela e a branch só são apagadas quando estão limpas e sem commits novos; senão ficam mantidas e o caminho é avisado. `--force` apaga mesmo assim. |
| `sinapse models [claude\|codex\|agy]` | Lista o catálogo de modelos disponíveis para os provedores Claude, Codex e AGY. |
| `sinapse model <nome> <modelo\|padrao>` | Altera o modelo de um worker existente (`padrao` limpa e volta ao padrão do provedor). |
| `sinapse note list` | Lista resumos de todas as notas salvas ordenadas por data de modificação. |
| `sinapse note read <nome>` | Exibe o conteúdo bruto da nota especificada. |
| `sinapse note write <nome> "<texto>"` | Cria ou sobrescreve uma nota. Use `-` no lugar do texto para ler do stdin. |
| `sinapse note append <nome> "<texto>"` | Acrescenta ao final da nota (cria se não existir). Use `-` para ler do stdin. |
| `sinapse note rm <nome>` | Remove permanentemente uma nota. |
| `sinapse start` | Inicia o daemon `sinapsed` em primeiro plano (ou conecta se já estiver ativo). |

### Isolamento por git worktree

`sinapse spawn <nome> --provider claude --worktree` (ou a caixa "Isolar em git worktree" no diálogo de novo worker) faz o daemon rodar `git worktree add -b sinapse/<nome>` em `~/.sinapse/workspaces/<id>/worktrees/<nome>` e usar essa pasta como diretório de trabalho do worker. Assim vários workers com `edit` não pisam nos mesmos arquivos.

- A pasta do workspace (ou `--cwd`) precisa estar num repositório git com ao menos um commit; se não estiver, ou se a branch `sinapse/<nome>` já existir, o spawn falha com mensagem clara.
- A worktree é um checkout limpo do `HEAD`: **`node_modules`, artefatos de build e arquivos ignorados pelo git não existem nela** (rode `npm install` etc. dentro dela, se precisar). Alterações não commitadas da pasta original também não vão junto.
- O Sinapse nunca faz merge sozinho: integre a branch `sinapse/<nome>` manualmente.
- `sinapse rm` remove worktree e branch apenas se a worktree está limpa e a branch não tem commits novos. Caso contrário o worker é removido, a worktree/branch são mantidas e o aviso mostra o caminho. `sinapse rm <nome> --force` apaga tudo, inclusive trabalho não commitado.
- No canvas, o card do worker mostra a branch num selo discreto.

### Presets de squad

Um squad é um conjunto de workers criado de uma vez. Presets embutidos:

| Preset | Membros |
|---|---|
| `review` | `arquiteto` (read) + `revisor` (read) |
| `tdd` | `implementador` (edit) + `testador` (edit) |
| `bug-hunt` | `investigador` (read) + `corretor` (edit) |

`sinapse squad apply review --prefix pr42` cria `pr42-arquiteto` e `pr42-revisor`; com `--worktree`, cada um ganha sua worktree. No canvas, clique com o botão direito no fundo e escolha "Aplicar squad ▸ <preset>" (sem worktree).

Presets próprios ficam em `~/.sinapse/squads.json` (um array, ou `{ "presets": [...] }`); um preset com o nome de um embutido o sobrescreve. Entradas inválidas são ignoradas, com aviso em `sinapse squad list`.

```json
[
  {
    "name": "docs",
    "description": "Redator e revisor de documentação",
    "members": [
      { "name": "redator", "provider": "claude", "model": "sonnet", "autonomy": "edit", "role": "Escreve a documentação." },
      { "name": "revisor", "provider": "agy", "autonomy": "read", "role": "Revisa o texto." }
    ]
  }
]
```

### Modelos e janela de contexto

Tanto no canvas quanto na CLI, é possível selecionar e alternar os modelos dos workers:
- **Seleção no Canvas e na CLI:** utilize `--model <modelo>` no `sinapse spawn` ou consulte os modelos disponíveis via `sinapse models [claude|codex|agy]`. Para alterar o modelo de um worker existente, utilize `sinapse model <nome> <modelo>` (ou `sinapse model <nome> padrao` para remover o modelo customizado). No canvas, o modelo pode ser escolhido na criação e modificado no card do worker.
- **Orquestrador:** a seção "Orquestrador" das configurações troca o agente e o modelo do workspace ativo (veja Workspaces).
- **Janela de contexto:**
  - O **Claude** reporta o tamanho real de sua janela de contexto diretamente pela CLI (`contextWindow`).
  - O **Codex**, o **AGY** e o **orquestrador** exibem a janela reportada pela CLI (quando disponível) ou uma estimativa marcada com o prefixo `≈` (ex: `≈21k/1m 2%`).
  - O uso de contexto do **orquestrador** (Claude Code ou AGY) é lido a partir do transcript da sessão ativa (`~/.claude/projects/` para Claude e `~/.gemini/antigravity-cli/brain/` para AGY).
- **Handoff:** quando um worker passa de 80% da janela, o card mostra um botão "Handoff" (o mesmo que `sinapse handoff <nome>`). O resumo vira a nota `handoff-<nome>`, a sessão recomeça do zero e o primeiro turno seguinte é instruído a ler essa nota.

### Papel do worker

O `--role` do `spawn` chega ao modelo em todo turno: no Claude como `--append-system-prompt` ("Seu papel neste time: …"); no AGY, que não tem essa opção, como prefixo do primeiro prompt da sessão.

### Notas

As notas representam a memória compartilhada entre o usuário, o cérebro e os workers:
- **Onde vivem:** arquivos Markdown em `~/.sinapse/workspaces/<id>/notes/<nome>.md`, um conjunto por workspace (com `$SINAPSE_HOME`, dentro dessa pasta). Nomes devem ser minúsculos com hífens ou sublinhados (`^[a-z0-9][a-z0-9_-]{0,63}$`).
- **CLI:** gerenciadas pelos subcomandos `sinapse note list`, `sinapse note read <nome>`, `sinapse note write <nome> "<texto>"|-`, `sinapse note append <nome> "<texto>"|-` e `sinapse note rm <nome>`. Em `write` e `append`, o texto é obrigatório; use `-` para ler do stdin (útil para várias linhas: `sinapse note write plano - <<'EOF'`).
- **Comportamento no Canvas:**
  - Apresentadas como cards com visualização e edição direta.
  - Recebem atualizações ao vivo via eventos do daemon (`note_changed` e `note_deleted`).
  - Renderizadas em Markdown limpo, sem execução de HTML bruto.

### Ciclo de vida

- **Uma instância por pasta de dados:** abrir o atalho de novo só traz a janela existente para a frente.
- **Daemon compartilhado:** se a CLI já tiver iniciado um daemon (por exemplo, você rodou `sinapse list` com o app fechado), o app passa a usar esse daemon em vez de subir outro. Com o app fechado, a CLI inicia o próprio daemon quando precisa.
- **Ao fechar o app:** turnos em andamento são interrompidos (status `interrupted`, a sessão do worker é preservada), e o cérebro, os workers e tudo o que eles abriram (comandos de terminal, servidores MCP) são encerrados. Isso vale também para encerramento por sinal (logout, `kill`).

### Níveis de Autonomia

O parâmetro `--autonomy` ajusta as permissões passadas aos executáveis dos adapters:

| Nível | Flag Claude (`claude`) | Flag Codex (`codex`) | Flag AGY (`agy`) | Comportamento |
|---|---|---|---|---|
| `read` | `--permission-mode plan` | `--sandbox read-only` | `--mode plan` | Modo somente leitura/planejamento. Não altera arquivos. |
| `edit` *(padrão)* | `--permission-mode acceptEdits` | `--sandbox workspace-write` | `--mode accept-edits` | Permite criação e edição de arquivos do projeto sem confirmações repetitivas. |
| `full` | *(sem restrições)* | `--dangerously-bypass-approvals-and-sandbox` | *(sem restrições)* | Execução total irrestrita (usar apenas sob pedido explícito). |

### Exemplo de Delegação pelo Cérebro

Quando o Claude Code atua como cérebro usando o skill do Sinapse:

1. O cérebro consulta se já existe um worker disponível:
   ```bash
   sinapse list
   ```
2. Se necessário, cria um worker AGY para implementar testes unitários:
   ```bash
   sinapse spawn tester --provider agy --cwd ~/projetos/meu-app --role "Engenheiro de Testes" --autonomy edit
   ```
3. O cérebro despacha um turno assíncrono:
   ```bash
   sinapse ask tester "Implemente a suíte de testes unitários para os adapters em packages/core" --async
   ```
4. O cérebro continua trabalhando em outra tarefa e, quando precisa do resultado, espera o worker (sem polling) e recebe a resposta completa:
   ```bash
   sinapse wait tester --timeout 900
   ```

## Onde ficam os dados

Todos os dados de runtime do Sinapse ficam armazenados no diretório do usuário:

- `~/.sinapse/state.json`: workspaces e agentes (id, workspace, nome, provedor, pasta, status, sessão, modelo, uso de contexto, quem criou).
- `~/.sinapse/daemon.json`: Informações do daemon em execução (`port`, `token`, `pid`).
- `~/.sinapse/workspaces/<id>/notes/`: notas do workspace (`<nome>.md`) e `.meta.json` com a autoria.
- `~/.sinapse/workspaces/<id>/worktrees/<nome>/`: git worktrees dos workers criados com `--worktree`.
- `~/.sinapse/squads.json`: presets de squad do usuário (opcional).
- `~/.sinapse/workspaces/<id>/orquestrador/`: pasta onde o orquestrador roda, com o guia (`CLAUDE.md` ou `AGENTS.md`) e, para o AGY, a skill em `.agent/skills/sinapse`.
- `~/.sinapse/desktop.json`: configurações do app (workspace ativo, padrões de novos workers e aparência).
- `~/.sinapse/desktop.log`: Log de saída do processo de build e inicialização do Electron Desktop.

> [!NOTE]
> **Segurança:** o daemon escuta só em `127.0.0.1`, e todas as rotas exceto `/health` exigem `Authorization: Bearer <token>`. O token é gerado na primeira execução e reaproveitado depois; ele fica em `state.json` e `daemon.json`, gravados com permissão `0600` (só o seu usuário lê; no Windows, a pasta do perfil já é restrita ao usuário). Para trocar o token, apague `~/.sinapse/state.json` com o daemon parado. Lembre que um worker com autonomia `edit` ou `full` pode alterar arquivos na pasta em que roda.

## Estrutura do repositório

```text
sinapse/
├── apps/
│   └── desktop/               # Aplicação Electron 35 + React + @xyflow/react
│       ├── build/             # Ícones (icon.svg, icon.png, icon.ico)
│       └── src/               # Processo principal (main), preload e renderer
├── packages/
│   ├── core/                  # Daemon Fastify, adapters (claude, codex, agy), gerenciamento de processos
│   └── cli/                   # CLI sinapse executável
├── scripts/                   # Scripts de inicialização e instalação de atalhos (Linux / Windows)
│   ├── install-shortcut.sh    # Instalação de atalho e ícone (.desktop) no Linux
│   ├── install-shortcut.ps1   # Instalação de atalho (.lnk) no Windows
│   ├── link-skill.sh          # Link simbólico do skill no Linux
│   ├── link-skill.ps1         # Junção de diretório do skill no Windows
│   ├── sinapse-desktop.sh     # Launcher de inicialização desktop no Linux
│   └── sinapse-desktop.ps1    # Launcher de inicialização desktop no Windows
├── skill/
│   └── sinapse/               # Definição do skill do Claude Code (SKILL.md)
└── package.json               # Configuração do monorepo npm workspaces
```

## Limitações conhecidas

- **Versão do Electron:** o projeto fixa o Electron 35. A partir do 36 (GTK4), o app fecha ao iniciar em sistemas Linux que também carregam GTK3, com o erro "GTK 2/3 symbols detected".
- **Persistência de logs:** O histórico detalhado de eventos de turnos de workers é mantido em memória e não é persistido após o encerramento do daemon.
- **Fila em memória:** prompts enfileirados com `--queue` se perdem se o daemon reiniciar. `wait` e `check --full` mostram só a resposta do último turno; numa fila com vários prompts, as respostas anteriores ficam apenas no canvas.
- **Confiança por workspace:** cada orquestrador roda na sua própria pasta, então o Claude Code ou o AGY pede confiança uma vez por workspace novo.
- **Orquestrador AGY:** ao abrir, o AGY às vezes mostra um aviso de novidades que precisa ser fechado com Esc antes de digitar.
- **Pasta antiga `~/.sinapse/cerebro`:** depois da atualização para workspaces, ela não é mais usada (o orquestrador do Geral começa numa sessão nova). Pode ser apagada.
- **Janela de contexto estimada:** quando o CLI não informa o limite (AGY e cérebro), o Sinapse estima pelo nome do modelo; a família Claude 5.x é tratada como 1M.
- **Processos que se desligam do pai:** alguns servidores MCP se separam do processo que os iniciou. No Linux o Sinapse os encontra por uma marca no ambiente e os encerra; no Windows depende do `taskkill /T`, que não alcança processos já desligados da árvore.
- **Ambiente Windows não executado em homologação:** Os scripts e caminhos foram preparados para Windows 10/11, mas o desenvolvimento inicial foi conduzido no Linux.

## Solução de problemas

- **"Failed to load native module: pty.node"**  
  Execute `npm install` novamente na raiz do projeto para recompilar o módulo nativo ou certifique-se de que as ferramentas de compilação da sua plataforma estejam instaladas (`build-essential python3` no Linux ou Visual Studio Build Tools no Windows).

- **"GTK 2/3 symbols detected"**  
  Mantenha o Electron fixado na versão 35. Não atualize para Electron 36+.

- **Janela não abre a partir do atalho de inicialização**  
  Verifique o log de execução em `~/.sinapse/desktop.log` no Linux ou `%USERPROFILE%\.sinapse\desktop.log` no Windows para verificar erros de build do `electron-vite`.

- **`sinapse: command not found`**  
  Vincule o pacote da CLI ao seu ambiente global do npm executando `npm link -w @sinapse/cli` na raiz do repositório, garantindo que o diretório de binários globais do npm esteja presente no PATH do sistema.
