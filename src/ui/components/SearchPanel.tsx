import { useState, useEffect, useRef, useCallback } from "react";
import { Search, MessageSquare, FileText, ChevronDown, Loader2, Settings2, RefreshCw } from "lucide-react";
import { Notice } from "obsidian";
import type { LocalLlmHubPlugin } from "src/plugin";
import type { Attachment } from "src/types";
import { DEFAULT_RAG_SETTING } from "src/types";
import { getRagStore, type RagSearchResult } from "src/core/ragStore";
import { t } from "src/i18n";

interface SearchPanelProps {
  plugin: LocalLlmHubPlugin;
  onChatWithResults: (attachments: Attachment[]) => void;
}

export default function SearchPanel({ plugin, onChatWithResults }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [ragSettingNames, setRagSettingNames] = useState<string[]>(plugin.getRagSettingNames());
  const [selectedRagSetting, setSelectedRagSetting] = useState<string>(
    plugin.getSelectedRagSettingName() ?? ragSettingNames[0] ?? ""
  );
  const [results, setResults] = useState<RagSearchResult[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(new Set());
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [topK, setTopK] = useState(() => {
    const setting = plugin.getRagSetting(
      plugin.getSelectedRagSettingName() ?? ragSettingNames[0] ?? ""
    );
    return setting?.topK ?? DEFAULT_RAG_SETTING.topK;
  });
  const [scoreThreshold, setScoreThreshold] = useState(() => {
    const setting = plugin.getRagSetting(
      plugin.getSelectedRagSettingName() ?? ragSettingNames[0] ?? ""
    );
    return setting?.minScore ?? DEFAULT_RAG_SETTING.minScore;
  });

  // RAG settings section state
  const [showRagConfig, setShowRagConfig] = useState(false);
  const [chunkSize, setChunkSize] = useState(() => {
    const setting = plugin.getRagSetting(
      plugin.getSelectedRagSettingName() ?? ragSettingNames[0] ?? ""
    );
    return setting?.chunkSize ?? DEFAULT_RAG_SETTING.chunkSize;
  });
  const [chunkOverlap, setChunkOverlap] = useState(() => {
    const setting = plugin.getRagSetting(
      plugin.getSelectedRagSettingName() ?? ragSettingNames[0] ?? ""
    );
    return setting?.chunkOverlap ?? DEFAULT_RAG_SETTING.chunkOverlap;
  });
  const [targetFolders, setTargetFolders] = useState(() => {
    const setting = plugin.getRagSetting(
      plugin.getSelectedRagSettingName() ?? ragSettingNames[0] ?? ""
    );
    return setting?.targetFolders?.join(", ") ?? "";
  });
  const [excludePatterns, setExcludePatterns] = useState(() => {
    const setting = plugin.getRagSetting(
      plugin.getSelectedRagSettingName() ?? ragSettingNames[0] ?? ""
    );
    return setting?.excludePatterns?.join("\n") ?? "";
  });
  const [ragSyncing, setRagSyncing] = useState(false);
  const ragSyncCancelRef = useRef(false);
  const ragSyncAbortRef = useRef<AbortController | null>(null);
  const [indexedFiles, setIndexedFiles] = useState<{ filePath: string; chunks: number }[]>([]);
  const [showIndexedFiles, setShowIndexedFiles] = useState(false);

  // Check if current setting is internal (not external index)
  const currentRagSetting = plugin.getRagSetting(selectedRagSetting);
  const isInternalRag = currentRagSetting ? !currentRagSetting.externalIndexPath : false;

  useEffect(() => {
    const syncRagSettings = () => {
      const names = plugin.getRagSettingNames();
      setRagSettingNames(names);
      setSelectedRagSetting(prev => {
        if (prev && names.includes(prev)) return prev;
        return names[0] ?? "";
      });
    };

    syncRagSettings();
    plugin.settingsEmitter.on("workspace-state-loaded", syncRagSettings);
    plugin.settingsEmitter.on("rag-setting-changed", syncRagSettings);

    return () => {
      plugin.settingsEmitter.off("workspace-state-loaded", syncRagSettings);
      plugin.settingsEmitter.off("rag-setting-changed", syncRagSettings);
    };
  }, [plugin]);

  useEffect(() => {
    const setting = plugin.getRagSetting(selectedRagSetting);
    setTopK(setting?.topK ?? DEFAULT_RAG_SETTING.topK);
    setScoreThreshold(setting?.minScore ?? DEFAULT_RAG_SETTING.minScore);
    setChunkSize(setting?.chunkSize ?? DEFAULT_RAG_SETTING.chunkSize);
    setChunkOverlap(setting?.chunkOverlap ?? DEFAULT_RAG_SETTING.chunkOverlap);
    setTargetFolders(setting?.targetFolders?.join(", ") ?? "");
    setExcludePatterns(setting?.excludePatterns?.join("\n") ?? "");
  }, [plugin, selectedRagSetting]);

  const handleRagSettingChange = (name: string) => {
    setSelectedRagSetting(name);
    const setting = plugin.getRagSetting(name);
    if (setting) {
      setTopK(setting.topK);
      setScoreThreshold(setting.minScore);
      setChunkSize(setting.chunkSize);
      setChunkOverlap(setting.chunkOverlap);
      setTargetFolders(setting.targetFolders?.join(", ") ?? "");
      setExcludePatterns(setting.excludePatterns?.join("\n") ?? "");
    }
  };

  // Handle RAG config field updates
  const handleChunkSizeChange = useCallback((value: number) => {
    setChunkSize(value);
    if (selectedRagSetting) {
      void plugin.updateRagSetting(selectedRagSetting, { chunkSize: value });
    }
  }, [plugin, selectedRagSetting]);

  const handleChunkOverlapChange = useCallback((value: number) => {
    setChunkOverlap(value);
    if (selectedRagSetting) {
      void plugin.updateRagSetting(selectedRagSetting, { chunkOverlap: value });
    }
  }, [plugin, selectedRagSetting]);

  const handleTargetFoldersChange = useCallback((value: string) => {
    setTargetFolders(value);
    if (selectedRagSetting) {
      const folders = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      void plugin.updateRagSetting(selectedRagSetting, { targetFolders: folders });
    }
  }, [plugin, selectedRagSetting]);

  const handleExcludePatternsChange = useCallback((value: string) => {
    setExcludePatterns(value);
    if (selectedRagSetting) {
      const patterns = value
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      void plugin.updateRagSetting(selectedRagSetting, { excludePatterns: patterns });
    }
  }, [plugin, selectedRagSetting]);

  // Load indexed files list
  const loadIndexedFiles = useCallback(async () => {
    const store = getRagStore();
    if (!selectedRagSetting) {
      setIndexedFiles([]);
      return;
    }
    const files = await store.getIndexedFiles(plugin.app, selectedRagSetting);
    setIndexedFiles(files);
  }, [plugin, selectedRagSetting]);

  // Load indexed files when config section is opened
  useEffect(() => {
    if (showRagConfig) {
      void loadIndexedFiles();
    }
  }, [showRagConfig, loadIndexedFiles]);

  // Handle RAG sync
  const handleRagSync = useCallback(async () => {
    if (ragSyncing) {
      ragSyncCancelRef.current = true;
      ragSyncAbortRef.current?.abort();
      return;
    }
    if (!selectedRagSetting) return;

    const ragSetting = plugin.getRagSetting(selectedRagSetting);
    if (!ragSetting) return;

    setRagSyncing(true);
    ragSyncCancelRef.current = false;
    const abortController = new AbortController();
    ragSyncAbortRef.current = abortController;

    try {
      const store = getRagStore();
      const result = await store.sync(
        plugin.app,
        selectedRagSetting,
        ragSetting,
        plugin.settings.llmConfig,
        abortController.signal,
      );
      if (!ragSyncCancelRef.current) {
        new Notice(t("settings.ragSynced", {
          count: String(result.totalChunks),
          files: String(result.indexedFiles),
        }));
        void plugin.updateRagSetting(selectedRagSetting, { lastFullSync: Date.now() });
        void loadIndexedFiles();
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        new Notice(t("settings.syncCancelled"));
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(t("settings.ragSyncFailed", { error: msg }));
    } finally {
      setRagSyncing(false);
      ragSyncCancelRef.current = false;
      ragSyncAbortRef.current = null;
    }
  }, [plugin, selectedRagSetting, ragSyncing, loadIndexedFiles]);

  const handleSearch = async () => {
    if (isSearching) return;
    if (!selectedRagSetting) {
      new Notice(t("search.noRagSetting"));
      return;
    }
    if (!query.trim()) {
      new Notice(t("search.enterQuery"));
      return;
    }

    const ragSetting = plugin.getRagSetting(selectedRagSetting);
    if (!ragSetting) {
      new Notice(t("search.ragSettingNotFound"));
      return;
    }

    const store = getRagStore();
    setIsSearching(true);
    setHasSearched(true);
    setResults([]);
    setSelectedIndices(new Set());
    setExpandedIndices(new Set());

    try {
      const overriddenSetting = { ...ragSetting, topK, minScore: scoreThreshold };
      const searchResults = await store.search(
        selectedRagSetting,
        query.trim(),
        overriddenSetting,
        plugin.settings.llmConfig,
        plugin.app,
      );
      setResults(searchResults);
    } catch (err) {
      new Notice(t("search.searchFailed") + ": " + (err instanceof Error ? err.message : String(err)));
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const toggleExpanded = (index: number) => {
    setExpandedIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const toggleSelection = (index: number) => {
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIndices.size === results.length) {
      setSelectedIndices(new Set());
    } else {
      setSelectedIndices(new Set(results.map((_, i) => i)));
    }
  };

  const handleChatWithSelected = () => {
    if (selectedIndices.size === 0) {
      new Notice(t("search.selectResults"));
      return;
    }

    const attachments: Attachment[] = [];

    for (const idx of Array.from(selectedIndices).sort((a, b) => a - b)) {
      const result = results[idx];
      if (!result) continue;

      const content = `[Source: ${result.filePath}] (relevance: ${result.score.toFixed(3)})\n\n${result.text}`;
      const fileName = result.filePath.split("/").pop() || result.filePath;
      attachments.push({
        name: fileName,
        type: "text",
        mimeType: "text/plain",
        data: btoa(unescape(encodeURIComponent(content))),
        sourcePath: result.filePath,
      });
    }

    onChatWithResults(attachments);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isSearching) void handleSearch();
    }
  };

  const openPluginSettings = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setting = (plugin.app as any).setting;
    setting?.open?.();
    setting?.openTabById?.(plugin.manifest.id);
  };

  if (ragSettingNames.length === 0) {
    return (
      <div className="llm-hub-search-panel">
        <div className="llm-hub-search-empty-state">
          <p>{t("search.noRagSettings")}</p>
          <p className="llm-hub-search-empty-guide">{t("search.noRagSettingsGuide")}</p>
          <button className="mod-cta" onClick={openPluginSettings}>
            {t("search.openSettings")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="llm-hub-search-panel">
      {/* Search input area */}
      <div className="llm-hub-search-input-area">
        <div className="llm-hub-search-rag-selector">
          <select
            value={selectedRagSetting}
            onChange={e => handleRagSettingChange(e.target.value)}
            className="llm-hub-model-select llm-hub-rag-select"
            disabled={isSearching || ragSyncing}
          >
            {ragSettingNames.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button
            className="llm-hub-rag-icon-btn"
            onClick={() => setShowRagConfig(!showRagConfig)}
            title={t("input.ragSettings")}
            disabled={ragSyncing}
          >
            <Settings2 size={14} />
          </button>
        </div>
        {showRagConfig && (
          <div className="llm-hub-rag-config-section">
            {isInternalRag && (
              <>
                <div className="llm-hub-rag-config-row">
                  <label>{t("input.ragChunkSize")}: {chunkSize}</label>
                  <input
                    type="range"
                    min={100}
                    max={2000}
                    step={50}
                    value={chunkSize}
                    onChange={e => handleChunkSizeChange(Number(e.target.value))}
                  />
                </div>
                <div className="llm-hub-rag-config-row">
                  <label>{t("input.ragChunkOverlap")}: {chunkOverlap}</label>
                  <input
                    type="range"
                    min={0}
                    max={500}
                    step={10}
                    value={chunkOverlap}
                    onChange={e => handleChunkOverlapChange(Number(e.target.value))}
                  />
                </div>
                <div className="llm-hub-rag-config-row">
                  <label>{t("input.ragTargetFolders")}</label>
                  <input
                    type="text"
                    className="llm-hub-rag-config-input"
                    placeholder={t("input.ragTargetFolders.placeholder")}
                    value={targetFolders}
                    onChange={e => handleTargetFoldersChange(e.target.value)}
                  />
                </div>
                <div className="llm-hub-rag-config-row">
                  <label>{t("input.ragExcludedPatterns")}</label>
                  <textarea
                    className="llm-hub-rag-config-textarea"
                    placeholder={t("input.ragExcludedPatterns.placeholder")}
                    value={excludePatterns}
                    rows={3}
                    onChange={e => handleExcludePatternsChange(e.target.value)}
                  />
                </div>
              </>
            )}
            {/* Last sync timestamp */}
            {currentRagSetting?.lastFullSync && (
              <div className="llm-hub-rag-last-sync">
                {t("input.ragLastSync")}: {new Date(currentRagSetting.lastFullSync).toLocaleString()}
              </div>
            )}
            {/* Indexed files accordion */}
            <div className="llm-hub-rag-indexed-files">
              <button
                className="llm-hub-rag-indexed-files-toggle"
                onClick={() => setShowIndexedFiles(!showIndexedFiles)}
              >
                <ChevronDown size={12} className={showIndexedFiles ? "llm-hub-chevron-rotated" : ""} />
                {t("input.ragIndexedFiles", { count: String(indexedFiles.length) })}
              </button>
              {showIndexedFiles && (
                <div className="llm-hub-rag-indexed-files-list">
                  {indexedFiles.length === 0 ? (
                    <div className="llm-hub-rag-indexed-files-empty">{t("input.ragNoIndexedFiles")}</div>
                  ) : (
                    indexedFiles.map(f => (
                      <div key={f.filePath} className="llm-hub-rag-indexed-file-item">
                        <span
                          className="llm-hub-rag-indexed-file-path"
                          onClick={() => {
                            const file = plugin.app.vault.getAbstractFileByPath(f.filePath);
                            if (file) {
                              void plugin.app.workspace.openLinkText(f.filePath, "", false);
                            } else {
                              new Notice(f.filePath, 5000);
                            }
                          }}
                        >
                          {f.filePath}
                        </span>
                        <span className="llm-hub-rag-indexed-file-chunks">
                          {f.chunks} chunks
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
            <div className="llm-hub-rag-config-actions">
              {isInternalRag && (
                <button
                  className={`llm-hub-rag-text-btn ${ragSyncing ? "syncing" : ""}`}
                  onClick={() => { void handleRagSync(); }}
                >
                  {ragSyncing ? (
                    <><Loader2 size={12} className="llm-hub-spinner" /> {t("settings.cancelSync")}</>
                  ) : (
                    <><RefreshCw size={12} /> {t("settings.ragSync")}</>
                  )}
                </button>
              )}
              <button
                className="llm-hub-rag-text-btn"
                onClick={() => setShowRagConfig(false)}
              >
                {t("input.close")}
              </button>
            </div>
          </div>
        )}
        <div className="llm-hub-search-params">
          <label className="llm-hub-search-param-label">
            Top K:
            <input
              type="number"
              min={1}
              max={50}
              value={topK}
              onChange={e => setTopK(Math.max(1, Math.min(50, parseInt(e.target.value) || 5)))}
              className="llm-hub-search-param-input"
            />
          </label>
          <label className="llm-hub-search-param-label">
            {t("search.scoreThreshold")}:
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={scoreThreshold}
              onChange={e => setScoreThreshold(Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)))}
              className="llm-hub-search-param-input"
            />
          </label>
        </div>
        <div className="llm-hub-search-query-row">
          <textarea
            className="llm-hub-search-query-input"
            placeholder={t("search.queryPlaceholder")}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
          />
          <button
            className="llm-hub-search-btn"
            onClick={() => void handleSearch()}
            disabled={isSearching || !selectedRagSetting}
            title={t("search.search")}
          >
            {isSearching ? (
              <Loader2 size={18} className="llm-hub-spinner" />
            ) : (
              <Search size={18} />
            )}
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="llm-hub-search-results">
        {hasSearched && results.length === 0 && !isSearching && (
          <div className="llm-hub-search-no-results">{t("search.noResults")}</div>
        )}
        {results.length > 0 && (
          <>
            <div className="llm-hub-search-results-header">
              <label className="llm-hub-search-select-all">
                <input
                  type="checkbox"
                  checked={selectedIndices.size === results.length}
                  onChange={toggleSelectAll}
                />
                {t("search.selectAll")} ({results.length} {t("search.results")})
              </label>
              <button
                className="llm-hub-search-chat-btn"
                onClick={handleChatWithSelected}
                disabled={selectedIndices.size === 0}
              >
                <MessageSquare size={14} />
                {t("search.chatWithSelected")} ({selectedIndices.size})
              </button>
            </div>
            {results.map((result, index) => (
              <div
                key={`${result.filePath}-${index}`}
                className={`llm-hub-search-result-item ${selectedIndices.has(index) ? "selected" : ""}`}
                onClick={() => toggleSelection(index)}
              >
                <div className="llm-hub-search-result-header">
                  <input
                    type="checkbox"
                    checked={selectedIndices.has(index)}
                    onChange={() => toggleSelection(index)}
                    onClick={e => e.stopPropagation()}
                  />
                  <FileText size={14} />
                  <span
                    className="llm-hub-search-result-path"
                    onClick={e => {
                      e.stopPropagation();
                      const file = plugin.app.vault.getAbstractFileByPath(result.filePath);
                      if (file) {
                        void plugin.app.workspace.openLinkText(result.filePath, "", false);
                      } else {
                        new Notice(result.filePath, 5000);
                      }
                    }}
                    title={result.filePath}
                  >
                    {result.filePath}
                  </span>
                  <span className="llm-hub-search-result-score">
                    {(result.score * 100).toFixed(1)}%
                  </span>
                </div>
                <div
                  className={`llm-hub-search-result-preview ${expandedIndices.has(index) ? "expanded" : ""}`}
                  onClick={e => { e.stopPropagation(); toggleExpanded(index); }}
                >
                  {expandedIndices.has(index) ? result.text : (
                    result.text.length > 300 ? result.text.slice(0, 300) + "..." : result.text
                  )}
                </div>
                {result.text.length > 300 && (
                  <button
                    className="llm-hub-search-result-toggle"
                    onClick={e => { e.stopPropagation(); toggleExpanded(index); }}
                  >
                    <ChevronDown size={14} className={expandedIndices.has(index) ? "llm-hub-chevron-rotated" : ""} />
                  </button>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
