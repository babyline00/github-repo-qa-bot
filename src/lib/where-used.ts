/**
 * "Where is X used?" lookup — pure regex whole-word match across the files
 * of a single repo. Case-sensitive. Skips matches inside comments using a
 * heuristic that handles the common comment styles:
 *
 *   - // line comment        (JS/TS/Go/Rust/Java/C)
 *   - #  line comment        (Python/Ruby/Shell/YAML)
 *   --  line comment        (SQL/Lua/Haskell)
 *   ;   line comment        (Lisp/Assembly)
 *   /* ... *\/  block comment  (JS/TS/Go/Rust/Java/C)
 *   <!-- ... -->  HTML comment
 *
 * The heuristic is line-oriented: a match on a line is "inside a comment" if
 * the symbol occurs after a comment marker on that line, OR if the line is
 * between an unmatched `/*` and its matching `*\/` (block-comment state
 * carried across lines).
 *
 * Returns one result per file, with the 1-indexed line numbers of every
 * match (excluding comment matches) plus a short preview of the first match
 * line.
 */

export interface WhereUsedFileResult {
  fileId: string
  filePath: string
  /** 1-indexed line numbers where the symbol appears (case-sensitive, whole word). */
  lineMatches: number[]
  /** Short preview of the first match line (truncated + trimmed). */
  preview: string
}

export interface WhereUsedInput {
  fileId: string
  filePath: string
  content: string
}

/**
 * Pure function: given a symbol name + a list of file contents, return the
 * files (and lines) where the symbol is used outside of comments.
 */
export function whereUsed(symbolName: string, files: WhereUsedInput[]): WhereUsedFileResult[] {
  if (!symbolName) return []
  const results: WhereUsedFileResult[] = []
  // Escape regex special characters in the symbol; require a word boundary.
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b${escaped}\\b`, 'g')

  for (const file of files) {
    if (!file.content) continue
    const lines = file.content.replace(/\r\n/g, '\n').split('\n')
    const lineMatches: number[] = []
    let firstPreview = ''
    let inBlockComment = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Track block-comment state across lines.
      const stripped = stripComments(line, file.filePath, inBlockComment)
      inBlockComment = stripped.inBlockComment
      const codePart = stripped.code

      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(codePart)) !== null) {
        // Skip if the match landed in the "comment" portion (stripped above).
        // Since we already excised comments from `codePart`, any match here is
        // a real code match.
        if (lineMatches.length === 0 && !firstPreview) {
          firstPreview = previewOf(line)
        }
        lineMatches.push(i + 1)
        // Avoid zero-length infinite loops (shouldn't happen with `\bSYMBOL\b`
        // but be safe).
        if (m.index === re.lastIndex) re.lastIndex++
      }
    }
    if (lineMatches.length > 0) {
      results.push({
        fileId: file.fileId,
        filePath: file.filePath,
        lineMatches,
        preview: firstPreview,
      })
    }
  }
  return results
}

/**
 * Remove the comment portion of a single line. Returns the code portion and
 * the new block-comment state (carried into the next line).
 *
 * The heuristic handles three cases per line:
 *   1. We're already inside a block comment — look for `*/` to close it.
 *   2. We're not in a block comment — look for `/*` to open it (everything
 *      after is comment), or a line-comment marker (`//`, `#`, `--`, `;`)
 *      for the file's language family.
 */
function stripComments(
  line: string,
  filePath: string,
  inBlockComment: boolean,
): { code: string; inBlockComment: boolean } {
  let code = ''
  let i = 0
  const lang = languageOf(filePath)
  const lineComment = lineCommentMarker(lang)
  while (i < line.length) {
    if (inBlockComment) {
      const close = line.indexOf('*/', i)
      if (close < 0) {
        // Rest of line stays in block comment
        return { code, inBlockComment: true }
      }
      inBlockComment = false
      i = close + 2
      continue
    }
    // Check for block-comment open
    if (line[i] === '/' && line[i + 1] === '*') {
      inBlockComment = true
      i += 2
      continue
    }
    // Check for line comment marker at the current cursor (after stripping
    // leading whitespace on the code-portion side we still need to honour
    // markers mid-line: `foo(); // bar` should drop `// bar`).
    if (lineComment && line.startsWith(lineComment, i)) {
      // Rest of the line is comment.
      return { code, inBlockComment }
    }
    code += line[i]
    i++
  }
  return { code, inBlockComment }
}

function lineCommentMarker(lang: string): string | null {
  switch (lang) {
    case 'py':
    case 'sh':
    case 'bash':
    case 'yml':
    case 'yaml':
    case 'rb':
      return '#'
    case 'sql':
    case 'lua':
      return '--'
    case 'lisp':
    case 'asm':
      return ';'
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'go':
    case 'rs':
    case 'java':
    case 'c':
    case 'cpp':
    case 'h':
    case 'hpp':
    case 'css':
    case 'json':
      return '//'
    default:
      return null
  }
}

function languageOf(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z]+)$/)
  return m ? m[1] : ''
}

function previewOf(line: string): string {
  const trimmed = line.trim()
  if (trimmed.length <= 140) return trimmed
  return trimmed.slice(0, 140) + '…'
}
