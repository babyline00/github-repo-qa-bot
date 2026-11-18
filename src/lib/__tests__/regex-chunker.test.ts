import { test, expect, describe } from 'bun:test'
import { chunkRegex, isRegexLanguage } from '../chunker-regex'

describe('chunkRegex — basic splitting', () => {
  test('splits a 100-line file into two 50-line chunks', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const chunks = chunkRegex(content, 50)
    expect(chunks.length).toBe(2)
    expect(chunks[0].ordinal).toBe(1)
    expect(chunks[1].ordinal).toBe(2)
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(50)
    expect(chunks[1].startLine).toBe(51)
    expect(chunks[1].endLine).toBe(100)
  })
  test('a file with fewer than linesPerChunk lines produces one chunk', () => {
    const content = 'one\ntwo\nthree\n'
    const chunks = chunkRegex(content, 50)
    expect(chunks.length).toBe(1)
    expect(chunks[0].ordinal).toBe(1)
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(3)
  })
  test('empty content -> empty array', () => {
    expect(chunkRegex('', 50)).toEqual([])
  })
  test('respects custom linesPerChunk', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`)
    const chunks = chunkRegex(lines.join('\n'), 10)
    expect(chunks.length).toBe(3)
    expect(chunks[0].endLine).toBe(10)
    expect(chunks[1].startLine).toBe(11)
    expect(chunks[2].endLine).toBe(25)
  })
  test('chunk content matches the slice of the file', () => {
    const content = 'a\nb\nc\nd\ne\n'
    const chunks = chunkRegex(content, 2)
    expect(chunks[0].content).toBe('a\nb')
    expect(chunks[1].content).toBe('c\nd')
    expect(chunks[2].content).toBe('e')
  })
  test('ordinals are sequential starting at 1', () => {
    const content = Array.from({ length: 150 }, () => 'x').join('\n')
    const chunks = chunkRegex(content, 50)
    chunks.forEach((c, i) => expect(c.ordinal).toBe(i + 1))
  })
  test('handles CRLF line endings', () => {
    const content = 'a\r\nb\r\nc\r\nd\r\n'
    const chunks = chunkRegex(content, 2)
    expect(chunks.length).toBe(2)
    expect(chunks[0].content).toBe('a\nb')
  })
})

describe('isRegexLanguage', () => {
  test('returns true for non-TS/JS languages', () => {
    expect(isRegexLanguage('py')).toBe(true)
    expect(isRegexLanguage('go')).toBe(true)
    expect(isRegexLanguage('rs')).toBe(true)
    expect(isRegexLanguage('md')).toBe(true)
  })
  test('returns false for TS/JS languages', () => {
    expect(isRegexLanguage('ts')).toBe(false)
    expect(isRegexLanguage('tsx')).toBe(false)
    expect(isRegexLanguage('js')).toBe(false)
    expect(isRegexLanguage('jsx')).toBe(false)
  })
})
