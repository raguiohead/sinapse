# Sinapse

Orquestrador de agentes de IA para desenvolvedores que usam Claude Code como ponto central de comando e querem delegar subtarefas para workers de outros provedores (Claude, OpenAI Codex, AGY/Gemini), tudo visível em tempo real num canvas interativo.

> **Status:** versão 0.1.0 — funcional no Linux; suporte a Windows experimental (ainda não executado em homologação).

## Por que existe

Modelos de linguagem têm pontos fortes diferentes. O Sinapse parte de uma ideia simples: usar o Claude Code como "cérebro" coordenador e delegar partes do trabalho — testes, refatoração, revisão — para workers especializados em outros provedores, sem abrir janelas separadas nem fazer polling manual. Cada delegação aparece ao vivo no canvas e pode ser acompanhada ou interrompida a qualquer momento.

## Principais recursos

- **Canvas interativo** — cards dos workers com saída estruturada (texto, ferramentas colapsáveis, raciocínio, erros em vermelho) e arestas animadas que mostram quando um turno começa e termina.
- **Multi-provedor** — workers Claude (`claude`), OpenAI Codex (`codex`) e AGY/Gemini (`agy`) gerenciados pela mesma CLI.
- **Sessões persistentes** — cada worker mantém o contexto entre turnos; `sinapse handoff` resume a sessão quando a janela de contexto estiver perto do limite.
- **Workspaces** — projetos independentes, cada um com seu próprio orquestrador, workers e notas. Trocar de workspace não interrompe o trabalho em andamento.
- **Notas compartilhadas** — memória Markdown acessível pelo orquestrador, pelos workers e pelo canvas em tempo real.
- **Isolamento por git worktree** — `sinapse spawn --worktree` cria uma branch e worktree isoladas para que workers com `edit` não pisem uns nos outros.
- **Squads** — presets que criam vários workers de uma vez (`review`, `tdd`, `bug-hunt` ou presets personalizados em `~/.sinapse/squads.json`).
- **Sem polling** — `sinapse wait` bloqueia até o worker terminar e já imprime a resposta completa; a CLI usa Server-Sent Events internamente.

## Como funciona

São quatro peças. O app desktop abre o Claude Code num terminal embutido — esse é o **cérebro**. Seguindo a skill `sinapse`, o cérebro usa a CLI `sinapse` para criar workers e delegar turnos. A CLI se comunica por HTTP com o daemon `sinapsed`, que roda os workers como processos headless com sessão persistente e transmite tudo por Server-Sent Events. O canvas escuta esses eventos, então qualquer delegação disparada no terminal aparece ao vivo.

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
| Claude Code CLI | `claude` instalado e autenticado | Executável nativo `claude.exe` no PATH (não o pacote npm) |
| AGY CLI | `agy` instalado e autenticado | `agy.exe` no PATH |
| OpenAI Codex CLI (opcional) | `codex` no PATH e autenticado | `codex` no PATH e autenticado |
| Compilador C++ (opcional, para compilar `node-pty`) | `build-essential python3` | Visual Studio Build Tools (Desktop development with C++) |

> **Por que executáveis nativos no Windows?**
> O Sinapse cria os processos dos workers diretamente, sem passar por um shell intermediário. Se a chamada passasse pelo `cmd.exe` (o que acontece com os atalhos `.cmd` que o npm instala), aspas e caracteres especiais do prompt seriam interpretados ou quebrados. Com os executáveis nativos no PATH, o Node faz o escape correto dos argumentos.
>
> O pacote `node-pty` normalmente já vem com binários pré-compilados. As ferramentas de compilação acima só são necessárias se o ambiente exigir recompilar o módulo nativo.

## Instalação e primeiro uso

### Linux

```bash
# 1. Clone o repositório
git clone https://github.com/raguiohead/sinapse.git
cd sinapse

# 2. Instale as dependências
npm install
# Se o npm emitir aviso bloqueando scripts de ciclo de vida:
# npm install-scripts approve electron esbuild node-pty

# 3. Compile o monorepo
npm run build

# 4. Vincule a CLI globalmente
npm link -w @sinapse/cli

# 5. Inicie o app
npm start
```

#### Configurações opcionais (Linux)

```bash
# Instalar ícone e atalho de área de trabalho
./scripts/install-shortcut.sh

# Vincular o skill do Sinapse no Claude Code
./scripts/link-skill.sh
```

O `install-shortcut.sh` instala o ícone SVG em `~/.local/share/icons/`, cria uma entrada `.desktop` e, se houver área de trabalho detectada, cria o atalho confiável.

O `link-skill.sh` cria o link simbólico de `skill/sinapse` em `~/.claude/skills/sinapse`, habilitando o skill `sinapse` no Claude Code.

### Windows (PowerShell)

> **Suporte experimental:** os scripts e caminhos foram preparados para Windows 10/11, mas o desenvolvimento foi conduzido no Linux. Relate problemas se encontrar.

```powershell
# 1. Permita execução de scripts (se necessário)
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

# 2. Clone o repositório
git clone https://github.com/raguiohead/sinapse.git
cd sinapse

# 3. Instale as dependências
npm install
# Se o npm emitir aviso de scripts:
# npm install-scripts approve electron esbuild node-pty

# 4. Compile o monorepo
npm run build

# 5. Vincule a CLI ao PATH
npm link -w @sinapse/cli

# 6. Inicie o app
npm start
```

#### Configurações opcionais (Windows)

```powershell
# Instalar atalhos no Menu Iniciar e Desktop
.\scripts\install-shortcut.ps1

# Vincular o skill do Sinapse no Claude Code
.\scripts\link-skill.ps1
```

## Exemplo de uso

Depois de abrir o app e ter o terminal do cérebro ativo, o Claude Code (com o skill `sinapse` vinculado) pode delegar assim:

```bash
# 1. Ver workers disponíveis
sinapse list

# 2. Criar um worker AGY para escrever testes
sinapse spawn testador --provider agy --role "Engenheiro de Testes" --autonomy edit

# 3. Enviar uma tarefa de forma assíncrona
sinapse ask testador "Implemente testes unitários para os adapters em packages/core" --async

# 4. Continuar trabalhando; quando precisar do resultado:
sinapse wait testador --timeout 900
```

Cada turno disparado pelo terminal aparece em tempo real no canvas, como um card com a saída estruturada do worker.

## Uso detalhado

### Interface visual (canvas)

- **Terminal do cérebro:** painel interativo com o Claude Code embutido via PTY e xterm.js.
- **Barra da janela:** desenhada pelo app, com status do daemon, número de workers ativos, botão de configurações (⚙) e controles da janela. Arraste para mover; duplo clique maximiza.
- **Menu de contexto:** clique com o botão direito no canvas para criar worker, nota ou abrir configurações.
- **Configurações** (⚙ ou `Ctrl+,`): modelo do cérebro, padrões de novos workers, status do daemon, aparência (barra cromática, movimento reduzido, tamanho da fonte).
- **Atividade estruturada:** o card mostra prompt, resposta em Markdown, ferramentas colapsáveis, raciocínio (`thinking`) e erros em vermelho. Guarda as últimas 300 entradas.
- **Ver diff:** botão no card abre modal com `git status` e `git diff HEAD` do diretório do worker.
- **Redimensionar:** arraste a alça no canto inferior direito de qualquer card.
- **Notas:** cards Markdown editáveis diretamente no canvas, com atualização ao vivo via eventos do daemon.

### Workspaces

Cada workspace é um projeto (pasta escolhida pelo usuário), com seu próprio orquestrador, workers e notas.

- **Orquestrador por workspace:** Claude Code ou AGY, com o modelo desejado. Mudar só o modelo retoma a conversa; mudar de provedor inicia uma nova sessão.
- **Projeto intocado:** o orquestrador roda em `~/.sinapse/workspaces/<id>/orquestrador/` e acessa o projeto via `--add-dir`. Nada é criado dentro do repositório do projeto.
- **Em segundo plano:** ao trocar de workspace, o anterior continua rodando; ao voltar, os cards mostram o que aconteceu.

### Comandos da CLI

A CLI `sinapse` resolve o workspace nesta ordem: `--workspace <nome|id>`, a variável `SINAPSE_WORKSPACE`, o workspace cuja pasta contém o diretório atual e, por fim, "geral".

| Comando | Descrição |
|---|---|
| `sinapse workspaces` | Lista os workspaces com pasta, orquestrador e número de workers. |
| `sinapse workspace create <nome> --folder <dir> [--orchestrator claude\|agy] [--model <m>]` | Cria um workspace. |
| `sinapse workspace rm <nome\|id>` | Apaga um workspace (pasta do projeto não é tocada). |
| `sinapse list` | Lista todos os workers: provedor, modelo, contexto, status, autonomia, notas fixadas e diretório. |
| `sinapse spawn <nome> --provider <p> [--cwd <dir>] --role "<r>" [--autonomy read\|edit\|full] [--model <m>]` | Cria um worker. |
| `sinapse spawn <nome> ... --worktree` | Isola o worker em git worktree própria. |
| `sinapse squad list` | Lista os presets de squad. |
| `sinapse squad apply <preset> [--prefix <p>] [--worktree]` | Cria os workers do preset. |
| `sinapse ask <nome> "<prompt>"` | Envia prompt ao worker de forma síncrona e exibe a saída em tempo real. |
| `sinapse ask <nome> "<prompt>" --async` | Envia de forma assíncrona; retorna o `turnId` imediatamente. |
| `sinapse ask <nome> "<prompt>" --queue` | Como `--async`, mas enfileira se o worker estiver ocupado. |
| `sinapse wait <n1> [n2 ...] [--any] [--timeout <seg>]` | Bloqueia até os workers terminarem; imprime status, contexto e resposta completa. |
| `sinapse check <nome> [--full]` | Status, fila, últimos eventos e resposta do último turno. |
| `sinapse stop <nome>` | Interrompe o turno em execução e descarta a fila. |
| `sinapse handoff <nome> [--note <nota>]` | Resume a sessão do worker numa nota e zera o contexto. |
| `sinapse rm <nome> [--force]` | Remove o worker; worktree/branch são mantidas se tiverem trabalho não integrado. |
| `sinapse models [claude\|codex\|agy]` | Lista os modelos disponíveis por provedor. |
| `sinapse model <nome> <modelo\|padrao>` | Altera o modelo de um worker existente. |
| `sinapse note list` | Lista resumos de todas as notas. |
| `sinapse note read <nome>` | Exibe o conteúdo da nota. |
| `sinapse note write <nome> "<texto>"` | Cria ou sobrescreve uma nota. Use `-` para ler do stdin. |
| `sinapse note append <nome> "<texto>"` | Acrescenta ao final da nota. Use `-` para ler do stdin. |
| `sinapse note rm <nome>` | Remove permanentemente uma nota. |
| `sinapse pin <worker> <nota> [nota ...]` | Fixa notas no worker: o conteúdo é injetado automaticamente em cada turno. |
| `sinapse unpin <worker> <nota> [nota ...]` | Desafixa notas do worker. |
| `sinapse start` | Inicia o daemon `sinapsed` em primeiro plano. |

### Níveis de autonomia

| Nível | Claude | Codex | AGY | Comportamento |
|---|---|---|---|---|
| `read` | `--permission-mode plan` | `--sandbox read-only` | `--mode plan` | Somente leitura/planejamento; não altera arquivos. |
| `edit` *(padrão)* | `--permission-mode acceptEdits` | `--sandbox workspace-write` | `--mode accept-edits` | Criação e edição de arquivos sem confirmações repetitivas. |
| `full` | *(sem restrições)* | `--dangerously-bypass-approvals-and-sandbox` | *(sem restrições)* | Execução irrestrita; usar só sob pedido explícito. |

### Isolamento por git worktree

`sinapse spawn <nome> --worktree` faz o daemon criar `git worktree add -b sinapse/<nome>` em `~/.sinapse/workspaces/<id>/worktrees/<nome>`. Assim vários workers com `edit` não pisam nos mesmos arquivos.

- O projeto precisa ser um repositório git com ao menos um commit.
- A worktree nasce sem `node_modules`, artefatos de build ou arquivos ignorados pelo git.
- O Sinapse nunca faz merge automaticamente; integre a branch `sinapse/<nome>` manualmente.
- `sinapse rm` mantém a worktree/branch se houver trabalho não integrado (e avisa o caminho). `--force` apaga tudo.

### Presets de squad

| Preset | Membros |
|---|---|
| `review` | `arquiteto` (read) + `revisor` (read) |
| `tdd` | `implementador` (edit) + `testador` (edit) |
| `bug-hunt` | `investigador` (read) + `corretor` (edit) |

Presets personalizados ficam em `~/.sinapse/squads.json`:

```json
[
  {
    "name": "docs",
    "description": "Redator e revisor de documentação",
    "members": [
      { "name": "redator", "provider": "claude", "autonomy": "edit", "role": "Escreve a documentação." },
      { "name": "revisor", "provider": "agy", "autonomy": "read", "role": "Revisa o texto." }
    ]
  }
]
```

### Notas fixadas

Uma nota fixada num worker é injetada automaticamente no prompt, sem que o worker precise rodar `sinapse note read` — útil para workers em modo `edit` que podem não ter acesso à CLI:

- **Fixar:** `sinapse pin <worker> <nota>`, `sinapse spawn ... --note spec,decisoes` ou, no canvas, arrastando da alça direita da nota até o worker.
- **Desafixar:** `sinapse unpin <worker> <nota>` ou selecionando a aresta no canvas e pressionando Delete.
- **Limites:** até 10 notas por worker; 16 KB por nota; 48 KB no total por turno (o excesso é cortado com aviso).

### Handoff

Quando um worker chega a ~80% da janela de contexto, o card exibe um botão "Handoff" (equivalente a `sinapse handoff <nome>`). O Sinapse pede ao worker um resumo estruturado, salva na nota `handoff-<nome>`, zera a sessão e mantém nome, papel, modelo, autonomia e pasta. O próximo turno começa lendo essa nota.

### Onde ficam os dados

- `~/.sinapse/state.json` — workspaces e workers (id, status, sessão, modelo, contexto).
- `~/.sinapse/daemon.json` — porta, token e PID do daemon em execução.
- `~/.sinapse/workspaces/<id>/notes/` — notas do workspace.
- `~/.sinapse/workspaces/<id>/worktrees/<nome>/` — git worktrees dos workers.
- `~/.sinapse/squads.json` — presets de squad personalizados (opcional).
- `~/.sinapse/desktop.json` — configurações do app (workspace ativo, padrões, aparência).
- `~/.sinapse/desktop.log` — log de saída do processo Electron.

> **Segurança:** o daemon escuta só em `127.0.0.1` e todas as rotas (exceto `/health`) exigem `Authorization: Bearer <token>`. O token é gerado na primeira execução e armazenado em `state.json` e `daemon.json` com permissão `0600`. Para regenerar o token, apague `~/.sinapse/state.json` com o daemon parado.

## Releases

Para gerar instaladores na sua plataforma:

```bash
npm run dist
```

Os pacotes são gerados em `apps/desktop/dist/`:

| Plataforma | Formato |
|---|---|
| Linux | `.AppImage` e `.deb` |
| Windows | `.exe` (instalador NSIS) |
| macOS | `.dmg` e `.zip` (x64 e arm64) |

> Como `node-pty` é um módulo nativo C++, instaladores de cada sistema operacional devem ser gerados na respectiva plataforma (ou via GitHub Actions ao criar uma tag `v*`).

### Como instalar um release

- **Linux (AppImage):**
  ```bash
  chmod +x Sinapse-*.AppImage && ./Sinapse-*.AppImage
  ```
- **Linux (.deb):**
  ```bash
  sudo dpkg -i Sinapse-*-amd64.deb
  ```
- **Windows:** execute o instalador `.exe` e siga as instruções.
- **macOS:** abra o `.dmg` e arraste o Sinapse para `Applications`.

> **Aviso de segurança (binários não assinados):** os instaladores não possuem assinatura digital comercial.
> - **macOS:** clique com o botão direito em Applications e escolha **Abrir**, ou acesse *Ajustes do Sistema > Privacidade e Segurança* para autorizar.
> - **Windows:** no aviso do SmartScreen, clique em **Mais informações** e depois em **Executar assim mesmo**.

## Estrutura do repositório

```text
sinapse/
├── apps/
│   └── desktop/               # App Electron + React + @xyflow/react
│       ├── build/             # Ícones (icon.svg, icon.png, icon.ico)
│       └── src/               # Processo main, preload e renderer
├── packages/
│   ├── core/                  # Daemon Fastify, adapters (claude, codex, agy), gerenciamento de processos
│   └── cli/                   # CLI `sinapse` executável
├── scripts/                   # Scripts de instalação de atalhos e launchers (Linux e Windows)
│   ├── install-shortcut.sh    # Atalho e ícone .desktop no Linux
│   ├── install-shortcut.ps1   # Atalho .lnk no Windows
│   ├── link-skill.sh          # Link simbólico do skill no Linux
│   ├── link-skill.ps1         # Junção de diretório do skill no Windows
│   ├── sinapse-desktop.sh     # Launcher desktop no Linux
│   └── sinapse-desktop.ps1    # Launcher desktop no Windows
├── skill/
│   └── sinapse/               # Skill SKILL.md para o Claude Code (cérebro)
└── package.json               # Configuração do monorepo npm workspaces
```

## Como contribuir

O projeto está nos estágios iniciais (v0.1.0) e aceita contribuições.

1. Faça um fork do repositório e clone localmente.
2. Crie um branch descritivo: `git checkout -b feat/minha-feature` ou `fix/meu-bug`.
3. Faça as alterações, compile (`npm run build`) e teste manualmente.
4. Abra um pull request descrevendo o problema resolvido ou a funcionalidade adicionada.

Sugestões de onde começar: melhorias na interface do canvas, suporte a novos provedores de IA, testes automatizados (ainda não há) e documentação.

## Limitações conhecidas

- **Persistência de logs:** o histórico detalhado de eventos de turnos é mantido em memória e não persiste após o encerramento do daemon.
- **Fila em memória:** prompts enfileirados com `--queue` se perdem se o daemon reiniciar. `wait` e `check --full` mostram só a resposta do último turno.
- **Confiança por workspace:** o Claude Code e o AGY pedem confiança uma vez por workspace novo, pois cada orquestrador roda em sua própria pasta.
- **AGY ao abrir:** o AGY às vezes exibe um aviso de novidades que precisa ser fechado com Esc antes de digitar.
- **Janela de contexto estimada:** quando a CLI não informa o limite (AGY e cérebro), o Sinapse estima pelo nome do modelo; a família Claude 5.x é tratada como 1 M de tokens.
- **Processos que se desligam do pai (Linux/Windows):** alguns servidores MCP se separam do processo que os iniciou. No Linux o Sinapse os encontra por marca no ambiente e os encerra; no Windows depende do `taskkill /T`, que não alcança processos já desligados da árvore.
- **Ambiente Windows não executado em homologação:** os scripts foram preparados para Windows 10/11, mas o desenvolvimento foi conduzido no Linux. Relate problemas encontrados.

## Solução de problemas

**`Failed to load native module: pty.node`**  
Execute `npm install` novamente na raiz do projeto para recompilar o módulo nativo, ou instale as ferramentas de compilação da plataforma (`build-essential python3` no Linux ou Visual Studio Build Tools no Windows).

**`GTK 2/3 symbols detected` (Linux)**  
Pode ocorrer em ambientes que carregam GTK3 juntamente com versões do Electron que transitaram para GTK4. Verifique se a versão do Electron no `package.json` é compatível com o seu ambiente. Relates ajudam a diagnosticar o problema.

**Janela não abre a partir do atalho**  
Verifique o log em `~/.sinapse/desktop.log` (Linux) ou `%USERPROFILE%\.sinapse\desktop.log` (Windows) para erros de build do `electron-vite`.

**`sinapse: command not found`**  
Execute `npm link -w @sinapse/cli` na raiz do repositório e confirme que o diretório de binários globais do npm está no `PATH`.

## Status do projeto

**v0.1.0 — alpha público.** A CLI e o daemon são estáveis no Linux; a interface desktop está funcional. Não há testes automatizados. A API interna (HTTP/SSE do daemon) pode mudar sem aviso entre versões menores enquanto o projeto estiver na versão 0.x.

## Licença

[MIT](LICENSE)

---

## English summary

**Sinapse** is a multi-agent orchestrator for developers. It runs Claude Code as the "brain" in an embedded terminal and lets it delegate tasks to headless worker agents from other providers — Claude, OpenAI Codex, or AGY/Gemini — via a local daemon (`sinapsed`). All delegations appear live on a React Flow canvas.

**Requirements:** Node.js 22+, Git, Claude Code CLI (`claude`), and optionally AGY (`agy`) and OpenAI Codex (`codex`) CLIs.

**Quick start (Linux):**
```bash
git clone https://github.com/raguiohead/sinapse.git
cd sinapse && npm install && npm run build
npm link -w @sinapse/cli
npm start
```

**Status:** v0.1.0, alpha. Linux only (Windows experimental, untested). MIT license.
