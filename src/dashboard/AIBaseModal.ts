// AI dialog for creating or editing a `.base` file. Collects a description,
// generates the YAML via generateBaseYaml (which can inspect notes with
// read-only tools using the configured local LLM). Create mode writes straight
// to the vault; modify mode shows a diff of the generated YAML vs the current
// `.base` and lets the user apply it or refine with an extra instruction before
// writing.

import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import type { LocalLlmHubPlugin } from "src/plugin";
import { t } from "src/i18n";
import { renderDiffView, createDiffViewToggle, type DiffRendererState } from "src/ui/components/workflow/DiffRenderer";
import { generateBaseYaml } from "./aiBaseGenerate";
import { ensureVaultFolder } from "./dashboardFile";
import { BASES_FOLDER } from "./types";

export type AIBaseMode = "create" | "modify";

interface AIBaseModalOptions {
  mode: AIBaseMode;
  /** For modify: existing `.base` vault path. */
  basePath?: string;
  /** Called with the written `.base` path on success. */
  onComplete: (path: string) => void;
}

export class AIBaseModal extends Modal {
  private plugin: LocalLlmHubPlugin;
  private opts: AIBaseModalOptions;
  private nameInput: HTMLInputElement | null = null;
  private descInput: HTMLTextAreaElement | null = null;
  private generateBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private busy = false;
  private diffState: DiffRendererState | null = null;

  constructor(app: App, plugin: LocalLlmHubPlugin, opts: AIBaseModalOptions) {
    super(app);
    this.plugin = plugin;
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("llm-hub-db-ai-modal");

    contentEl.createEl("h3", {
      text: this.opts.mode === "create" ? t("dashboard.aiBaseCreate") : t("dashboard.aiBaseEdit"),
    });

    if (this.opts.mode === "create") {
      const nameRow = contentEl.createDiv({ cls: "llm-hub-db-ai-row" });
      nameRow.createEl("label", { text: t("dashboard.aiBaseName") });
      this.nameInput = nameRow.createEl("input", {
        type: "text",
        attr: { placeholder: "Tasks" },
      });
    } else {
      contentEl.createEl("p", {
        cls: "llm-hub-db-ai-target",
        text: this.opts.basePath ?? "",
      });
    }

    const descRow = contentEl.createDiv({ cls: "llm-hub-db-ai-row" });
    descRow.createEl("label", { text: t("dashboard.aiBaseDescribe") });
    this.descInput = descRow.createEl("textarea", {
      attr: {
        rows: "5",
        placeholder: t("dashboard.aiBaseDescribePlaceholder"),
      },
    });

    const model = this.plugin.settings.llmConfig.model;
    const modelRow = contentEl.createDiv({ cls: "llm-hub-db-ai-row" });
    modelRow.createEl("label", { text: t("aiWorkflow.model") });
    modelRow.createEl("span", { text: model || t("dashboard.aiNoModels") });

    this.statusEl = contentEl.createDiv({ cls: "llm-hub-db-ai-status" });

    const footer = contentEl.createDiv({ cls: "llm-hub-db-ai-footer" });
    const cancelBtn = footer.createEl("button", { text: t("dashboard.cancel") });
    cancelBtn.addEventListener("click", () => this.close());

    this.generateBtn = footer.createEl("button", { cls: "mod-cta" });
    const icon = this.generateBtn.createSpan();
    setIcon(icon, "sparkles");
    this.generateBtn.createSpan({ text: t("dashboard.aiBaseGenerate") });
    this.generateBtn.addEventListener("click", () => void this.run());
  }

  private setStatus(text: string, isError = false): void {
    if (!this.statusEl) return;
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-error", isError);
  }

  private async run(): Promise<void> {
    if (this.busy) return;
    const desc = this.descInput?.value.trim() ?? "";

    if (!this.plugin.settings.llmConfig.model) {
      this.setStatus(t("dashboard.aiNoModels"), true);
      return;
    }
    if (!desc) {
      this.setStatus(t("dashboard.aiBaseDescribeRequired"), true);
      return;
    }

    let targetPath: string;
    let currentYaml: string | undefined;
    if (this.opts.mode === "create") {
      const name = (this.nameInput?.value.trim() ?? "").replace(/\.base$/i, "");
      if (!name) {
        this.setStatus(t("dashboard.aiBaseNameRequired"), true);
        return;
      }
      targetPath = `${BASES_FOLDER}/${name}.base`;
      if (this.app.vault.getAbstractFileByPath(targetPath)) {
        this.setStatus(t("dashboard.aiBaseExists"), true);
        return;
      }
    } else {
      targetPath = this.opts.basePath ?? "";
      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) currentYaml = await this.app.vault.read(existing);
    }

    this.busy = true;
    if (this.generateBtn) this.generateBtn.disabled = true;
    this.setStatus(t("dashboard.aiBaseGenerating"));

    try {
      const yaml = await generateBaseYaml(this.plugin, desc, currentYaml);
      if (this.opts.mode === "modify") {
        this.showDiffConfirm(targetPath, currentYaml ?? "", yaml);
      } else {
        await this.writeBase(targetPath, yaml);
        new Notice(t("dashboard.aiBaseDone"));
        this.opts.onComplete(targetPath);
        this.close();
      }
    } catch (err) {
      this.setStatus(`${t("dashboard.aiBaseFailed")}: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      this.busy = false;
      if (this.generateBtn) this.generateBtn.disabled = false;
    }
  }

  private showDiffConfirm(
    targetPath: string,
    originalYaml: string,
    generatedYaml: string,
  ): void {
    let latest = generatedYaml;
    const { contentEl } = this;
    this.diffState?.destroy();
    this.diffState = null;
    contentEl.empty();
    contentEl.addClass("llm-hub-db-ai-modal");

    contentEl.createEl("h3", { text: t("dashboard.aiBaseEdit") });
    contentEl.createEl("p", { cls: "llm-hub-db-ai-target", text: targetPath });

    const diffLabel = contentEl.createDiv({ cls: "llm-hub-db-ai-difflabel" });
    const diffContainer = contentEl.createDiv({ cls: "llm-hub-db-ai-diff" });

    const renderDiff = (newYaml: string): void => {
      this.diffState?.destroy();
      diffContainer.empty();
      diffLabel.empty();
      diffLabel.createSpan({ text: t("dashboard.aiBaseDiffTitle") });
      this.diffState = renderDiffView(diffContainer, originalYaml, newYaml, { viewMode: "split" });
      createDiffViewToggle(diffLabel, this.diffState);
    };
    renderDiff(latest);

    const addRow = contentEl.createDiv({ cls: "llm-hub-db-ai-row" });
    addRow.createEl("label", { text: t("dashboard.aiBaseAdditional") });
    const addInput = addRow.createEl("textarea", {
      attr: { rows: "3", placeholder: t("dashboard.aiBaseAdditionalPlaceholder") },
    });

    const status = contentEl.createDiv({ cls: "llm-hub-db-ai-status" });
    const setDiffStatus = (text: string, isError = false): void => {
      status.setText(text);
      status.toggleClass("is-error", isError);
    };

    const footer = contentEl.createDiv({ cls: "llm-hub-db-ai-footer" });
    const cancelBtn = footer.createEl("button", { text: t("dashboard.cancel") });
    cancelBtn.addEventListener("click", () => this.close());

    const regenBtn = footer.createEl("button");
    const regenIcon = regenBtn.createSpan();
    setIcon(regenIcon, "refresh-cw");
    regenBtn.createSpan({ text: t("dashboard.aiBaseRegenerate") });

    const applyBtn = footer.createEl("button", { cls: "mod-cta", text: t("dashboard.aiBaseApply") });

    const setBusy = (busy: boolean): void => {
      this.busy = busy;
      regenBtn.disabled = busy;
      applyBtn.disabled = busy;
    };

    regenBtn.addEventListener("click", () => {
      void (async () => {
        const add = addInput.value.trim();
        if (!add || this.busy) return;
        setBusy(true);
        setDiffStatus(t("dashboard.aiBaseGenerating"));
        try {
          latest = await generateBaseYaml(this.plugin, add, latest);
          addInput.value = "";
          renderDiff(latest);
          setDiffStatus("");
        } catch (err) {
          setDiffStatus(`${t("dashboard.aiBaseFailed")}: ${err instanceof Error ? err.message : String(err)}`, true);
        } finally {
          setBusy(false);
        }
      })();
    });

    applyBtn.addEventListener("click", () => {
      void (async () => {
        if (this.busy) return;
        setBusy(true);
        try {
          await this.writeBase(targetPath, latest);
          new Notice(t("dashboard.aiBaseDone"));
          this.opts.onComplete(targetPath);
          this.close();
        } catch (err) {
          setDiffStatus(`${t("dashboard.aiBaseFailed")}: ${err instanceof Error ? err.message : String(err)}`, true);
          setBusy(false);
        }
      })();
    });
  }

  private async writeBase(path: string, yaml: string): Promise<void> {
    const { vault } = this.app;
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    await ensureVaultFolder(vault, folder);
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await vault.modify(existing, yaml);
    } else {
      await vault.create(path, yaml);
    }
  }

  onClose(): void {
    this.diffState?.destroy();
    this.diffState = null;
    this.contentEl.empty();
  }
}
