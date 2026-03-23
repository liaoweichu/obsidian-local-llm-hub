import { Setting, Notice, Modal } from "obsidian";
import { t } from "src/i18n";
import type { LocalLlmHubPlugin } from "src/plugin";
import type { RagSetting } from "src/types";
import { DEFAULT_RAG_SETTING } from "src/types";
import { getRagStore } from "src/core/ragStore";
import { deleteRagIndex } from "src/core/ragStorage";
import { fetchEmbeddingModels } from "src/core/localLlmProvider";
import { RagSettingNameModal } from "./RagSettingNameModal";

interface SettingsContext {
  plugin: LocalLlmHubPlugin;
  display: () => void;
}

export function displayRagSettings(containerEl: HTMLElement, ctx: SettingsContext): void {
  const { plugin, display } = ctx;

  new Setting(containerEl).setName(t("settings.rag")).setHeading();

  // --- Setting selector dropdown + create button ---
  const settingNames = plugin.getRagSettingNames();
  const selectedName = plugin.getSelectedRagSettingName();

  const selectorSetting = new Setting(containerEl)
    .setName(t("settings.ragSetting"))
    .setDesc(t("settings.ragSettingDesc"));

  selectorSetting.controlEl.createEl("select", {}, (select) => {
    select.addClass("dropdown");

    // "None" option
    const noneOpt = select.createEl("option", { text: t("settings.ragNone"), value: "" });
    if (!selectedName) noneOpt.selected = true;

    for (const name of settingNames) {
      const opt = select.createEl("option", { text: name, value: name });
      if (name === selectedName) opt.selected = true;
    }

    select.addEventListener("change", () => {
      void (async () => {
        await plugin.selectRagSetting(select.value || null);
        display();
      })();
    });
  });

  // Create button
  selectorSetting.addExtraButton((btn) =>
    btn
      .setIcon("plus")
      .setTooltip(t("settings.createRagSetting"))
      .onClick(() => {
        new RagSettingNameModal(
          plugin.app,
          t("settings.createRagSetting"),
          "",
          async (name) => {
            try {
              await plugin.createRagSetting(name);
              await plugin.selectRagSetting(name);
              new Notice(t("settings.ragSettingCreated", { name }));
              display();
            } catch (err) {
              new Notice(err instanceof Error ? err.message : String(err));
            }
          }
        ).open();
      })
  );

  // --- Selected setting detail ---
  if (!selectedName) return;

  const ragSetting = plugin.getRagSetting(selectedName);
  if (!ragSetting) return;

  displaySelectedRagSetting(containerEl, ctx, selectedName, ragSetting);
}

function displaySelectedRagSetting(
  containerEl: HTMLElement,
  ctx: SettingsContext,
  name: string,
  ragSetting: RagSetting,
): void {
  const { plugin, display } = ctx;
  const isExternal = !!ragSetting.externalIndexPath;

  const updateSetting = async (updates: Partial<RagSetting>) => {
    await plugin.updateRagSetting(name, updates);
  };

  // Header with rename + delete
  const headerSetting = new Setting(containerEl)
    .setName(t("settings.settingsFor", { name }))
    .setHeading();

  headerSetting.addExtraButton((btn) =>
    btn
      .setIcon("pencil")
      .setTooltip(t("settings.renameSetting"))
      .onClick(() => {
        new RagSettingNameModal(
          plugin.app,
          t("settings.renameSetting"),
          name,
          async (newName) => {
            try {
              await plugin.renameRagSetting(name, newName);
              new Notice(t("settings.renamedTo", { name: newName }));
              display();
            } catch (err) {
              new Notice(err instanceof Error ? err.message : String(err));
            }
          }
        ).open();
      })
  );

  headerSetting.addExtraButton((btn) =>
    btn
      .setIcon("trash")
      .setTooltip(t("settings.deleteSetting"))
      .onClick(() => {
        const modal = new Modal(plugin.app);
        modal.titleEl.setText(t("settings.deleteSetting"));
        modal.contentEl.createEl("p", { text: t("settings.deleteSettingConfirm", { name }) });
        new Setting(modal.contentEl)
          .addButton((cancelBtn) =>
            cancelBtn.setButtonText("Cancel").onClick(() => modal.close())
          )
          .addButton((confirmBtn) =>
            confirmBtn
              .setButtonText("Delete")
              .setWarning()
              .onClick(async () => {
                modal.close();
                await deleteRagIndex(plugin.app, name);
                await plugin.deleteRagSetting(name);
                new Notice(t("settings.ragSettingDeleted", { name }));
                display();
              })
          );
        modal.open();
      })
  );

  // External index toggle
  new Setting(containerEl)
    .setName(t("settings.ragExternalIndex"))
    .setDesc(t("settings.ragExternalIndexDesc"))
    .addToggle((toggle) =>
      toggle.setValue(isExternal).onChange((value) => {
        void (async () => {
          await updateSetting({ externalIndexPath: value ? " " : "" });
          getRagStore().setExternalPath(name, value ? " " : "");
          display();
        })();
      })
    );

  if (isExternal) {
    // External index path
    new Setting(containerEl)
      .setName(t("settings.ragExternalIndexPath"))
      .setDesc(t("settings.ragExternalIndexPathDesc"))
      .addText((text) => {
        text
          .setPlaceholder(t("settings.ragExternalIndexPathPlaceholder"))
          .setValue(ragSetting.externalIndexPath.trim())
          .onChange((value) => {
            void (async () => {
              const path = value.trim() || " "; // keep toggle on
              await updateSetting({ externalIndexPath: path });
              getRagStore().setExternalPath(name, path);
            })().catch((err) => new Notice(String(err)));
          });
        text.inputEl.addClass("llm-hub-wide-input");
      });
  }

  // Embedding server URL
  new Setting(containerEl)
    .setName(t("settings.ragEmbeddingBaseUrl"))
    .setDesc(t("settings.ragEmbeddingBaseUrlDesc"))
    .addText((text) => {
      text
        // eslint-disable-next-line obsidianmd/ui/sentence-case
        .setPlaceholder("http://localhost:8001")
        .setValue(ragSetting.embeddingBaseUrl || "")
        .onChange((value) => {
          void updateSetting({ embeddingBaseUrl: value.trim() }).catch((err) => new Notice(String(err)));
        });
      text.inputEl.addClass("llm-hub-wide-input");
    });

  // Embedding model
  const embeddingModelSetting = new Setting(containerEl)
    .setName(t("settings.ragEmbeddingModel"))
    .setDesc(t("settings.ragEmbeddingModelDesc"));

  let embeddingDropdown: HTMLSelectElement | null = null;
  embeddingModelSetting.controlEl.createEl("select", {}, (select) => {
    embeddingDropdown = select;
    select.addClass("dropdown");
    if (!ragSetting.embeddingModel) {
      const placeholder = select.createEl("option", { text: t("settings.ragEmbeddingModelPlaceholder"), value: "" });
      placeholder.disabled = true;
      placeholder.selected = true;
    } else {
      const opt = select.createEl("option", { text: ragSetting.embeddingModel, value: ragSetting.embeddingModel });
      opt.selected = true;
    }
    select.addEventListener("change", () => {
      void updateSetting({ embeddingModel: select.value }).catch((err) => new Notice(String(err)));
    });
  });

  embeddingModelSetting.addButton((btn) =>
    btn
      .setButtonText(t("settings.llmModal.fetchModels"))
      .onClick(async () => {
        btn.setButtonText(t("settings.llmModal.fetching"));
        btn.setDisabled(true);
        try {
          const models = await fetchEmbeddingModels(plugin.settings.llmConfig, ragSetting.embeddingBaseUrl || undefined);
          if (models.length === 0) {
            new Notice(t("settings.llmModal.noModelsFound"));
            return;
          }
          if (embeddingDropdown) {
            embeddingDropdown.empty();
            for (const model of models) {
              const opt = embeddingDropdown.createEl("option", { text: model, value: model });
              if (model === ragSetting.embeddingModel) {
                opt.selected = true;
              }
            }
            if (!ragSetting.embeddingModel || !models.includes(ragSetting.embeddingModel)) {
              await updateSetting({ embeddingModel: models[0] });
              embeddingDropdown.value = models[0];
            }
          }
          new Notice(t("settings.llmModal.modelsLoaded", { count: String(models.length) }));
        } catch (err) {
          new Notice(`Error: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          btn.setButtonText(t("settings.llmModal.fetchModels"));
          btn.setDisabled(false);
        }
      })
  );

  if (!isExternal) {
    // Target folders (vault sync only)
    new Setting(containerEl)
      .setName(t("settings.ragTargetFolders"))
      .setDesc(t("settings.ragTargetFoldersDesc"))
      .addText((text) => {
        text
          .setValue(ragSetting.targetFolders.join(", "))
          .onChange((value) => {
            const folders = value.split(",").map(s => s.trim()).filter(Boolean);
            void updateSetting({ targetFolders: folders }).catch((err) => new Notice(String(err)));
          });
        text.inputEl.addClass("llm-hub-wide-input");
      });

    // Exclude patterns (vault sync only)
    new Setting(containerEl)
      .setName(t("settings.ragExcludePatterns"))
      .setDesc(t("settings.ragExcludePatternsDesc"))
      .addText((text) => {
        text
          .setValue(ragSetting.excludePatterns.join(", "))
          .onChange((value) => {
            const patterns = value.split(",").map(s => s.trim()).filter(Boolean);
            void updateSetting({ excludePatterns: patterns }).catch((err) => new Notice(String(err)));
          });
        text.inputEl.addClass("llm-hub-wide-input");
      });

    // Chunk size (vault sync only)
    new Setting(containerEl)
      .setName(t("settings.ragChunkSize"))
      .setDesc(t("settings.ragChunkSizeDesc"))
      .addText((text) => {
        text
          .setValue(String(ragSetting.chunkSize))
          .onChange((value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) {
              void updateSetting({ chunkSize: num }).catch((err) => new Notice(String(err)));
            }
          });
        text.inputEl.type = "number";
        text.inputEl.min = "100";
        text.inputEl.step = "100";
      });

    // Chunk overlap (vault sync only)
    new Setting(containerEl)
      .setName(t("settings.ragChunkOverlap"))
      .setDesc(t("settings.ragChunkOverlapDesc"))
      .addText((text) => {
        text
          .setValue(String(ragSetting.chunkOverlap))
          .onChange((value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              void updateSetting({ chunkOverlap: num }).catch((err) => new Notice(String(err)));
            }
          });
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.inputEl.step = "50";
      });
  }

  // Top K
  new Setting(containerEl)
    .setName(t("settings.ragTopK"))
    .setDesc(t("settings.ragTopKDesc"))
    .addText((text) => {
      text
        .setValue(String(ragSetting.topK))
        .onChange((value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num > 0) {
            void updateSetting({ topK: num }).catch((err) => new Notice(String(err)));
          }
        });
      text.inputEl.type = "number";
      text.inputEl.min = "1";
      text.inputEl.max = "20";
      text.inputEl.step = "1";
    });

  // Min score (slider)
  const currentMinScore = ragSetting.minScore ?? DEFAULT_RAG_SETTING.minScore;
  new Setting(containerEl)
    .setName(t("settings.ragMinScore"))
    .setDesc(t("settings.ragMinScoreDesc"))
    .addSlider((slider) => {
      slider
        .setLimits(0, 10, 1)
        .setValue(Math.round(currentMinScore * 10))
        .setDynamicTooltip()
        .onChange((value) => {
          void updateSetting({ minScore: value / 10 }).catch((err) => new Notice(String(err)));
        });
      const tooltipEl = slider.sliderEl.nextElementSibling;
      if (tooltipEl) {
        const updateTooltip = () => { tooltipEl.textContent = (slider.getValue() / 10).toFixed(1); };
        updateTooltip();
        slider.sliderEl.addEventListener("input", updateTooltip);
      }
    })
    .addExtraButton((button) =>
      button
        .setIcon("reset")
        .setTooltip("Reset to default (0.3)")
        .onClick(() => {
          void (async () => {
            await updateSetting({ minScore: DEFAULT_RAG_SETTING.minScore });
            display();
          })();
        })
    );

  // Status display
  const store = getRagStore();
  store.setExternalPath(name, ragSetting.externalIndexPath);
  const statusSetting = new Setting(containerEl);

  const updateStatusDesc = () => {
    const status = store.getStatus(name);
    if (status.totalChunks > 0) {
      const desc = isExternal
        ? `${t("settings.ragExternalActive")} — ${t("settings.ragStatus", { chunks: String(status.totalChunks), files: String(status.indexedFiles) })}`
        : t("settings.ragStatus", { chunks: String(status.totalChunks), files: String(status.indexedFiles) });
      statusSetting.setDesc(desc);
    } else {
      statusSetting.setDesc(isExternal ? t("settings.ragExternalActive") : t("settings.ragNoIndex"));
    }
  };

  updateStatusDesc();
  void store.load(plugin.app, [name], { [name]: ragSetting }).then(updateStatusDesc);

  if (!isExternal) {
    // Sync button (vault sync only)
    statusSetting.addButton((btn) =>
      btn
        .setButtonText(t("settings.ragSync"))
        .setCta()
        .onClick(async () => {
          btn.setButtonText(t("settings.ragSyncing"));
          btn.setDisabled(true);
          try {
            const result = await store.sync(
              plugin.app,
              name,
              ragSetting,
              plugin.settings.llmConfig,
            );
            new Notice(t("settings.ragSynced", {
              count: String(result.totalChunks),
              files: String(result.indexedFiles),
            }));
            display();
          } catch (err) {
            new Notice(t("settings.ragSyncFailed", {
              error: err instanceof Error ? err.message : String(err),
            }));
          } finally {
            btn.setButtonText(t("settings.ragSync"));
            btn.setDisabled(false);
          }
        })
    );

    // Clear button (vault sync only)
    statusSetting.addButton((btn) =>
      btn
        .setButtonText(t("settings.ragClear"))
        .onClick(async () => {
          await store.clear(plugin.app, name);
          new Notice(t("settings.ragCleared"));
          display();
        })
    );
  }
}
