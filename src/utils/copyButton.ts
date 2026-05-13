import { t } from "src/i18n";

/**
 * Append a Copy button that writes `getText()` to the clipboard and briefly
 * flashes a check mark. Used across the workflow generation modals where the
 * same pattern appeared inline 3+ times.
 *
 * `getText` is called lazily so callers can pass a live reference (e.g. the
 * current review text) rather than a snapshot captured at render time.
 */
export function createCopyButton(
  container: HTMLElement,
  getText: () => string,
  options: { cls?: string; label?: string } = {}
): HTMLButtonElement {
  const label = options.label ?? t("message.copy");
  const btn = container.createEl("button", {
    cls: options.cls ?? "llm-hub-workflow-generation-copy-btn",
    text: label,
  });
  btn.addEventListener("click", (e) => {
    // Copy buttons never want parent handlers (e.g. collapsible `<summary>`
    // toggles, click-to-comment diff rows) to fire as well.
    e.stopPropagation();
    e.preventDefault();
    void navigator.clipboard.writeText(getText()).then(() => {
      btn.textContent = "✓";
      window.setTimeout(() => { btn.textContent = label; }, 1200);
    });
  });
  return btn;
}
