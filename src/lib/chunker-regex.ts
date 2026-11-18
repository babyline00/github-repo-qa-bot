/**
 * Regex chunker for non-TS/JS files (and the universal fallback).
 *
 * Splits a file's content into fixed-size line windows — `linesPerChunk`
 * lines per chunk (default 50). Each chunk carries its ordinal (1-indexed),
 * `startLine` / `endLine` (1-indexed, inclusive), and the source text of the
 * window. Used for `.py`, `.go`, `.rs`, `.md`, and any other text file the
 * importer fetches.
 *
 * Pure (no IO, no globals) so it can be unit-tested in isolation.
 */

export interface RegexChunk {
  ordinal: number
  startLine: number
  endLine: number
  content: string
}

export function chunkRegex(
  content: string,
  linesPerChunk = 50,
): RegexChunk[] {
  if (!content) return []
  const rawLines = content.replace(/\r\n/g, '\n').split('\n')
  // Drop a single trailing empty line caused by a final newline character so
  // the chunk's endLine matches the editor-visible line count. We keep
  // empty lines mid-file because they affect line numbering.
  const lines =
    rawLines.length > 1 && rawLines[rawLines.length - 1] === ''
      ? rawLines.slice(0, -1)
      : rawLines
  if (lines.length === 0) return []
  const out: RegexChunk[] = []
  let ordinal = 0
  for (let i = 0; i < lines.length; i += linesPerChunk) {
    ordinal += 1
    const slice = lines.slice(i, i + linesPerChunk)
    out.push({
      ordinal,
      startLine: i + 1,
      endLine: i + slice.length,
      content: slice.join('\n'),
    })
  }
  return out
}

/** True when the file extension maps to the regex chunker (not AST). */
export function isRegexLanguage(language: string): boolean {
  return ['py', 'go', 'rs', 'md', 'markdown', 'txt', 'sh', 'bash', 'yml', 'yaml', 'json', 'toml', 'css', 'html', 'sql', 'java', 'c', 'cpp', 'h', 'hpp'].includes(language)
}
