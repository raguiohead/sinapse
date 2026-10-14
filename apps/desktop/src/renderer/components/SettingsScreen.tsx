import { useState, useEffect, useRef } from "react";
import type {
  DesktopSettings,
  DesktopSettingsPatch,
  DaemonDetails,
  Autonomy,
} from "../../shared/ipc";
import type { ContextUsage } from "@sinapse/core";
import { ModelSelect } from "./ModelSelect";
import { ContextMeter } from "./ContextMeter";

export interface SettingsScreenProps {
  onClose: () => void;
}

type SettingsSection = "cerebro" | "workers" | "daemon" | "aparencia";

export function SettingsScreen({ onClose }: SettingsScreenProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("cerebro");
  const [settings, setSettings] = useState<DesktopSettings | null>(null);

  // Status message
  const [savedNotice, setSavedNotice] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const savedTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Brain section details
  const [brainUsage, setBrainUsage] = useState<ContextUsage | undefined>(undefined);
  const [resolvedBrainModel, setResolvedBrainModel] = useState<string | null>(null);

  // Daemon section details
  const [daemonDetails, setDaemonDetails] = useState<DaemonDetails | null>(null);
  const [daemonConnected, setDaemonConnected] = useState<boolean>(true);

  // Workers folder local input
  const [folderInput, setFolderInput] = useState("");

  // Load settings and listeners
  useEffect(() => {
    window.sinapse?.settings?.get().then((s) => {
      setSettings(s);
      setFolderInput(s.workerDefaults.cwd || "");
    });

    const unsubSettings = window.sinapse?.settings?.onChanged((s) => {
      setSettings(s);
    });

    // Brain info
    window.sinapse?.brain?.getInfo().then((info) => {
      if (info) {
        setBrainUsage(info.usage);
        setResolvedBrainModel(info.usage?.model ?? info.model ?? null);
      }
    });

    const unsubUsage = window.sinapse?.brain?.onUsage((u) => {
      setBrainUsage(u);
      if (u.model) setResolvedBrainModel(u.model);
    });

    const unsubInfo = window.sinapse?.brain?.onInfoChanged((info) => {
      setResolvedBrainModel(info.model ?? null);
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
  }, []);

  // Update folder input when settings change externally
  useEffect(() => {
    if (settings?.workerDefaults?.cwd !== undefined) {
      setFolderInput(settings.workerDefaults.cwd);
    }
  }, [settings?.workerDefaults?.cwd]);

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
      setSavedNotice(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        setSavedNotice(false);
      }, 2000);
    } catch (err: any) {
      console.error("Erro ao salvar configurações:", err);
      setErrorMessage(err?.message || "Erro ao salvar alterações");
    }
  };

  const handleBrainModelChange = async (newModel: string | null) => {
    const confirmed = window.confirm(
      "Trocar o modelo reinicia o terminal do cérebro. A conversa continua. Continuar?"
    );
    if (!confirmed) return;

    await savePatch({
      brainModel: newModel === "" ? null : newModel,
    });
  };

  const handleWorkerFolderSave = () => {
    if (folderInput !== settings?.workerDefaults?.cwd) {
      savePatch({
        workerDefaults: { cwd: folderInput },
      });
    }
  };

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
                activeSection === "cerebro" ? "active" : ""
              }`}
              onClick={() => setActiveSection("cerebro")}
            >
              Cérebro
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
            {/* 1. Cérebro */}
            {activeSection === "cerebro" && (
              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-field-info">
                    <label className="settings-label" htmlFor="brain-model-select">
                      Modelo do Cérebro
                    </label>
                    <p className="settings-description">
                      Define o modelo Claude utilizado pelo cérebro orquestrador.
                    </p>
                  </div>
                  <div className="settings-field-control">
                    <ModelSelect
                      id="brain-model-select"
                      provider="claude"
                      value={settings?.brainModel ?? null}
                      resolvedModel={resolvedBrainModel ?? undefined}
                      onChange={handleBrainModelChange}
                      className="settings-select-control"
                    />
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-field-info">
                    <span className="settings-label">Modelo resolvido</span>
                    <p className="settings-description">
                      Modelo em execução atualmente na sessão do cérebro.
                    </p>
                  </div>
                  <div className="settings-field-control">
                    <span className="settings-badge-mono">
                      {resolvedBrainModel ?? "padrão"}
                    </span>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-field-info">
                    <span className="settings-label">Janela de contexto</span>
                    <p className="settings-description">
                      Consumo de tokens e uso do contexto do cérebro.
                    </p>
                  </div>
                  <div className="settings-field-control settings-meter-wrapper">
                    <ContextMeter usage={brainUsage} />
                  </div>
                </div>
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
                        "Editar (padrão): Pode ler e editar arquivos no diretório de trabalho."}
                      {settings?.workerDefaults?.autonomy === "full" &&
                        "Total: Acesso irrestrito ao sistema dentro do escopo do worker."}
                    </div>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-field-info">
                    <label className="settings-label" htmlFor="settings-worker-cwd">
                      Pasta de trabalho padrão
                    </label>
                    <p className="settings-description">
                      Diretório raiz inicial para execução dos workers.
                    </p>
                  </div>
                  <div className="settings-field-control">
                    <input
                      id="settings-worker-cwd"
                      type="text"
                      value={folderInput}
                      onChange={(e) => setFolderInput(e.target.value)}
                      onBlur={handleWorkerFolderSave}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleWorkerFolderSave();
                        }
                      }}
                      placeholder="/caminho/absoluto"
                      className="settings-input settings-input-mono"
                    />
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
                    {daemonDetails?.dataDir ?? "—"}
                  </div>
                  <button
                    type="button"
                    onClick={() => window.sinapse?.app?.openFolder("dados")}
                    className="settings-action-btn"
                  >
                    Abrir
                  </button>
                </div>

                <div className="settings-table-row">
                  <div className="settings-dir-label">Cérebro</div>
                  <div className="settings-dir-path" title={daemonDetails?.brainDir}>
                    {daemonDetails?.brainDir ?? "—"}
                  </div>
                  <button
                    type="button"
                    onClick={() => window.sinapse?.app?.openFolder("cerebro")}
                    className="settings-action-btn"
                  >
                    Abrir
                  </button>
                </div>

                <div className="settings-table-row">
                  <div className="settings-dir-label">Notas</div>
                  <div className="settings-dir-path" title={daemonDetails?.notesDir}>
                    {daemonDetails?.notesDir ?? "—"}
                  </div>
                  <button
                    type="button"
                    onClick={() => window.sinapse?.app?.openFolder("notas")}
                    className="settings-action-btn"
                  >
                    Abrir
                  </button>
                </div>
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
                      Tamanho em pixels do terminal do cérebro (10px a 22px).
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
