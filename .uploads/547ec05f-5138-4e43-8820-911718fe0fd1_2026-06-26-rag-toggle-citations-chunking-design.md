# Design: RAG Toggle, Citation Locations, and Chunking Strategies

**Date:** 2026-06-26
**Repo:** https://github.com/liaoweichu/obsidian-local-llm-hub
**Status:** Approved (pending spec review)

This spec covers three improvements to the Local LLM Hub Obsidian plugin:

1. A RAG enable/disable checkbox in the chat input area (the existing RAG setting selector is preserved).
2. Showing the location of each RAG citation when the LLM references a vault document; multiple citations from the same document are displayed separately.
3. New RAG chunking strategies: split by Chinese/English sentence terminators, or by Obsidian blocks (a block is text wrapped by blank lines before and after).

---

## 1. RAG Toggle Checkbox

### Goal
Let the user keep a RAG setting selected but temporarily disable RAG for the chat, without clearing the selection. The existing RAG dropdown is retained unchanged.

### State
- New `ragEnabled: boolean` in `Chat.tsx`, held only in React state (session-level), mirroring how `currentModel` is managed.
- Initialized to `true` when a RAG setting is selected. Not persisted to disk (workspace-state.json is unchanged).
- Reset to `true` on plugin reload.

### UI — `src/ui/components/InputArea.tsx`
In the existing "Model & RAG selector" block (current lines 607–622), a checkbox is rendered **before** the RAG `<select>`:

```
[☑] RAG   [ my-setting ▾ ]
```

- New props on `InputAreaProps`: `ragEnabled: boolean`, `onRagToggle: (enabled: boolean) => void`.
- When `ragSettingNames.length === 0`, neither the checkbox nor the select renders (unchanged).
- When `ragEnabled === false`, the `<select>` remains enabled (the user may still change which setting is selected); only the checkbox is unchecked.

### Behavior — `src/ui/components/Chat.tsx`
The RAG search block (current lines 622–647) runs **only** when `selectedRagSetting && ragEnabled`:

```ts
let ragSources: string[] | undefined;
let ragCitations: RagCitation[] | undefined;
if (selectedRagSetting && ragEnabled) {
  // existing search logic, plus citation building (see Section 2)
}
```

When skipped, `ragUsed`, `ragSources`, and `ragCitations` are all `undefined` on the resulting message.

`ragEnabled` is added to the `useCallback` dependency array of the send handler (currently line 882).

### i18n
- `input.ragToggle` — checkbox label (e.g. `"RAG"`), tooltip `input.ragToggleTooltip`.

---

## 2. Citation Locations

### Goal
Show **where** in a document each cited chunk comes from, and show multiple chunks from the same document as separate citations (no deduplication).

### Current behavior
- `Chat.tsx` line 637: `ragSources = [...new Set(results.map(r => r.filePath))]` — dedupes file paths, collapsing multiple chunks from one file into a single chip.
- `MessageBubble.tsx` lines 146–167: renders filename chips; click calls `app.workspace.openLinkText(source, "", false)` — opens the file with no scroll/selection.
- `ChunkMeta` already stores `startOffset`; `findNearestHeading()` already computes the nearest Markdown heading; PDF chunks carry `pageLabel`. None of this is surfaced to the UI.

### Data model — `src/types/index.ts`

```ts
export interface RagCitation {
  filePath: string;
  heading?: string;      // nearest Markdown heading ("" when none)
  startOffset: number;   // chunk start offset in the source document
  snippet: string;       // first ~120 chars of the chunk (for tooltip/preview)
  pageLabel?: string;    // PDF page range, e.g. "pages 2-5 of 24"
}
```

`Message` gets a new optional field `ragCitations?: RagCitation[]`. The existing `ragSources?: string[]` is **kept** for backward compatibility with saved chat histories.

### RagStore — `src/core/ragStore.ts`
- Extend `RagSearchResult` with `heading?: string` and `startOffset: number`.
- In `search()` (lines 627–682), when building the returned `RagSearchResult[]`, populate `startOffset` from `index.meta[idx].startOffset` and `heading` via `findNearestHeading()`.

**Heading computation strategy (chosen): compute at search time.**
- For each returned result (topK ≤ ~5), `app.vault.cachedRead()` the source file, then call `findNearestHeading(content, startOffset)`.
- Rationale: avoids bloating/staling the index, needs no rebuild, and topK is small. `findNearestHeading` is already exported.
- PDFs have no Markdown headings → `heading` is omitted; `pageLabel` is used instead (already present on `RagSearchResult`).

### Chat.tsx injection — lines 636–640
- Stop deduplicating: build `ragCitations` from **every** result, preserving order.
- `ragSources` (back-compat) is still built from `[...new Set(results.map(r => r.filePath))]`.
- Inject the LLM context with location info so the model can cite precisely:
  ```
  [Source: filePath > heading]
  {chunk text}
  ```
  (omit `> heading` when none; for PDFs use `[Source: filePath (pageLabel)]`).

### MessageBubble display — `src/ui/components/MessageBubble.tsx` lines 146–167
- Render `message.ragCitations` if present; fall back to `message.ragSources` (string[]) for old saved chats, rendering one filename chip per entry (preserves current behavior).
- Each citation renders as a separate chip:
  - Markdown: `📃 note.md > 安装` (filename + ` > ` + heading). When heading is empty, just `📃 note.md`.
  - PDF: `📄 report.pdf (pages 2-5 of 24)`.
- Multiple chips from the same file appear separately (e.g. `note.md > 安装` and `note.md > 配置`).
- `title` attribute = `snippet` (truncated to ~120 chars) so hovering previews the chunk.
- **Click behavior — open file and scroll to the block:**
  1. `await app.workspace.openLinkText(filePath, "", false)` (or open in a new leaf if preferred — keep current behavior: same leaf).
  2. After open, locate the active Markdown view's `editor`.
  3. Find the target offset:
     - If `heading` is non-empty: `const idx = editor.getValue().indexOf("# heading-ish")` is fragile; instead search for the heading line via a regex over `editor.getValue()` matching `^#{1,6}\s+heading$`, take its line, fallback to `startOffset` line.
     - Otherwise: convert `startOffset` to a position via counting newlines up to `startOffset` in `editor.getValue()`.
  4. `editor.setCursor(pos); editor.scrollIntoView(range, true);`
  - A small helper `scrollEditorToOffset(app, filePath, heading, startOffset)` encapsulates this.
  - PDFs: Obsidian's PDF viewer does not reliably expose scroll-to-page; for PDF citations, clicking just opens the file (no scroll). The `pageLabel` is already shown in the chip text.

### Chat history serialization — `src/ui/components/chat/chatHistory.ts`
- `messageToMarkdown` (line 33): add `if (msg.ragCitations) metadata.ragCitations = msg.ragCitations;` next to the existing `ragSources` line.
- `parseMarkdownToMessages` (line 105): add `if (meta.ragCitations) message.ragCitations = meta.ragCitations as RagCitation[];`.
- Old histories that only have `ragSources` still parse and render filename chips (back-compat path in MessageBubble).

### i18n
- `message.ragUsed` — existing.
- `message.ragCitationOpen` — tooltip for citation chips (e.g. `"Click to open at location"`).
- `message.ragCitationPage` — pattern for PDF chip (already covered by `pageLabel` text; no new key strictly required, but a tooltip key is added).

---

## 3. Chunking Strategies

### Goal
Add RAG chunking strategies: split by sentence terminators (Chinese `。` / English `. `) or by Obsidian blocks (text wrapped by blank lines). The existing fixed-size strategy is preserved as the default.

### Data model — `src/types/index.ts`

```ts
export type ChunkStrategy = "fixed" | "sentence" | "block";

export interface RagSetting {
  // ...existing fields...
  chunkStrategy: ChunkStrategy;
}
```

- `DEFAULT_RAG_SETTING.chunkStrategy = "fixed"` (backward compatible).
- `RagConfig` (legacy migration shape) is unchanged; migration treats missing `chunkStrategy` as `"fixed"`.

### RagIndex — `src/core/ragStorage.ts`
- Add `chunkStrategy: ChunkStrategy` to `RagIndex`.
- Trigger a full rebuild when the strategy changes, mirroring the existing chunkSize/chunkOverlap check at `ragStore.ts` lines 243–247:
  ```ts
  const needsFullRebuild = !incompatible && index !== null && (
    index.chunkSize !== ragSetting.chunkSize ||
    index.chunkOverlap !== ragSetting.chunkOverlap ||
    index.chunkStrategy !== (ragSetting.chunkStrategy ?? "fixed")
  );
  ```
- `mergeLoadedIndexes` (source/external bundles) keeps the first strategy (bundles are assumed to share strategy; if mixed, the merged index simply uses the first — acceptable for read-only bundles).

### Chunking functions — `src/core/ragStore.ts`

Keep the existing `chunkText()` as the `"fixed"` strategy. Add:

**`chunkBySentence(text, chunkSize, chunkOverlap)`**
- Split on terminators: `[。\.]\s*` (Chinese `。`, English `. ` followed by optional whitespace).
- Accumulate sentences into a chunk until adding the next sentence would exceed `chunkSize`; emit the accumulated chunk.
- Overlap: carry the trailing `chunkOverlap` characters (or last sentence) into the next chunk to preserve context.
- Each chunk records its `startOffset`.
- Handles content with no terminators (falls back to a single chunk up to `chunkSize`).

**`chunkByBlock(text, chunkSize, chunkOverlap)`** — "大块切分 + 小块合并" (chosen):
- Split into blocks on `/\n\s*\n/` (Obsidian block = blank-line-delimited). Track each block's `startOffset`.
- **Large block** (length > `chunkSize`): re-chunk that block with `chunkBySentence()` (fallback to `chunkText()` if the block has no sentence terminators). The sub-chunks inherit offsets relative to the original text.
- **Small blocks**: greedily accumulate consecutive blocks into one chunk until adding the next block would exceed `chunkSize`; emit the accumulated chunk. Respects block boundaries — never merges content across a blank-line boundary beyond the size budget (i.e. a block is never split to merge with a *different* logical block's interior; only whole blocks are concatenated with `\n\n`).
- Each emitted chunk records its `startOffset`.

A dispatcher selects the function:
```ts
function chunkContent(content, ragSetting): { text; startOffset }[] {
  switch (ragSetting.chunkStrategy ?? "fixed") {
    case "sentence": return chunkBySentence(content, ragSetting.chunkSize, ragSetting.chunkOverlap);
    case "block":    return chunkByBlock(content, ragSetting.chunkSize, ragSetting.chunkOverlap);
    default:         return chunkText(content, ragSetting.chunkSize, ragSetting.chunkOverlap);
  }
}
```
Both `sync()` (line 378) and `syncFile()` (line 557) call `chunkContent()` instead of `chunkText()` directly.

### Settings UI — `src/ui/settings/ragSettings.ts`
- Add a `chunkStrategy` dropdown **above** the chunk-size setting (current lines 361–395), with three options: `Fixed size`, `By sentence`, `By block`.
- The existing `chunkSize` / `chunkOverlap` inputs remain visible for all strategies; they act as the target/maximum size (sentence grouping limit; block merge limit; large-block split threshold).
- A desc note clarifies: for `block`/`sentence`, chunk size is the target/maximum, not a hard fixed size.
- `updateSetting({ chunkStrategy })` triggers the normal rebuild-on-change flow.

### i18n
- `settings.ragChunkStrategy` — setting name.
- `settings.ragChunkStrategyDesc`.
- `settings.ragChunkStrategyFixed` / `…Sentence` / `…Block` — option labels.
- `settings.ragChunkStrategyFixedDesc` / `…SentenceDesc` / `…BlockDesc` — short descriptions.

---

## Architecture Summary

| Area | Files touched | Notes |
|------|---------------|-------|
| Types | `src/types/index.ts` | `ChunkStrategy`, `RagCitation`, `Message.ragCitations`, `RagSetting.chunkStrategy` |
| RAG store | `src/core/ragStore.ts`, `src/core/ragStorage.ts` | `RagSearchResult` extension, new chunkers, rebuild trigger |
| Chat | `src/ui/components/Chat.tsx` | `ragEnabled` state, citation building, conditional search |
| Input | `src/ui/components/InputArea.tsx` | RAG checkbox |
| Citations | `src/ui/components/MessageBubble.tsx` | rich chips, click-to-scroll helper |
| History | `src/ui/components/chat/chatHistory.ts` | serialize/parse `ragCitations` |
| Settings | `src/ui/settings/ragSettings.ts` | strategy dropdown |
| i18n | `src/i18n/en.ts`, `src/i18n/ja.ts` | new strings |

### Error handling
- `findNearestHeading` / offset lookup failures degrade gracefully: chip shows filename only, click opens the file without scrolling.
- Chunking functions never throw on empty/degenerate input (return `[]` or a single chunk).
- `scrollEditorToOffset` is wrapped in try/catch; a failure to scroll still opens the file.

### Testing
- New unit tests in `src/core/ragStore.test.ts` (or a sibling `chunkStrategies.test.ts`):
  - `chunkBySentence`: English `.` and Chinese `。` splits; grouping under `chunkSize`; overlap; no-terminator fallback.
  - `chunkByBlock`: blank-line splitting; large-block re-split; small-block merge up to `chunkSize`; offset correctness; empty input.
  - Dispatcher returns `chunkText` output unchanged for `"fixed"`.
- Update any test asserting the `RagSearchResult` shape to include the new `heading`/`startOffset` fields if it does a strict equality check.
- Back-compat check: a `Message` with only `ragSources` renders filename chips.

### Out of scope
- Per-message (non-persistent) RAG toggle reset — explicitly session-level.
- Inline `[1][2]` footnote references in the assistant text.
- PDF scroll-to-page on citation click (PDF viewer limitation).
- Re-embedding existing indexes automatically on strategy change — the existing rebuild-on-change flow handles this; no separate migration.
