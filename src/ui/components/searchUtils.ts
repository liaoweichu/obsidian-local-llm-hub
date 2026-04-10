/**
 * Parse a keyword filter value into terms.
 * Quoted phrases (e.g. "MCP Apps") stay as one term; unquoted words are separate OR terms.
 * All terms are lowercased.
 */
export function parseFilterTerms(value: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const t = (m[1] ?? m[2]).toLowerCase();
    if (t) terms.push(t);
  }
  return terms;
}

/**
 * Check whether a search result text matches at least one term in a filter.
 * Handles whitespace normalization (newlines, fullwidth spaces) and
 * space-stripped matching for CJK text where PDF extraction inserts spurious spaces.
 */
export function matchesFilter(rawText: string, terms: string[]): boolean {
  const text = rawText.toLowerCase().replace(/[\s\u3000]+/g, " ");
  const textNoSpace = text.replace(/ /g, "");
  return terms.some(term => text.includes(term) || textNoSpace.includes(term));
}

/**
 * Remove redundant AI-suggested keywords.
 * A suggested term is redundant if it contains an original keyword as a substring,
 * since the shorter original already matches anything the longer term would via `includes()`.
 * Original terms are always kept.
 */
export function removeRedundantTerms(suggested: string, originalTerms: string): string {
  const origLower = originalTerms.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  const filtered = suggested.split(/\s+/).filter(term => {
    const lower = term.toLowerCase();
    if (origLower.includes(lower)) return true;
    return !origLower.some(orig => lower.includes(orig));
  });
  return filtered.join(" ");
}
