import { test, expect, describe } from 'bun:test'
import { buildRagSystemPrompt, extractCitations } from '../ai'
import type { RetrievedChunk, RetrievedRepoMeta } from '../retrieval'

const retrieved: RetrievedChunk[] = [
  {
    chunkId: 'ck-aaa',
    repoId: 'repo-1',
    fileId: 'file-1',
    filePath: 'src/lib/ai.ts',
    symbolName: 'buildRagSystemPrompt',
    startLine: 42,
    endLine: 88,
    content:
      'export function buildRagSystemPrompt(retrieved) { /* build prompt with citations */ return { systemPrompt, citationMap } }',
    bm25Score: 4.2,
    vectorScore: 0.81,
    fusedScore: 0.016,
  },
  {
    chunkId: 'ck-bbb',
    repoId: 'repo-1',
    fileId: 'file-2',
    filePath: 'src/lib/bm25.ts',
    symbolName: 'search',
    startLine: 56,
    endLine: 80,
    content: 'search(query, topK) { /* rank docs by BM25 score */ }',
    bm25Score: 2.1,
    vectorScore: 0.74,
    fusedScore: 0.012,
  },
]

const repo: RetrievedRepoMeta = {
  owner: 'owner',
  name: 'repo',
  defaultBranch: 'main',
}

describe('buildRagSystemPrompt', () => {
  test('includes all retrieved chunks', () => {
    const { systemPrompt } = buildRagSystemPrompt(retrieved, repo)
    expect(systemPrompt).toContain('buildRagSystemPrompt')
    expect(systemPrompt).toContain('BM25')
  })
  test('includes the citation rules', () => {
    const { systemPrompt } = buildRagSystemPrompt(retrieved, repo)
    expect(systemPrompt.toLowerCase()).toContain('citation')
    expect(systemPrompt).toContain('[^c1]')
  })
  test('instructs the LLM to use file:line references', () => {
    const { systemPrompt } = buildRagSystemPrompt(retrieved, repo)
    expect(systemPrompt.toLowerCase()).toContain('path:line')
    expect(systemPrompt).toContain('src/lib/ai.ts:42')
  })
  test('empty retrieved -> safe-mode prompt', () => {
    const { systemPrompt, citationMap } = buildRagSystemPrompt([], null)
    expect(systemPrompt.toLowerCase()).toContain('no files')
    expect(Object.keys(citationMap)).toHaveLength(0)
  })
  test('citation map key is the chunkId', () => {
    const { citationMap } = buildRagSystemPrompt(retrieved, repo)
    expect(citationMap['ck-aaa'].filePath).toBe('src/lib/ai.ts')
    expect(citationMap['ck-aaa'].symbolName).toBe('buildRagSystemPrompt')
    expect(citationMap['ck-bbb'].filePath).toBe('src/lib/bm25.ts')
  })
  test('citation card carries a githubUrl with the line range', () => {
    const { citationMap } = buildRagSystemPrompt(retrieved, repo)
    expect(citationMap['ck-aaa'].githubUrl).toBe(
      'https://github.com/owner/repo/blob/main/src/lib/ai.ts#L42-L88',
    )
  })
})

describe('extractCitations', () => {
  test('returns chunkIds in citation order', () => {
    const msg = 'The prompt builder is at src/lib/ai.ts:42 [^c1] and BM25 search at src/lib/bm25.ts:56 [^c2].'
    const ids = extractCitations(msg, retrieved)
    expect(ids).toEqual(['ck-aaa', 'ck-bbb'])
  })
  test('dedupes repeated citations', () => {
    const msg = 'A [^c1] then again [^c1].'
    const ids = extractCitations(msg, retrieved)
    expect(ids).toEqual(['ck-aaa'])
  })
  test('ignores out-of-range markers', () => {
    const msg = 'Bogus citation [^c99].'
    expect(extractCitations(msg, retrieved)).toEqual([])
  })
  test('no citations -> []', () => {
    expect(extractCitations('no markers here', retrieved)).toEqual([])
  })
})
