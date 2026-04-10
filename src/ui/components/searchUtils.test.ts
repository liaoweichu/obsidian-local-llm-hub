import { describe, it, expect } from "vitest";
import { parseFilterTerms, matchesFilter, removeRedundantTerms } from "./searchUtils";

// ── parseFilterTerms ──────────────────────────────────────────────

describe("parseFilterTerms", () => {
  it("splits unquoted words into separate terms", () => {
    expect(parseFilterTerms("hello world")).toEqual(["hello", "world"]);
  });

  it("keeps quoted phrases as single terms", () => {
    expect(parseFilterTerms('"MCP Apps" server')).toEqual(["mcp apps", "server"]);
  });

  it("handles multiple quoted phrases", () => {
    expect(parseFilterTerms('"foo bar" "baz qux"')).toEqual(["foo bar", "baz qux"]);
  });

  it("handles mixed quoted and unquoted", () => {
    expect(parseFilterTerms('alpha "beta gamma" delta')).toEqual(["alpha", "beta gamma", "delta"]);
  });

  it("lowercases all terms", () => {
    expect(parseFilterTerms('"MCP Apps" SERVER')).toEqual(["mcp apps", "server"]);
  });

  it("returns empty for empty/whitespace input", () => {
    expect(parseFilterTerms("")).toEqual([]);
    expect(parseFilterTerms("   ")).toEqual([]);
  });

  it("handles empty quotes as literal token", () => {
    expect(parseFilterTerms('"" hello')).toEqual(['""', "hello"]);
  });

  it("handles Japanese text", () => {
    expect(parseFilterTerms('"コア機能" テスト')).toEqual(["コア機能", "テスト"]);
  });
});

// ── matchesFilter ─────────────────────────────────────────────────

describe("matchesFilter", () => {
  it("matches a simple term", () => {
    expect(matchesFilter("Hello world", ["hello"])).toBe(true);
    expect(matchesFilter("Hello world", ["missing"])).toBe(false);
  });

  it("matches any term (OR logic)", () => {
    expect(matchesFilter("Hello world", ["missing", "world"])).toBe(true);
    expect(matchesFilter("Hello world", ["missing", "absent"])).toBe(false);
  });

  it("normalizes newlines in text", () => {
    expect(matchesFilter("hello\nworld", ["hello world"])).toBe(true);
  });

  it("normalizes fullwidth spaces", () => {
    expect(matchesFilter("hello\u3000world", ["hello world"])).toBe(true);
  });

  it("matches CJK text with PDF extraction spaces via space-stripped matching", () => {
    expect(matchesFilter("3 つのコア機能", ["3つのコア機能"])).toBe(true);
  });

  it("matches CJK text with multiple inserted spaces", () => {
    expect(matchesFilter("M C P ア プ リ", ["mcpアプリ"])).toBe(true);
  });

  it("matches quoted phrases with spaces", () => {
    expect(matchesFilter("This is MCP Apps for testing", ["mcp apps"])).toBe(true);
    expect(matchesFilter("This is MCP for testing", ["mcp apps"])).toBe(false);
  });

  it("handles multiple whitespace types together", () => {
    expect(matchesFilter("hello\n\n\tworld\u3000test", ["hello world test"])).toBe(true);
  });
});

// ── removeRedundantTerms ──────────────────────────────────────────

describe("removeRedundantTerms", () => {
  it("keeps original terms", () => {
    expect(removeRedundantTerms("検索 結果 再検索", "検索")).toBe("検索 結果");
  });

  it("removes terms containing an original keyword", () => {
    expect(removeRedundantTerms("search searching searched find", "search")).toBe("search find");
  });

  it("keeps terms not containing original keywords", () => {
    expect(removeRedundantTerms("検索 query find lookup", "検索")).toBe("検索 query find lookup");
  });

  it("handles multiple original keywords", () => {
    expect(removeRedundantTerms("検索 結果 検索結果 再検索 find", "検索 結果"))
      .toBe("検索 結果 find");
  });

  it("is case-insensitive", () => {
    expect(removeRedundantTerms("Search SEARCHING find", "search")).toBe("Search find");
  });

  it("returns original terms when all suggestions are redundant", () => {
    expect(removeRedundantTerms("検索 再検索 全文検索", "検索")).toBe("検索");
  });

  it("handles empty suggested string", () => {
    expect(removeRedundantTerms("", "検索")).toBe("");
  });
});
