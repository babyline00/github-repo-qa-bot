/**
 * AST-aware chunker for TS / JS / TSX / JSX files.
 *
 * One chunk per top-level function / method / class. Each chunk carries:
 *   - `symbolName`: extracted function / method / class name. Anonymous
 *     functions get a generated name like `<anonymous-L12>`.
 *   - `startLine` / `endLine`: 1-indexed line range (inclusive).
 *   - `content`: source text of the chunk.
 *
 * Imports and type-only declarations are NOT chunked — they're skipped.
 *
 * --- tree-sitter integration (optional) ---
 *
 * The spec says `tree-sitter` + `tree-sitter-typescript` are declared as deps
 * but their install is not required to run tests. We therefore use a
 * dynamic-import pattern: if the modules resolve at runtime, we use the
 * real tree-sitter parser; otherwise we fall back to a regex-based TS/JS
 * structure detector that recognises the common declaration forms
 * (function, class, arrow-const, method). Both code paths return the same
 * `AstChunk[]` shape so the rest of the app is oblivious.
 *
 * Tests can inject a mock parser via `setAstParserForTest()` so they don't
 * need real tree-sitter bindings.
 */

export interface AstChunk {
  /** Symbol name. Anonymous functions get a generated name. */
  symbolName: string
  /** 1-indexed start line. */
  startLine: number
  /** 1-indexed end line (inclusive). */
  endLine: number
  /** Source text of the chunk. */
  content: string
}

export interface AstParser {
  parse(content: string, language: 'ts' | 'tsx' | 'js' | 'jsx'): AstChunk[]
}

let injectedParser: AstParser | null = null

/** Test-only: inject a mock parser (or null to revert to default behaviour). */
export function setAstParserForTest(p: AstParser | null) {
  injectedParser = p
}

let cachedTreeSitterParser: AstParser | null | undefined
async function loadTreeSitterParser(): Promise<AstParser | null> {
  if (cachedTreeSitterParser !== undefined) return cachedTreeSitterParser
  try {
    // Dynamic import so module-level eval doesn't crash when the dep is absent.
    const ts: any = await import('tree-sitter')
    const tsTypes: any = await import('tree-sitter-typescript')
    const Parser = ts?.default ?? ts
    const Language = tsTypes?.default ?? tsTypes
    const tsLang = Language.typescript ?? Language.typescript
    const tsxLang = Language.tsx ?? Language.tsx
    const parser = new Parser()
    cachedTreeSitterParser = {
      parse(content: string, language: 'ts' | 'tsx' | 'js' | 'jsx'): AstChunk[] {
        const lang = language === 'tsx' || language === 'jsx' ? tsxLang : tsLang
        try {
          parser.setLanguage(lang)
        } catch {
          return chunkTsJsRegex(content)
        }
        const tree = parser.parse(content)
        return extractChunksFromTree(tree, content)
      },
    }
    return cachedTreeSitterParser
  } catch (e) {
    console.warn('[chunker-ast] tree-sitter unavailable, using regex fallback:', (e as Error).message)
    cachedTreeSitterParser = null
    return null
  }
}

/**
 * Walk a tree-sitter syntax tree and emit one chunk per function / method /
 * class node. Anonymous nodes get a generated name based on their start line.
 */
function extractChunksFromTree(tree: any, content: string): AstChunk[] {
  const lines = content.split('\n')
  const chunks: AstChunk[] = []
  const seen = new Set<number>()
  const SYMBOL_NODE_TYPES = new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'class_declaration',
    'class',
    'export_statement', // unwrap to find function/class inside
  ])

  function nameOf(node: any): string | null {
    if (!node) return null
    // Try common child fields
    const id = node.childForFieldName?.('name')
    if (id && id.type === 'identifier') return id.text
    // For arrow functions assigned to a const, the name is on the parent
    return null
  }

  function walk(node: any, ownerName: string | null) {
    if (!node) return
    const isSymbol =
      SYMBOL_NODE_TYPES.has(node.type) &&
      (node.type === 'function_declaration' ||
        node.type === 'method_definition' ||
        node.type === 'class_declaration' ||
        node.type === 'class')

    if (isSymbol && !seen.has(node.startPosition.row)) {
      seen.add(node.startPosition.row)
      const name = nameOf(node) ?? ownerName ?? `<anonymous-L${node.startPosition.row + 1}>`
      chunks.push({
        symbolName: name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        content: sliceLines(lines, node.startPosition.row, node.endPosition.row),
      })
    }
    // Recurse — but only descend into export_statement / program so we don't
    // double-chunk nested symbols (methods inside classes are emitted via
    // the class chunk only in MVP).
    if (node.type === 'program' || node.type === 'export_statement') {
      for (let i = 0; i < node.childCount; i++) walk(node.child(i), null)
    }
  }

  walk(tree.rootNode, null)
  return chunks
}

function sliceLines(lines: string[], startRow: number, endRow: number): string {
  return lines.slice(startRow, endRow + 1).join('\n')
}

/**
 * Regex-based TS/JS structure detector. Recognises the common top-level
 * declaration forms and uses simple brace matching to find their end.
 *
 * This is the fallback used when tree-sitter isn't installed, and it's also
 * the path tests exercise so they don't require native bindings.
 */
export function chunkTsJsRegex(content: string): AstChunk[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const chunks: AstChunk[] = []

  // Patterns we recognise (top-of-line, ignoring leading whitespace).
  //  - function foo(...)
  //  - export function foo(...)
  //  - export default function foo(...)
  //  - async function foo(...)
  //  - class Foo { ... }
  //  - export class Foo { ... }
  //  - const foo = (...) => { ... }   (arrow functions)
  //  - const foo = function (...) { ... }
  //  - const foo = async (...) => { ... }
  //  - public/private/protected method(...) { ... }  (class methods — best-effort)
  const declRe =
    /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)?|\(([^)]*)\)\s*=>|async\s*\(([^)]*)\)\s*=>))/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(declRe)
    if (!m) continue
    const name =
      m[1] ?? // function foo
      m[2] ?? // class Foo
      m[3] ?? // const foo = ...
      m[4] ?? // const foo = function bar
      null
    const symbolName = name ?? `<anonymous-L${i + 1}>`

    // Find the end of the declaration by brace matching from the line of the
    // declaration. (For arrow functions with expression bodies without
    // braces, we treat the rest of the line as the chunk.)
    const endLine = findDeclEnd(lines, i)
    if (endLine <= i) {
      // Single-line declaration
      chunks.push({
        symbolName,
        startLine: i + 1,
        endLine: i + 1,
        content: lines[i],
      })
      continue
    }
    chunks.push({
      symbolName,
      startLine: i + 1,
      endLine: endLine + 1,
      content: lines.slice(i, endLine + 1).join('\n'),
    })
  }

  return chunks
}

/**
 * Walk forward from `startLine` (0-indexed) tracking brace depth. Returns the
 * 0-indexed line where the declaration's top-level brace closes. If no brace
 * is opened, returns `startLine` (single-line declaration).
 */
function findDeclEnd(lines: string[], start: number): number {
  let depth = 0
  let opened = false
  let inString: string | null = null
  let inLineComment = false
  let inBlockComment = false

  for (let i = start; i < lines.length; i++) {
    let line = lines[i]
    // Strip block-comment continuation
    if (inBlockComment) {
      const end = line.indexOf('*/')
      if (end < 0) continue
      inBlockComment = false
      line = line.slice(end + 2)
    }
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]
      const next = line[j + 1]
      if (inLineComment) break
      if (inString) {
        if (ch === '\\') { j++; continue }
        if (ch === inString) inString = null
        continue
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; j++ }
        continue
      }
      if (ch === '/' && next === '/') { inLineComment = true; break }
      if (ch === '/' && next === '*') { inBlockComment = true; j++; continue }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue }
      if (ch === '{') { depth++; opened = true }
      if (ch === '}') { depth-- }
      if (opened && depth === 0) return i
    }
    inLineComment = false
  }
  // If we never opened a brace, treat as single-line
  return opened ? lines.length - 1 : start
}

/**
 * Public entry point: chunk a TS/JS file. Synchronously tries the injected
 * parser (if any); otherwise returns the regex-based fallback so the call
 * stays sync for the import pipeline (we don't block ingestion on native
 * bindings). The async variant `chunkTsJsAsync` will use tree-sitter if
 * available.
 */
export function chunkTsJs(content: string, language: 'ts' | 'tsx' | 'js' | 'jsx' = 'ts'): AstChunk[] {
  if (injectedParser) return injectedParser.parse(content, language)
  return chunkTsJsRegex(content)
}

/**
 * Async variant — uses tree-sitter when available (and no parser is injected).
 * Falls back to the regex chunker otherwise. This is what the import route
 * calls so we get AST-aware chunking when bindings are installed.
 */
export async function chunkTsJsAsync(content: string, language: 'ts' | 'tsx' | 'js' | 'jsx' = 'ts'): Promise<AstChunk[]> {
  if (injectedParser) return injectedParser.parse(content, language)
  const tsParser = await loadTreeSitterParser()
  if (tsParser) return tsParser.parse(content, language)
  return chunkTsJsRegex(content)
}
