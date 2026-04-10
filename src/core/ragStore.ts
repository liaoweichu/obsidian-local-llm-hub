/**
 * RAG Store
 * Manages chunking, embedding, indexing, and searching of vault notes.
 * Supports multiple named RAG settings, each with its own index.
 */

import { type App, TFile, loadPdfJs } from "obsidian";
import type { LocalLlmConfig, RagSetting } from "../types";
import { WORKSPACE_FOLDER } from "../types";
import { generateEmbeddings, generateEmbedding } from "./embeddingProvider";
import {
  saveRagIndex,
  loadRagIndex,
  loadRagVectors,
  deleteRagIndex,
  loadExternalRagIndex,
  loadExternalRagVectors,
  type RagIndex,
  type ChunkMeta,
} from "./ragStorage";

const EMBEDDING_FORMAT_VERSION = 2;

export interface SyncResult {
  totalChunks: number;
  indexedFiles: number;
}

export interface RagSyncProgress {
  current: number;
  total: number;
  filePath: string;
}

export interface RagSearchResult {
  text: string;
  filePath: string;
  score: number;
  contentType?: string; // "pdf" for PDF-origin chunks
  pageLabel?: string;   // PDF page range (e.g. "pages 1-6 of 24")
}

export interface RagStatus {
  totalChunks: number;
  indexedFiles: number;
}

function createAbortError(): Error {
  const error = new Error("Sync aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

interface StoreEntry {
  index: RagIndex | null;
  vectors: Float32Array | null;
  loaded: boolean;
  incompatibleIndexLoaded: boolean;
}

interface LoadOptions {
  externalIndexPath?: string;
}

class RagStore {
  private entries = new Map<string, StoreEntry>();
  private externalPaths = new Map<string, string>();

  async load(app: App, settingNames: string[], ragSettings?: Record<string, RagSetting>): Promise<void> {
    if (ragSettings) {
      for (const [name, setting] of Object.entries(ragSettings)) {
        if (setting.externalIndexPath) {
          this.externalPaths.set(name, setting.externalIndexPath);
        }
      }
    }
    for (const name of settingNames) {
      await this.ensureLoaded(app, name, { externalIndexPath: ragSettings?.[name]?.externalIndexPath });
    }
  }

  setExternalPath(settingName: string, externalPath: string): void {
    if (externalPath) {
      this.externalPaths.set(settingName, externalPath);
    } else {
      this.externalPaths.delete(settingName);
    }
    // Invalidate cache so next access reloads
    this.entries.delete(settingName);
  }

  invalidateEntry(settingName: string): void {
    this.entries.delete(settingName);
    this.externalPaths.delete(settingName);
  }

  getStatus(settingName: string): RagStatus {
    const entry = this.entries.get(settingName);
    if (!entry?.index) {
      return { totalChunks: 0, indexedFiles: 0 };
    }
    return {
      totalChunks: entry.index.meta.length,
      indexedFiles: entry.index.fileChecksums ? Object.keys(entry.index.fileChecksums).length : 0,
    };
  }

  isExternal(settingName: string): boolean {
    return this.externalPaths.has(settingName);
  }

  /**
   * Sync vault notes into the RAG index for a named setting
   */
  async sync(
    app: App,
    settingName: string,
    ragSetting: RagSetting,
    llmConfig: LocalLlmConfig,
    signal?: AbortSignal,
    onProgress?: (progress: RagSyncProgress) => void,
  ): Promise<SyncResult> {
    // Get markdown files matching target/exclude criteria
    const files = getTargetFiles(app, ragSetting);
    const totalFiles = files.length;

    // Compute checksums for all files
    const newChecksums: Record<string, string> = {};
    const fileContents = new Map<string, string>();
    const pdfInfoMap = new Map<string, PdfExtractResult>();
    const pdfExtractFailed = new Set<string>();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      throwIfAborted(signal);
      onProgress?.({
        current: i + 1,
        total: totalFiles,
        filePath: file.path,
      });
      if (file.extension === "pdf") {
        let result: PdfExtractResult | null;
        try {
          result = await extractPdfText(app, file);
        } catch (err) {
          // Extraction failed — mark for preserving old chunks later
          console.warn(`Local LLM Hub: PDF extraction failed for ${file.path}:`, err);
          pdfExtractFailed.add(file.path);
          continue;
        }
        if (!result) continue; // skip PDFs with no extractable text
        const checksum = simpleChecksum(result.text);
        newChecksums[file.path] = checksum;
        fileContents.set(file.path, result.text);
        pdfInfoMap.set(file.path, result);
      } else {
        const content = await app.vault.cachedRead(file);
        const checksum = simpleChecksum(content);
        newChecksums[file.path] = checksum;
        fileContents.set(file.path, content);
      }
    }

    // Force fresh load
    this.entries.delete(settingName);
    const entry = await this.ensureLoaded(app, settingName, {
      externalIndexPath: ragSetting.externalIndexPath,
    });
    let { index, vectors } = entry;
    const incompatible = entry.incompatibleIndexLoaded;

    // Check if chunk params changed → full rebuild needed
    const needsFullRebuild = !incompatible && index !== null && (
      index.chunkSize !== ragSetting.chunkSize ||
      index.chunkOverlap !== ragSetting.chunkOverlap
    );

    if (incompatible || needsFullRebuild) {
      index = null;
      vectors = null;
    }

    const oldChecksums = index?.fileChecksums || {};

    // Find files that changed
    const changedFiles: string[] = [];
    const unchangedChunks: { meta: ChunkMeta[]; vectors: number[][] } = {
      meta: [],
      vectors: [],
    };

    // Preserve old checksums for PDFs that failed extraction
    for (const failedPath of pdfExtractFailed) {
      if (oldChecksums[failedPath]) {
        newChecksums[failedPath] = oldChecksums[failedPath];
      }
    }

    // Keep chunks from unchanged files (includes failed-extraction PDFs with preserved checksums)
    if (index && vectors) {
      for (let i = 0; i < index.meta.length; i++) {
        const chunk = index.meta[i];
        if (newChecksums[chunk.filePath] === oldChecksums[chunk.filePath]) {
          unchangedChunks.meta.push(chunk);
          const dim = index.dimension;
          const vec = Array.from(vectors.slice(i * dim, (i + 1) * dim));
          unchangedChunks.vectors.push(vec);
        }
      }
    }

    // Find changed or new files
    for (const [filePath, checksum] of Object.entries(newChecksums)) {
      if (checksum !== oldChecksums[filePath]) {
        changedFiles.push(filePath);
      }
    }

    // Chunk and embed changed files
    const newChunks: ChunkMeta[] = [];
    const newEmbeddings: number[][] = [];

    if (changedFiles.length > 0) {
      const allTexts: string[] = [];
      const allMetas: ChunkMeta[] = [];

      for (const filePath of changedFiles) {
        throwIfAborted(signal);
        const content = fileContents.get(filePath);
        if (!content) continue;

        const isPdf = filePath.endsWith(".pdf");
        const pdfInfo = isPdf ? pdfInfoMap.get(filePath) : undefined;
        const chunks = chunkText(content, ragSetting.chunkSize, ragSetting.chunkOverlap);
        for (const chunk of chunks) {
          const heading = isPdf ? null : findNearestHeading(content, chunk.startOffset);
          const prefix = heading ? `[${filePath} > ${heading}]\n` : `[${filePath}]\n`;
          const embeddingText = prefix + chunk.text;
          allTexts.push(embeddingText);
          const meta: ChunkMeta = {
            filePath,
            startOffset: chunk.startOffset,
            text: chunk.text,
          };
          if (isPdf) {
            meta.contentType = "pdf";
            if (pdfInfo) {
              meta.pageLabel = computePageLabel(
                chunk.startOffset, chunk.startOffset + chunk.text.length,
                pdfInfo.pageOffsets, pdfInfo.numPages,
              );
            }
          }
          allMetas.push(meta);
        }
      }

      // Batch embed (max 32 at a time)
      const BATCH_SIZE = 32;
      for (let i = 0; i < allTexts.length; i += BATCH_SIZE) {
        throwIfAborted(signal);
        const batch = allTexts.slice(i, i + BATCH_SIZE);
        const embeddings = await generateEmbeddings(batch, ragSetting, llmConfig);
        throwIfAborted(signal);
        newEmbeddings.push(...embeddings);
      }

      newChunks.push(...allMetas);
    }

    // Merge unchanged + new
    const allMeta = [...unchangedChunks.meta, ...newChunks];
    const allVectorArrays = [...unchangedChunks.vectors, ...newEmbeddings];

    // Determine dimension
    const dimension = allVectorArrays.length > 0 ? allVectorArrays[0].length : 0;

    // Build flat Float32Array
    const newVectors = new Float32Array(allMeta.length * dimension);
    for (let i = 0; i < allVectorArrays.length; i++) {
      newVectors.set(allVectorArrays[i], i * dimension);
    }

    throwIfAborted(signal);

    // Save
    const newIndex: RagIndex = {
      meta: allMeta,
      dimension,
      fileChecksums: newChecksums,
      embeddingFormatVersion: EMBEDDING_FORMAT_VERSION,
      chunkSize: ragSetting.chunkSize,
      chunkOverlap: ragSetting.chunkOverlap,
    };

    this.entries.set(settingName, {
      index: newIndex,
      vectors: newVectors,
      loaded: true,
      incompatibleIndexLoaded: false,
    });

    await saveRagIndex(app, settingName, newIndex, newVectors);

    return {
      totalChunks: allMeta.length,
      indexedFiles: Object.keys(newChecksums).length,
    };
  }

  /**
   * Sync a single file into the RAG index.
   */
  async syncFile(
    app: App,
    settingName: string,
    ragSetting: RagSetting,
    llmConfig: LocalLlmConfig,
    filePath: string,
    oldPath?: string,
  ): Promise<{ path: string; syncedAt: string }> {
    const entry = await this.ensureLoaded(app, settingName, {
      externalIndexPath: ragSetting.externalIndexPath,
    });

    if (entry.incompatibleIndexLoaded) {
      await this.sync(app, settingName, ragSetting, llmConfig);
      return { path: filePath, syncedAt: new Date().toISOString() };
    }

    const { index, vectors } = entry;
    const dimension = index?.dimension || 0;

    // Collect existing chunks, removing old entries for this file
    const keptMeta: ChunkMeta[] = [];
    const keptVectors: number[][] = [];
    const pathsToRemove = new Set<string>([filePath]);
    if (oldPath) pathsToRemove.add(oldPath);

    if (index && vectors) {
      const dim = index.dimension;
      for (let i = 0; i < index.meta.length; i++) {
        if (!pathsToRemove.has(index.meta[i].filePath)) {
          keptMeta.push(index.meta[i]);
          keptVectors.push(Array.from(vectors.slice(i * dim, (i + 1) * dim)));
        }
      }
    }

    // Update checksums
    const checksums = { ...(index?.fileChecksums || {}) };
    if (oldPath) delete checksums[oldPath];

    // Read and embed the file
    const file = app.vault.getAbstractFileByPath(filePath);
    const isSupportedFile = file instanceof TFile && (file.extension === "md" || file.extension === "pdf");
    if (isSupportedFile) {
      const isPdf = file.extension === "pdf";
      let content: string | null;
      let pdfInfo: PdfExtractResult | undefined;
      if (isPdf) {
        let result: PdfExtractResult | null;
        try {
          result = await extractPdfText(app, file);
        } catch (err) {
          // Extraction failed — preserve existing chunks, don't modify the index
          console.warn(`Local LLM Hub: PDF extraction failed for ${filePath}:`, err);
          return { path: filePath, syncedAt: new Date().toISOString() };
        }
        if (!result) {
          content = null;
          delete checksums[filePath];
        } else {
          content = result.text;
          pdfInfo = result;
        }
      } else {
        content = await app.vault.cachedRead(file);
      }

      if (content) {
        const checksum = simpleChecksum(content);

        if (!oldPath && checksum === checksums[filePath]) {
          return { path: filePath, syncedAt: new Date().toISOString() };
        }

        checksums[filePath] = checksum;

        const chunks = chunkText(content, ragSetting.chunkSize, ragSetting.chunkOverlap);
        if (chunks.length > 0) {
          const texts = chunks.map(c => {
            const heading = isPdf ? null : findNearestHeading(content, c.startOffset);
            const prefix = heading ? `[${filePath} > ${heading}]\n` : `[${filePath}]\n`;
            return prefix + c.text;
          });
          const BATCH_SIZE = 32;
          const newEmbeddings: number[][] = [];
          for (let i = 0; i < texts.length; i += BATCH_SIZE) {
            const batch = texts.slice(i, i + BATCH_SIZE);
            const embeddings = await generateEmbeddings(batch, ragSetting, llmConfig);
            newEmbeddings.push(...embeddings);
          }

          for (let i = 0; i < chunks.length; i++) {
            const meta: ChunkMeta = {
              filePath,
              startOffset: chunks[i].startOffset,
              text: chunks[i].text,
            };
            if (isPdf) {
              meta.contentType = "pdf";
              if (pdfInfo) {
                meta.pageLabel = computePageLabel(
                  chunks[i].startOffset, chunks[i].startOffset + chunks[i].text.length,
                  pdfInfo.pageOffsets, pdfInfo.numPages,
                );
              }
            }
            keptMeta.push(meta);
            keptVectors.push(newEmbeddings[i]);
          }
        }
      }
    } else {
      delete checksums[filePath];
    }

    // Rebuild index
    const newDimension = keptVectors.length > 0 ? keptVectors[0].length : dimension;
    const newVectors = new Float32Array(keptMeta.length * newDimension);
    for (let i = 0; i < keptVectors.length; i++) {
      newVectors.set(keptVectors[i], i * newDimension);
    }

    const newIndex: RagIndex = {
      meta: keptMeta,
      dimension: newDimension,
      fileChecksums: checksums,
      embeddingFormatVersion: EMBEDDING_FORMAT_VERSION,
      chunkSize: ragSetting.chunkSize,
      chunkOverlap: ragSetting.chunkOverlap,
    };

    this.entries.set(settingName, {
      index: newIndex,
      vectors: newVectors,
      loaded: true,
      incompatibleIndexLoaded: false,
    });

    await saveRagIndex(app, settingName, newIndex, newVectors);

    return { path: filePath, syncedAt: new Date().toISOString() };
  }

  /**
   * Search for similar chunks in a named setting's index
   */
  async search(
    settingName: string,
    query: string,
    ragSetting: RagSetting,
    llmConfig: LocalLlmConfig,
    app: App,
    fileExtensions?: string[],
  ): Promise<RagSearchResult[]> {
    const entry = await this.ensureLoaded(app, settingName, {
      externalIndexPath: ragSetting.externalIndexPath,
    });

    if (!entry.index || !entry.vectors || entry.index.meta.length === 0) {
      return [];
    }

    const { index, vectors } = entry;
    const queryEmbedding = await generateEmbedding(query, ragSetting, llmConfig);
    const queryVec = new Float32Array(queryEmbedding);
    const dim = index.dimension;
    const normalizedExtensions = new Set(
      (fileExtensions ?? [])
        .map(ext => ext.trim().toLowerCase().replace(/^\./, ""))
        .filter(ext => ext.length > 0)
    );

    // Compute cosine similarities
    const scores: { index: number; score: number }[] = [];
    for (let i = 0; i < index.meta.length; i++) {
      if (normalizedExtensions.size > 0) {
        const fileExt = index.meta[i].filePath.split(".").pop()?.toLowerCase() ?? "";
        if (!normalizedExtensions.has(fileExt)) continue;
      }
      const start = i * dim;
      const end = start + dim;
      if (end > vectors.length) break;
      const chunkVec = vectors.subarray(start, end);
      const score = cosineSimilarity(queryVec, chunkVec);
      scores.push({ index: i, score });
    }

    scores.sort((a, b) => b.score - a.score);
    const minScore = ragSetting.minScore ?? 0;
    const topK = scores
      .filter(s => s.score >= minScore)
      .slice(0, ragSetting.topK);

    return topK.map(({ index: idx, score }) => ({
      text: index.meta[idx].text,
      filePath: index.meta[idx].filePath,
      score,
      ...(index.meta[idx].contentType && { contentType: index.meta[idx].contentType }),
      ...(index.meta[idx].pageLabel && { pageLabel: index.meta[idx].pageLabel }),
    }));
  }

  /** Return indexed files with per-file chunk counts, sorted by file path. */
  async getIndexedFiles(app: App, settingName: string): Promise<{ filePath: string; chunks: number }[]> {
    const entry = await this.ensureLoaded(app, settingName);
    if (!entry.index) return [];
    const counts = new Map<string, number>();
    for (const m of entry.index.meta) {
      counts.set(m.filePath, (counts.get(m.filePath) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([filePath, chunks]) => ({ filePath, chunks }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  /** Keyword search across indexed chunks (no embedding API call needed). */
  async keywordSearch(
    app: App, settingName: string, query: string, topK: number, fileExtensions?: string[],
  ): Promise<RagSearchResult[]> {
    const entry = await this.ensureLoaded(app, settingName);
    if (!entry.index) return [];

    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    if (terms.length === 0) return [];
    const normalizedExtensions = new Set(
      (fileExtensions ?? [])
        .map(ext => ext.trim().toLowerCase().replace(/^\./, ""))
        .filter(ext => ext.length > 0)
    );

    const scored: { index: number; score: number }[] = [];

    for (let i = 0; i < entry.index.meta.length; i++) {
      const meta = entry.index.meta[i];
      if (normalizedExtensions.size > 0) {
        const fileExt = meta.filePath.split(".").pop()?.toLowerCase() ?? "";
        if (!normalizedExtensions.has(fileExt)) continue;
      }
      const textLower = meta.text.toLowerCase();
      let matchCount = 0;
      let totalOccurrences = 0;
      for (const term of terms) {
        let pos = 0;
        let found = false;
        while (true) {
          const idx = textLower.indexOf(term, pos);
          if (idx === -1) break;
          found = true;
          totalOccurrences++;
          pos = idx + term.length;
        }
        if (found) matchCount++;
      }

      if (matchCount === 0) continue;

      const termCoverage = matchCount / terms.length;
      const density = totalOccurrences / (textLower.length / 100);
      scored.push({ index: i, score: termCoverage * 0.7 + Math.min(density, 1) * 0.3 });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(r => {
      const meta = entry.index!.meta[r.index];
      return {
        filePath: meta.filePath,
        text: meta.text,
        score: r.score,
        ...(meta.contentType && { contentType: meta.contentType }),
        ...(meta.pageLabel && { pageLabel: meta.pageLabel }),
      };
    });
  }

  /** Get an adjacent chunk (prev/next) for a given file.
   *  Uses text matching to identify the current chunk. */
  async getAdjacentChunk(
    app: App, settingName: string, filePath: string, chunkText: string, direction: "prev" | "next",
  ): Promise<RagSearchResult | null> {
    const entry = await this.ensureLoaded(app, settingName);
    if (!entry.index) return null;

    const fileChunks: { meta: ChunkMeta; metaIndex: number }[] = [];
    for (let i = 0; i < entry.index.meta.length; i++) {
      if (entry.index.meta[i].filePath === filePath) {
        fileChunks.push({ meta: entry.index.meta[i], metaIndex: i });
      }
    }

    const currentPos = fileChunks.findIndex(c => c.meta.text === chunkText);
    if (currentPos === -1) return null;

    const targetPos = direction === "prev" ? currentPos - 1 : currentPos + 1;
    if (targetPos < 0 || targetPos >= fileChunks.length) return null;

    const meta = fileChunks[targetPos].meta;
    return {
      filePath: meta.filePath,
      text: meta.text,
      score: 0,
      ...(meta.contentType && { contentType: meta.contentType }),
      ...(meta.pageLabel && { pageLabel: meta.pageLabel }),
    };
  }

  /**
   * Clear the entire RAG index for a named setting
   */
  async clear(app: App, settingName: string): Promise<void> {
    this.entries.delete(settingName);
    await deleteRagIndex(app, settingName);
  }

  private async ensureLoaded(
    app: App,
    settingName: string,
    options?: LoadOptions,
  ): Promise<StoreEntry> {
    if (options?.externalIndexPath !== undefined) {
      if (options.externalIndexPath) {
        this.externalPaths.set(settingName, options.externalIndexPath);
      } else {
        this.externalPaths.delete(settingName);
      }
    }
    const existing = this.entries.get(settingName);
    if (existing?.loaded) {
      return existing;
    }

    const externalPath = this.externalPaths.get(settingName);
    let index: RagIndex | null = null;
    let vectors: Float32Array | null = null;
    let incompatibleIndexLoaded = false;

    if (externalPath) {
      index = await loadExternalRagIndex(externalPath);
      if (index && index.meta.length > 0) {
        vectors = await loadExternalRagVectors(externalPath);
      }
    } else {
      index = await loadRagIndex(app, settingName);
      if (index) {
        if (index.embeddingFormatVersion === EMBEDDING_FORMAT_VERSION) {
          vectors = await loadRagVectors(app, settingName);
        } else {
          index = null;
          incompatibleIndexLoaded = true;
        }
      }
    }

    const entry: StoreEntry = { index, vectors, loaded: true, incompatibleIndexLoaded };
    this.entries.set(settingName, entry);
    return entry;
  }
}

// Singleton
let ragStoreInstance: RagStore | null = null;

export function getRagStore(): RagStore {
  if (!ragStoreInstance) {
    ragStoreInstance = new RagStore();
  }
  return ragStoreInstance;
}

// --- Utility functions ---

interface PdfExtractResult {
  text: string;
  numPages: number;
  /** Character offset where each page starts. pageOffsets[i] = offset of page i+1. */
  pageOffsets: number[];
}

/**
 * Extract text from a PDF file using Obsidian's built-in PDF.js.
 * Returns null if the PDF has no extractable text (e.g. scanned/image-only).
 * Throws on read/parse errors so callers can preserve existing index data.
 */
async function extractPdfText(app: App, file: TFile): Promise<PdfExtractResult | null> {
  const buffer = await app.vault.readBinary(file);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjsLib: any = await loadPdfJs();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageTexts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = content.items.map((item: any) => item.str).join(" ");
    pageTexts.push(text.trim() ? text : "");
  }
  // Build joined text with page offset tracking
  const parts: string[] = [];
  const pageOffsets: number[] = [];
  let offset = 0;
  for (let i = 0; i < pageTexts.length; i++) {
    pageOffsets.push(offset);
    if (pageTexts[i]) {
      if (parts.length > 0) offset++; // for "\n" separator
      parts.push(pageTexts[i]);
      offset += pageTexts[i].length;
    }
  }
  if (parts.length === 0) return null;
  return { text: parts.join("\n"), numPages: pdf.numPages, pageOffsets };
}

/**
 * Compute a page label (e.g. "pages 2-5 of 24") for a chunk based on its offset and length.
 */
function computePageLabel(startOffset: number, endOffset: number, pageOffsets: number[], numPages: number): string {
  let startPage = 1;
  let endPage = 1;
  for (let i = 0; i < pageOffsets.length; i++) {
    if (pageOffsets[i] <= startOffset) startPage = i + 1;
    if (pageOffsets[i] <= endOffset) endPage = i + 1;
  }
  return `pages ${startPage}-${endPage} of ${numPages}`;
}

function getTargetFiles(app: App, ragSetting: RagSetting): TFile[] {
  const files = app.vault.getFiles().filter(f => f.extension === "md" || f.extension === "pdf");
  const excludeRegexes = ragSetting.excludePatterns
    .filter(Boolean)
    .flatMap(p => {
      try { return [new RegExp(p)]; } catch { return []; }
    });

  return files.filter(file => {
    // Skip workspace folder
    if (file.path.startsWith(WORKSPACE_FOLDER + "/")) return false;

    // Check target folders
    if (ragSetting.targetFolders.length > 0) {
      const inTarget = ragSetting.targetFolders.some(folder =>
        file.path.startsWith(folder + "/") || file.path === folder
      );
      if (!inTarget) return false;
    }

    // Check exclude patterns
    for (const regex of excludeRegexes) {
      if (regex.test(file.path)) return false;
    }

    return true;
  });
}

export function chunkText(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
): { text: string; startOffset: number }[] {
  const chunks: { text: string; startOffset: number }[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;

    // Try to break at paragraph/sentence boundary
    if (end < text.length) {
      const paragraphBreak = text.lastIndexOf("\n\n", end);
      if (paragraphBreak > start + chunkSize / 2) {
        end = paragraphBreak;
      } else {
        // Find the best sentence boundary (English ". " or Japanese "。", "！", "？")
        const halfPoint = start + chunkSize / 2;
        const region = text.slice(halfPoint, end);
        const sentencePattern = /[.]\s|[。！？]/g;
        let lastMatch = -1;
        let match: RegExpExecArray | null;
        while ((match = sentencePattern.exec(region)) !== null) {
          lastMatch = halfPoint + match.index + match[0].length;
        }
        if (lastMatch > 0) {
          end = lastMatch;
        }
      }
    }

    const chunkStr = text.slice(start, end).trim();
    if (chunkStr) {
      chunks.push({ text: chunkStr, startOffset: start });
    }

    start = end - chunkOverlap;
    if (start <= chunks[chunks.length - 1]?.startOffset) {
      start = end; // Prevent infinite loop
    }
  }

  return chunks;
}

export function simpleChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

/**
 * Find the nearest Markdown heading before a given offset.
 */
export function findNearestHeading(text: string, offset: number): string {
  const headingPattern = /^(#{1,6})\s+(.+)$/gm;
  let lastHeading = "";
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(text)) !== null) {
    if (match.index > offset) {
      break;
    }
    lastHeading = match[2].trim();
  }
  return lastHeading;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
