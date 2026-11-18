import { test, expect, describe } from 'bun:test'
import { whereUsed, type WhereUsedInput } from '../where-used'

describe('whereUsed — basic whole-word match', () => {
  test('finds the symbol as a whole word (case-sensitive)', () => {
    const files: WhereUsedInput[] = [
      {
        fileId: 'f1',
        filePath: 'src/app.ts',
        content: 'import { foo } from "./foo"\nfoo(1, 2)\nconst x = fooBar // not a match\n',
      },
    ]
    const results = whereUsed('foo', files)
    expect(results.length).toBe(1)
    expect(results[0].lineMatches).toContain(1)
    expect(results[0].lineMatches).toContain(2)
    // 'fooBar' must not match
    expect(results[0].lineMatches).not.toContain(3)
  })
  test('case-sensitive: Foo does not match foo', () => {
    const files: WhereUsedInput[] = [
      { fileId: 'f1', filePath: 'a.ts', content: 'const Foo = 1\nconst foo = 2\n' },
    ]
    expect(whereUsed('Foo', files)[0].lineMatches).toEqual([1])
    expect(whereUsed('foo', files)[0].lineMatches).toEqual([2])
  })
  test('returns multiple line numbers per file', () => {
    const content = 'foo();\nfoo();\nfoo();\n'
    const results = whereUsed('foo', [{ fileId: 'f', filePath: 'a.ts', content }])
    expect(results[0].lineMatches).toEqual([1, 2, 3])
  })
  test('returns multiple files when symbol is in many files', () => {
    const files: WhereUsedInput[] = [
      { fileId: 'a', filePath: 'a.ts', content: 'foo()\n' },
      { fileId: 'b', filePath: 'b.ts', content: 'bar()\nfoo()\n' },
      { fileId: 'c', filePath: 'c.ts', content: 'baz()\n' },
    ]
    const results = whereUsed('foo', files)
    expect(results.map((r) => r.fileId).sort()).toEqual(['a', 'b'])
  })
  test('empty symbol -> empty results', () => {
    expect(whereUsed('', [{ fileId: 'f', filePath: 'a.ts', content: 'foo' }])).toEqual([])
  })
  test('symbol not present -> empty results', () => {
    expect(whereUsed('zzz', [{ fileId: 'f', filePath: 'a.ts', content: 'foo bar baz' }])).toEqual([])
  })
  test('preview is the first match line (trimmed)', () => {
    const content = '  foo(1)\n'
    const results = whereUsed('foo', [{ fileId: 'f', filePath: 'a.ts', content }])
    expect(results[0].preview).toBe('foo(1)')
  })
})

describe('whereUsed — skips matches inside comments', () => {
  test('skips // line comments (TS)', () => {
    const content = [
      '// foo is great',
      'foo()',
      'bar() // foo also',
    ].join('\n')
    const results = whereUsed('foo', [{ fileId: 'f', filePath: 'a.ts', content }])
    // Line 1 (whole line is a comment) and line 3 (trailing comment) must be
    // skipped. Only line 2 should match.
    expect(results[0].lineMatches).toEqual([2])
  })
  test('skips # line comments (Python)', () => {
    const content = [
      '# foo here',
      'foo()',
    ].join('\n')
    const results = whereUsed('foo', [{ fileId: 'f', filePath: 'a.py', content }])
    expect(results[0].lineMatches).toEqual([2])
  })
  test('skips -- line comments (SQL)', () => {
    const content = [
      '-- foo here',
      'SELECT foo FROM t;',
    ].join('\n')
    const results = whereUsed('foo', [{ fileId: 'f', filePath: 'a.sql', content }])
    expect(results[0].lineMatches).toEqual([2])
  })
  test('skips /* ... */ block comments spanning multiple lines (TS)', () => {
    const content = [
      '/* multi-line',
      ' foo is here */',
      'foo()',
    ].join('\n')
    const results = whereUsed('foo', [{ fileId: 'f', filePath: 'a.ts', content }])
    expect(results[0].lineMatches).toEqual([3])
  })
  test('does not skip when the symbol appears before the comment marker on the same line', () => {
    const content = 'foo() // comment with foo'
    const results = whereUsed('foo', [{ fileId: 'f', filePath: 'a.ts', content }])
    // foo() before the comment IS a match; the foo inside the comment is not.
    expect(results[0].lineMatches).toEqual([1])
  })
})

describe('whereUsed — regex special characters in the symbol are escaped', () => {
  test('a symbol with a dot is matched literally', () => {
    const content = 'console.log("hi")\n'
    const results = whereUsed('console.log', [{ fileId: 'f', filePath: 'a.ts', content }])
    expect(results[0].lineMatches).toEqual([1])
  })
})
