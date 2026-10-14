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
                                          ┌────────┴────────┐
                                          ▼                 ▼
                                    worker Claude      worker AGY
                                     (claude -p)        (agy -p)
```

## Requisitos

| Dependência | Linux | Windows |
|---|---|---|
| Node.js e npm | Node.js 22+ e npm 10+ | Node.js 22+ e npm 10+ |
| Git | Git instalado | Git instalado |
| Claude Code CLI | `claude` instalado e autenticado | Instalador **NATIVO** (`claude.exe` no PATH, não pacote npm) |
| AGY CLI | `agy` instalado e autenticado | `agy.exe` no PATH |
| Compilador C++ (opcional) | `build-essential python3` | Visual Studio Build Tools (Desktop development with C++) |

> [!IMPORTANT]
> **Por que executáveis nativos no Windows?**
> O prompt de cada turno é passado como argumento ao CLI do worker. Se esse argumento passasse pelo `cmd.exe` (o que acontece com os atalhos `.cmd` que o npm instala), aspas e caracteres especiais do prompt quebrariam o comando ou seriam interpretados como comandos. Com `claude.exe` e `agy.exe` no PATH, o Sinapse cria o processo diretamente, sem shell, e o Node faz o escape correto dos argumentos.
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
- **Botão + worker:** cria um worker pelo canvas, com nome, provedor e papel. Ele roda na sua pasta pessoal com autonomia `edit`; para escolher pasta e autonomia, use `sinapse spawn`.
- **Perguntar / Parar:** cada worker aceita prompts direto pelo card e permite interromper o turno em andamento.
- **Arestas:** partículas vão do cérebro ao worker quando um turno começa e voltam na cor do provedor quando ele termina.
- **Cabeçalho:** mostra se o daemon está conectado e quantos workers estão pensando.
- Workers criados pelo cérebro no terminal entram no canvas sozinhos, e a câmera se reajusta.

### Comandos da CLI

A CLI `sinapse` gerencia os workers e se comunica com o daemon `sinapsed`:

| Comando | Descrição |
|---|---|
| `sinapse list` | Lista todos os workers cadastrados, provedor, modelo, uso de contexto, status, autonomia e diretório de trabalho. |
| `sinapse spawn <nome> --provider <p> --cwd <dir> --role "<r>" [--autonomy edit] [--model <m>]` | Cria um novo worker (`--provider claude\|agy`, `--cwd`, `--role`, `--autonomy read\|edit\|full`, `--model <m>`). |
| `sinapse ask <nome> "<prompt>"` | Envia prompt ao worker de modo síncrono, exibindo a saída em tempo real no terminal. |
| `sinapse ask <nome> "<prompt>" --async` | Envia prompt de modo assíncrono, retornando imediatamente o `turnId` gerado. |
| `sinapse check <nome>` | Consulta o status atual do worker, modelo, contexto, ID do turno em execução e últimos eventos registrados. |
| `sinapse stop <nome>` | Interrompe imediatamente o turno em execução no worker selecionado. |
| `sinapse models [claude\|agy]` | Lista o catálogo de modelos disponíveis para os provedores Claude e AGY. |
| `sinapse model <nome> <modelo\|padrao>` | Altera o modelo de um worker existente (`padrao` limpa e volta ao padrão do provedor). |
| `sinapse note list` | Lista resumos de todas as notas salvas ordenadas por data de modificação. |
| `sinapse note read <nome>` | Exibe o conteúdo bruto da nota especificada. |
| `sinapse note write <nome> "<texto>"` | Cria ou sobrescreve uma nota. Use `-` no lugar do texto para ler do stdin. |
| `sinapse note append <nome> "<texto>"` | Acrescenta ao final da nota (cria se não existir). Use `-` para ler do stdin. |
| `sinapse note rm <nome>` | Remove permanentemente uma nota. |
| `sinapse start` | Inicia o daemon `sinapsed` em primeiro plano (ou conecta se já estiver ativo). |

### Modelos e janela de contexto

Tanto no canvas quanto na CLI, é possível selecionar e alternar os modelos dos workers:
- **Seleção no Canvas e na CLI:** utilize `--model <modelo>` no `sinapse spawn` ou consulte os modelos disponíveis via `sinapse models [claude|agy]`. Para alterar o modelo de um worker existente, utilize `sinapse model <nome> <modelo>` (ou `sinapse model <nome> padrao` para remover o modelo customizado). No canvas, o modelo pode ser escolhido na criação e modificado no card do worker.
- **Cérebro:** o seletor no cabeçalho do terminal troca o modelo do cérebro. Ele reinicia retomando a própria sessão (`--resume` com o id dela), então a conversa continua; a escolha fica salva em `desktop.json`.
- **Janela de contexto:**
  - O **Claude** reporta o tamanho real de sua janela de contexto diretamente pela CLI (`contextWindow`).
  - O **AGY** e o **cérebro** exibem uma estimativa da janela de contexto marcada com o prefixo `≈` (ex: `≈21k/1m 2%`).
  - O uso de contexto do **cérebro** é lido a partir do transcript de sessão do Claude Code.

### Notas

As notas representam a memória compartilhada entre o usuário, o cérebro e os workers:
- **Onde vivem:** arquivos Markdown salvos em `~/.sinapse/notes/<nome>.md` (ou `$SINAPSE_HOME/notes/<nome>.md`). Nomes devem ser minúsculos com hífens ou sublinhados (`^[a-z0-9][a-z0-9_-]{0,63}$`).
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

| Nível | Flag Claude (`claude`) | Flag AGY (`agy`) | Comportamento |
|---|---|---|---|
| `read` | `--permission-mode plan` | `--mode plan` | Modo somente leitura/planejamento. Não altera arquivos. |
| `edit` *(padrão)* | `--permission-mode acceptEdits` | `--mode accept-edits` | Permite criação e edição de arquivos do projeto sem confirmações repetitivas. |
| `full` | *(sem restrições)* | *(sem restrições)* | Execução total irrestrita (usar apenas sob pedido explícito). |

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
4. O cérebro continua trabalhando em outra tarefa e acompanha periodicamente o status:
   ```bash
   sinapse check tester
   ```

## Onde ficam os dados

Todos os dados de runtime do Sinapse ficam armazenados no diretório do usuário:

- `~/.sinapse/state.json`: Estado persistido dos agentes cadastrados (id, nome, provedor, diretório, status, sessionId, modelo, uso de contexto).
- `~/.sinapse/daemon.json`: Informações do daemon em execução (`port`, `token`, `pid`).
- `~/.sinapse/notes/`: Diretório de notas compartilhadas em Markdown (`<nome>.md`).
- `~/.sinapse/desktop.json`: Configurações da aplicação desktop (armazena o modelo configurado para o cérebro).
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
│   ├── core/                  # Daemon Fastify, adapters (claude, agy), gerenciamento de processos
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
- **Adapter Codex:** O adapter para OpenAI Codex ainda não foi implementado.
- **Persistência de logs:** O histórico detalhado de eventos de turnos de workers é mantido em memória e não é persistido após o encerramento do daemon.
- **Pasta do cérebro:** o cérebro roda em `~/.sinapse/cerebro` (com um `CLAUDE.md` que explica o papel dele), não nos seus projetos. Na primeira execução o Claude Code pede confiança nessa pasta, uma única vez. Para mexer em projetos, o cérebro usa caminhos absolutos e passa a pasta certa aos workers.
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
