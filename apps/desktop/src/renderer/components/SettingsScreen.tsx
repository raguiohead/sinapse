import { useState, useEffect, useRef } from "react";
import type {
  DesktopSettings,
  DesktopSettingsPatch,
  DaemonDetails,
  Autonomy,
} from "../../shared/ipc";
import type { ContextUsage, Workspace } from "@sinapse/core";
import { ModelSelect } from "./ModelSelect";
import { ContextMeter } from "./ContextMeter";

export interface SettingsScreenProps {
  onClose: () => void;
  activeWorkspaceId: string;
  workspaces: Workspace[];
  onWorkspaceUpdated?: (ws: Workspace) => void;
}

type SettingsSection = "orquestrador" | "workers" | "daemon" | "aparencia";

function abbreviateFolder(folder: string): string {
  if (!folder) return "";
  return folder.replace(/^\/(home|Users)\/[^/]+/, "~");
}

export function SettingsScreen({
  onClose,
  activeWorkspaceId,
  workspaces,
  onWorkspaceUpdated,
}: SettingsScreenProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("orquestrador");
  const [settings, setSettings] = useState<DesktopSettings | null>(null);

  // Status messages
  const [savedNotice, setSavedNotice] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const savedTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Active workspace state
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) || null;
  const [nameInput, setNameInput] = useState(activeWorkspace?.name || "");

  useEffect(() => {
    if (activeWorkspace?.name) {
      setNameInput(activeWorkspace.name);
    }
  }, [activeWorkspace?.name]);

  // Orchestrator details
  const [brainUsage, setBrainUsage] = useState<ContextUsage | undefined>(undefined);
  const [resolvedBrainModel, setResolvedBrainModel] = useState<string | null>(null);

  // Daemon section details
  const [daemonDetails, setDaemonDetails] = useState<DaemonDetails | null>(null);
  const [daemonConnected, setDaemonConnected] = useState<boolean>(true);

  const triggerSavedNotice = () => {
    setSavedNotice(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => {
      setSavedNotice(false);
    }, 2000);
  };

  // Load settings and listeners
  useEffect(() => {
    window.sinapse?.settings?.get().then((s) => {
      setSettings(s);
    });

    const unsubSettings = window.sinapse?.settings?.onChanged((s) => {
      setSettings(s);
    });

    // Brain info for active workspace
    if (activeWorkspaceId) {
      window.sinapse?.brain?.getInfo(activeWorkspaceId).then((info) => {
        if (info) {
          setBrainUsage(info.usage);
          setResolvedBrainModel(info.usage?.model ?? info.model ?? null);
        }
      });
    }

    const unsubUsage = window.sinapse?.brain?.onUsage((wsId, u) => {
      if (wsId === activeWorkspaceId) {
        setBrainUsage(u);
        if (u.model) setResolvedBrainModel(u.model);
      }
    });

    const unsubInfo = window.sinapse?.brain?.onInfoChanged((info) => {
      if (info.workspaceId === activeWorkspaceId) {
        setResolvedBrainModel(info.model ?? null);
        if (info.usage !== undefined) setBrainUsage(info.usage);
      }
    });

    // Daemon details & status
    window.sinapse?.daemon?.details().then(setDaemonDetails).catch(console.error);

    const unsubStatus = window.sinapse?.daemon?.onStatus((status) => {
      setDaemonConnected(status.connected);
    });

    return () => {
      if (unsubSettings) unsubSettings();
      if (unsubUsage) unsubUsage();
      if (unsubInfo) unsubInfo();
      if (unsubStatus) unsubStatus();
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [activeWorkspaceId]);

  // Handle escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const savePatch = async (patch: DesktopSettingsPatch) => {
    setErrorMessage(null);
    try {
      const updated = await window.sinapse?.settings?.set(patch);
      if (updated) {
        setSettings(updated);
      }
      triggerSavedNotice();
    } catch (err: any) {
      console.error("Erro ao salvar configurações:", err);
      setErrorMessage(err?.message || "Erro ao salvar alterações");
    }
  };

  const handleNameSave = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed || !activeWorkspace || trimmed === activeWorkspace.name) return;

    setErrorMessage(null);
    try {
      const updated = await window.sinapse?.workspaces?.update({
        workspaceId: activeWorkspace.id,
        name: trimmed,
      });
      if (updated) {
        onWorkspaceUpdated?.(updated);
        triggerSavedNotice();
      }
    } catch (err: any) {
      console.error("Erro ao atualizar nome do workspace:", err);
      setErrorMessage(err?.message || "Erro ao atualizar nome");
      setNameInput(activeWorkspace.name);
    }
  };

  const handleProviderChange = async (newProvider: "claude" | "agy") => {
    if (!activeWorkspace) return;
    const currentProvider = activeWorkspace.orchestrator?.provider ?? "claude";
    if (newProvider === currentProvider) return;

    const confirmed = window.confirm(
      "Trocar o orquestrador reinicia o terminal deste workspace e começa uma conversa nova. Continuar?"
    );
    if (!confirmed) return;

    setErrorMessage(null);
    try {
      const updated = await window.sinapse?.workspaces?.update({
        workspaceId: activeWorkspace.id,
        orchestrator: {
          provider: newProvider,
          model: undefined,
        },
      });
      if (updated) {
        onWorkspaceUpdated?.(updated);
        triggerSavedNotice();
      }
    } catch (err: any) {
      console.error("Erro ao alterar orquestrador:", err);
      setErrorMessage(err?.message || "Erro ao alterar orquestrador");
    }
  };

  const handleModelChange = async (newModel: string | null) => {
    if (!activeWorkspace) return;
    const currentProvider = activeWorkspace.orchestrator?.provider ?? "claude";
    const currentModel = activeWorkspace.orchestrator?.model ?? null;
    const normalizedNew = newModel?.trim() ? newModel.trim() : null;

    if (normalizedNew === currentModel) return;

    const confirmMsg =
      currentProvider === "claude"
        ? "Trocar o modelo reinicia o terminal deste workspace e retoma a conversa. Continuar?"
        : "Trocar o modelo reinicia o terminal deste workspace. Continuar?";

    const confirmed = window.confirm(confirmMsg);
    if (!confirmed) return;

    setErrorMessage(null);
    try {
      const updated = await window.sinapse?.workspaces?.update({
        workspaceId: activeWorkspace.id,
        orchestrator: {
          provider: currentProvider,
          model: normalizedNew || undefined,
        },
      });
      if (updated) {
        onWorkspaceUpdated?.(updated);
        triggerSavedNotice();
      }
    } catch (err: any) {
      console.error("Erro ao alterar modelo:", err);
      setErrorMessage(err?.message || "Erro ao alterar modelo");
    }
  };

  const currentProvider = activeWorkspace?.orchestrator?.provider ?? "claude";
  const currentModel = activeWorkspace?.orchestrator?.model ?? null;

  return (
    <div
      className="settings-overlay nodrag"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-panel" role="dialog" aria-modal="true">
        {/* Header */}
        <div className="settings-header">
          <div className="settings-header-left">
            <h2 className="settings-title">Configurações</h2>
            {savedNotice && <span className="settings-saved-badge">✓ Salvo</span>}
            {errorMessage && (
              <span className="settings-error-badge">{errorMessage}</span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="settings-close-btn"
            title="Fechar (Esc)"
            aria-label="Fechar"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="settings-body">
          {/* Navigation Sidebar */}
          <nav className="settings-nav" aria-label="Seções de configurações">
            <button
              type="button"
              className={`settings-nav-btn ${
                activeSection === "orquestrador" ? "active" : ""
              }`}
              onClick={() => setActiveSection("orquestrador")}
            >
              Orquestrador
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${
                activeSection === "workers" ? "active" : ""
              }`}
              onClick={() => setActiveSection("workers")}
            >
              Workers
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${
                activeSection === "daemon" ? "active" : ""
              }`}
              onClick={() => setActiveSection("daemon")}
            >
              Daemon e dados
            </button>
            <button
              type="button"
              className={`settings-nav-btn ${
                activeSection === "aparencia" ? "active" : ""
              }`}
              onClick={() => setActiveSection("aparencia")}
            >
              Aparência
            </button>
          </nav>

          {/* Section Content */}
          <div className="settings-content">
            {/* 1. Orquestrador (para o workspace ativo) */}
            {activeSection === "orquestrador" && (
              <div className="settings-section">
                {activeWorkspace ? (
                  <>
                    <div className="settings-row">
                      <div className="settings-field-info">
                        <label className="settings-label" htmlFor="workspace-name-setting">
                          Nome do workspace
                        </label>
                        <p className="settings-description">
                          Nome de exibição deste workspace. Salvo ao sair ou pressionar Enter.
                        </p>
                      </div>
                      <div className="settings-field-control">
                        <input
                          id="workspace-name-setting"
                          type="text"
                          value={nameInput}
                          onChange={(e) => setNameInput(e.target.value)}
                          onBlur={handleNameSave}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleNameSave();
                            }
                          }}
                          className="settings-input"
                        />
                      </div>
                    </div>

                    <div className="settings-row">
                      <div className="settings-field-info">
                        <span className="settings-label">Pasta do projeto</span>
                        <p className="settings-description">
                          Diretório raiz do projeto vinculado a este workspace.
                        </p>
                      </div>
                      <div className="settings-field-control settings-folder-control">
                        <span className="settings-badge-mono" title={activeWorkspace.folder}>
                          {abbreviateFolder(activeWorkspace.folder)}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            window.sinapse?.app?.openFolder("projeto", activeWorkspace.id)
                          }
                          className="settings-action-btn"
                        >
                          Abrir
                        </button>
                      </div>
                    </div>

                    <div className="settings-row">
                      <div className="settings-field-info">
                        <label className="settings-label">Provedor do orquestrador</label>
                        <p className="settings-description">
                          Claude Code ou AGY para o terminal orquestrador deste workspace.
                        </p>
                      </div>
                      <div className="settings-field-control">
                        <div className="segmented-control">
                          <button
                            type="button"
                            className={`segmented-btn ${
                              currentProvider === "claude" ? "active" : ""
                            }`}
                            onClick={() => handleProviderChange("claude")}
                          >
                            Claude Code
                          </button>
                          <button
                            type="button"
                            className={`segmented-btn ${
                              currentProvider === "agy" ? "active" : ""
                            }`}
                            onClick={() => handleProviderChange("agy")}
                          >
                            AGY
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="settings-row">
                      <div className="settings-field-info">
                        <label className="settings-label" htmlFor="orchestrator-model-select">
                          Modelo do orquestrador
                        </label>
                        <p className="settings-description">
                          Modelo LLM configurado para este orquestrador.
                        </p>
                      </div>
                      <div className="settings-field-control">
                        <ModelSelect
                          id="orchestrator-model-select"
                          provider={currentProvider}
                          value={currentModel}
                          resolvedModel={resolvedBrainModel ?? undefined}
                          onChange={handleModelChange}
                          className="settings-select-control"
                        />
                      </div>
                    </div>

                    <div className="settings-row">
                      <div className="settings-field-info">
                        <span className="settings-label">Modelo resolvido</span>
                        <p className="settings-description">
                          Modelo em execução atualmente na sessão do orquestrador.
                        </p>
                      </div>
                      <div className="settings-field-control">
                        <span className="settings-badge-mono">
                          {resolvedBrainModel ?? "padrão"}
                        </span>
                      </div>
                    </div>

                    {currentProvider === "claude" && (
                      <div className="settings-row">
                        <div className="settings-field-info">
                          <span className="settings-label">Janela de contexto</span>
                          <p className="settings-description">
                            Consumo de tokens e uso do contexto do orquestrador.
                          </p>
                        </div>
                        <div className="settings-field-control settings-meter-wrapper">
                          <ContextMeter usage={brainUsage} />
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="settings-text">Nenhum workspace ativo selecionado.</div>
                )}
              </div>
            )}

            {/* 2. Workers */}
            {activeSection === "workers" && (
              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-field-info">
                    <label className="settings-label">Provedor padrão</label>
                    <p className="settings-description">
                      Provedor sugerido ao instanciar novos workers.
                    </p>
                  </div>
                  <div className="settings-field-control">
                    <div className="segmented-control">
                      <button
                        type="button"
                        className={`segmented-btn ${
                          settings?.workerDefaults?.provider === "claude"
                            ? "active"
                            : ""
                        }`}
                        onClick={() =>
                          savePatch({
                            workerDefaults: { provider: "claude", model: undefined },
                          })
                        }
                      >
                        Claude
                      </button>
                      <button
                        type="button"
                        className={`segmented-btn ${
                          settings?.workerDefaults?.provider === "codex"
                            ? "active"
                            : ""
                        }`}
                        onClick={() =>
                          savePatch({
                            workerDefaults: { provider: "codex", model: undefined },
                          })
                        }
                      >
                        Codex (OpenAI)
                      </button>
                      <button
                        type="button"
                        className={`segmented-btn ${
                          settings?.workerDefaults?.provider === "agy" ? "active" : ""
                        }`}
                        onClick={() =>
                          savePatch({
                            workerDefaults: { provider: "agy", model: undefined },
                          })
                        }
                      >
                        AGY (Gemini 3.8 Flash)
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-field-info">
                    <label className="settings-label">Modelo padrão</label>
                    <p className="settings-description">
                      Modelo utilizado pelo provedor padrão para novos workers.
                    </p>
                  </div>
                  <div className="settings-field-control">
                    <ModelSelect
                      provider={settings?.workerDefaults?.provider ?? "claude"}
                      value={settings?.workerDefaults?.model ?? null}
                      onChange={(m) =>
                        savePatch({
                          workerDefaults: { model: m ?? undefined },
                        })
                      }
                      className="settings-select-control"
                    />
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-field-info">
                    <label className="settings-label">Nível de autonomia</label>
                    <p className="settings-description">
                      Permissões concedidas aos workers por padrão.
                    </p>
                  </div>
                  <div className="settings-field-control settings-autonomy-options">
                    <div className="segmented-control">
                      {(
                        [
                          { id: "read", label: "Somente leitura" },
                          { id: "edit", label: "Editar (padrão)" },
                          { id: "full", label: "Total" },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`segmented-btn ${
                            settings?.workerDefaults?.autonomy === opt.id
                              ? "active"
                              : ""
                          }`}
                          onClick={() =>
                            savePatch({
                              workerDefaults: { autonomy: opt.id as Autonomy },
                            })
                          }
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <div className="settings-autonomy-desc">
                      {settings?.workerDefaults?.autonomy === "read" &&
                        "Somente leitura: Executa comandos e consultas sem modificar arquivos."}
                      {settings?.workerDefaults?.autonomy === "edit" &&
                        "Editar (padrão): Pode ler e editar arquivos no diretório do workspace."}
                      {settings?.workerDefaults?.autonomy === "full" &&
                        "Total: Acesso irrestrito ao sistema dentro do escopo do worker."}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 3. Daemon e dados */}
            {activeSection === "daemon" && (
              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-field-info">
                    <span className="settings-label">Status do Daemon</span>
                  </div>
                  <div className="settings-field-control">
                    <span className="settings-status-badge">
                      <span
                        className={`daemon-dot ${
                          daemonConnected ? "dot-online" : "dot-offline"
                        }`}
                      />
                      {daemonConnected ? "Conectado" : "Desconectado"}
                    </span>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-field-info">
                    <span className="settings-label">Porta</span>
                  </div>
                  <div className="settings-field-control">
                    <span className="settings-badge-mono">
                      {daemonDetails?.port ?? "—"}
                    </span>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-field-info">
                    <span className="settings-label">Gerenciamento</span>
                  </div>
                  <div className="settings-field-control">
                    <span className="settings-text">
                      Gerenciado por:{" "}
                      <strong>
                        {daemonDetails?.ownsDaemon
                          ? "este app"
                          : "a CLI (sinapse start)"}
                      </strong>
                    </span>
                  </div>
                </div>

                <div className="settings-divider" />

                <div className="settings-table-row">
                  <div className="settings-dir-label">Dados</div>
                  <div className="settings-dir-path" title={daemonDetails?.dataDir}>
                    {daemonDetails?.dataDir ? abbreviateFolder(daemonDetails.dataDir) : "—"}
                  </div>
                  <button
                    type="button"
                    onClick={() => window.sinapse?.app?.openFolder("dados")}
                    className="settings-action-btn"
                  >
                    Abrir
                  </button>
                </div>

                {activeWorkspace && (
                  <>
                    <div className="settings-table-row">
                      <div className="settings-dir-label">Orquestrador</div>
                      <div className="settings-dir-path">
                        Sessão do orquestrador ({activeWorkspace.name})
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          window.sinapse?.app?.openFolder("orquestrador", activeWorkspace.id)
                        }
                        className="settings-action-btn"
                      >
                        Abrir
                      </button>
                    </div>

                    <div className="settings-table-row">
                      <div className="settings-dir-label">Notas</div>
                      <div className="settings-dir-path">
                        Notas do workspace ({activeWorkspace.name})
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          window.sinapse?.app?.openFolder("notas", activeWorkspace.id)
                        }
                        className="settings-action-btn"
                      >
                        Abrir
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* 4. Aparência */}
            {activeSection === "aparencia" && (
              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-field-info">
                    <label className="settings-label">Barra cromática</label>
                    <p className="settings-description">
                      Efeito de gradiente cromático no topo da janela.
                    </p>
                  </div>
                  <div className="settings-field-control">
                    <div className="segmented-control">
                      {(
                        [
                          { id: "animada", label: "Animada" },
                          { id: "estatica", label: "Estática" },
                          { id: "desligada", label: "Desligada" },
                        ] as const
                      ).map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`segmented-btn ${
                            settings?.appearance?.chromaticBar === item.id
                              ? "active"
                              : ""
                          }`}
                          onClick={() =>
                            savePatch({
                              appearance: { chromaticBar: item.id },
                            })
                          }
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-field-info">
                    <label className="settings-label">Movimento</label>
                    <p className="settings-description">
                      Controla animações e transições no aplicativo.
                    </p>
                  </div>
                  <div className="settings-field-control">
                    <div className="segmented-control">
                      <button
                        type="button"
                        className={`segmented-btn ${
                          settings?.appearance?.motion === "sistema" ? "active" : ""
                        }`}
                        onClick={() =>
                          savePatch({
                            appearance: { motion: "sistema" },
                          })
                        }
                      >
                        Seguir o sistema
                      </button>
                      <button
                        type="button"
                        className={`segmented-btn ${
                          settings?.appearance?.motion === "reduzido" ? "active" : ""
                        }`}
                        onClick={() =>
                          savePatch({
                            appearance: { motion: "reduzido" },
                          })
                        }
                      >
                        Reduzido
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-field-info">
                    <label
                      className="settings-label"
                      htmlFor="settings-terminal-font"
                    >
                      Tamanho da fonte do terminal
                    </label>
                    <p className="settings-description">
                      Tamanho em pixels do terminal do orquestrador (10px a 22px).
                    </p>
                  </div>
                  <div className="settings-field-control settings-range-control">
                    <input
                      id="settings-terminal-font"
                      type="range"
                      min={10}
                      max={22}
                      step={1}
                      value={settings?.appearance?.terminalFontSize ?? 13}
                      onChange={(e) =>
                        savePatch({
                          appearance: {
                            terminalFontSize: Number(e.target.value),
                          },
                        })
                      }
                      className="settings-range-slider"
                    />
                    <span className="settings-range-value">
                      {settings?.appearance?.terminalFontSize ?? 13}px
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
