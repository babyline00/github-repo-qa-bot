import { test, expect, describe, afterEach } from 'bun:test'
import {
  chunkTsJs,
  chunkTsJsRegex,
  setAstParserForTest,
  type AstParser,
  type AstChunk,
} from '../chunker-ast'

afterEach(() => {
  // Reset the injected parser between tests so each test runs in isolation.
  setAstParserForTest(null)
})

describe('chunkTsJsRegex — function declarations', () => {
  test('parses a top-level function with body', () => {
    const src = [
      'function foo() {',
      '  return 1;',
      '}',
      '',
      'function bar() {',
      '  return 2;',
      '}',
    ].join('\n')
    const chunks = chunkTsJsRegex(src)
    expect(chunks.length).toBe(2)
    expect(chunks[0].symbolName).toBe('foo')
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(3)
    expect(chunks[1].symbolName).toBe('bar')
    expect(chunks[1].startLine).toBe(5)
  })
  test('parses an exported function', () => {
    const src = 'export function exported() {\n  return 42;\n}\n'
    const chunks = chunkTsJsRegex(src)
    expect(chunks.length).toBe(1)
    expect(chunks[0].symbolName).toBe('exported')
  })
  test('parses an async function', () => {
    const src = 'async function fetchData() {\n  await fetch("/");\n}\n'
    const chunks = chunkTsJsRegex(src)
    expect(chunks.length).toBe(1)
    expect(chunks[0].symbolName).toBe('fetchData')
  })
})

describe('chunkTsJsRegex — class declarations', () => {
  test('parses a class with methods (chunked as one class block)', () => {
    const src = [
      'class Foo {',
      '  methodA() {',
      '    return 1;',
      '  }',
      '  methodB() {',
      '    return 2;',
      '  }',
      '}',
    ].join('\n')
    const chunks = chunkTsJsRegex(src)
    // MVP regex chunker treats the class as one chunk (methods inside are
    // not separately chunked — that's the AST-parser's job).
    expect(chunks.length).toBe(1)
    expect(chunks[0].symbolName).toBe('Foo')
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(8)
  })
  test('parses an exported class', () => {
    const src = 'export class Widget {\n  constructor() {}\n}\n'
    const chunks = chunkTsJsRegex(src)
    expect(chunks.length).toBe(1)
    expect(chunks[0].symbolName).toBe('Widget')
  })
})

describe('chunkTsJsRegex — arrow functions', () => {
  test('parses a const arrow function', () => {
    const src = 'const add = (a, b) => {\n  return a + b;\n}\n'
    const chunks = chunkTsJsRegex(src)
    expect(chunks.length).toBe(1)
    expect(chunks[0].symbolName).toBe('add')
  })
  test('parses an async arrow function', () => {
    const src = 'const fetcher = async () => {\n  return await fetch("/");\n}\n'
    const chunks = chunkTsJsRegex(src)
    expect(chunks.length).toBe(1)
    expect(chunks[0].symbolName).toBe('fetcher')
  })
})

describe('chunkTsJsRegex — anonymous functions get generated names', () => {
  test('a bare function expression assigned to const gets the const name', () => {
    const src = 'const handler = function () { return 1; }\n'
    const chunks = chunkTsJsRegex(src)
    expect(chunks.length).toBe(1)
    expect(chunks[0].symbolName).toBe('handler')
  })
})

describe('chunkTsJsRegex — imports are NOT chunked', () => {
  test('a file with only imports produces zero chunks', () => {
    const src = [
      "import { foo } from './foo';",
      "import bar from 'bar';",
      "import * as baz from 'baz';",
      '',
    ].join('\n')
    const chunks = chunkTsJsRegex(src)
    expect(chunks).toEqual([])
  })
})

describe('chunkTsJsRegex — brace matching respects comments and strings', () => {
  test('a } inside a string does not close the function', () => {
    const src = [
      'function tricky() {',
      '  const s = "this has a } in it";',
      '  return s;',
      '}',
    ].join('\n')
    const chunks = chunkTsJsRegex(src)
    expect(chunks.length).toBe(1)
    expect(chunks[0].symbolName).toBe('tricky')
    expect(chunks[0].endLine).toBe(4)
  })
  test('a } inside a line comment does not close the function', () => {
    const src = [
      'function withComment() {',
      '  // a } here should not close',
      '  return 1;',
      '}',
    ].join('\n')
    const chunks = chunkTsJsRegex(src)
    expect(chunks.length).toBe(1)
    expect(chunks[0].endLine).toBe(4)
  })
  test('a } inside a block comment does not close the function', () => {
    const src = [
      'function withBlock() {',
      '  /* a } here',
      '     should not close */',
      '  return 1;',
      '}',
    ].join('\n')
    const chunks = chunkTsJsRegex(src)
    expect(chunks.length).toBe(1)
    // 5 lines total — the block comment (with a `}` inside it on line 2) does
    // not close the function. The function ends on line 5.
    expect(chunks[0].endLine).toBe(5)
  })
})

describe('chunkTsJs — uses injected (mock) parser when provided', () => {
  test('returns fixture chunks from the injected parser', () => {
    const fixtures: AstChunk[] = [
      { symbolName: 'mockFn', startLine: 1, endLine: 5, content: 'mockFn body' },
    ]
    const mock: AstParser = {
      parse: (_content, _lang) => fixtures,
    }
    setAstParserForTest(mock)
    const chunks = chunkTsJs('any content', 'ts')
    expect(chunks).toEqual(fixtures)
    expect(chunks[0].symbolName).toBe('mockFn')
  })
  test('falls back to regex chunker when no parser is injected', () => {
    const src = 'function real() { return 1; }\n'
    const chunks = chunkTsJs(src, 'ts')
    expect(chunks.length).toBe(1)
    expect(chunks[0].symbolName).toBe('real')
  })
})

describe('chunkTsJs — chunk shape invariants', () => {
  test('every chunk has a non-empty symbolName', () => {
    const src = 'const a = () => { return 1; }\n'
    const chunks = chunkTsJsRegex(src)
    chunks.forEach((c) => expect(c.symbolName.length).toBeGreaterThan(0))
  })
  test('every chunk has startLine <= endLine', () => {
    const src = 'function a() { return 1; }\nfunction b() { return 2; }\n'
    const chunks = chunkTsJsRegex(src)
    chunks.forEach((c) => expect(c.startLine).toBeLessThanOrEqual(c.endLine))
  })
})
