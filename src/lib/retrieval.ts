/**
 * Retrieval service for the GitHub Repo Q&A Bot.
 *
 * Given a user query and (optionally) a filtered set of file IDs, returns
 * the top-K most relevant chunks via hybrid retrieval (BM25 + vector cosine
 * + RRF). Loads the corpus into memory on first use and rebuilds when
 * chunks are added/removed. For the single-repo MVP scale (10^2-10^4
 * chunks) in-memory is the right choice; for larger corpora this is where
 * you would swap in pgvector / Tantivy / a hosted retrieval service.
 */

import { db } from '@/lib/db'
import { tokenize } from '@/lib/tokenizer'
import { BM25Index } from '@/lib/bm25'
import {
  getEmbeddingProvider,
  cosine,
  deserializeVector,
  type EmbeddingProvider,
} from '@/lib/embeddings'
import { fuseHits, type SearchHit } from '@/lib/hybrid-search'

export interface RetrievedChunk {
  chunkId: string
  repoId: string
  fileId: string
  filePath: string
  symbolName: string | null
  startLine: number
  endLine: number
  content: string
  bm25Score: number
  vectorScore: number
  fusedScore: number
}

export interface RetrievedRepoMeta {
  owner: string
  name: string
  defaultBranch: string | null
}

const TOP_K = 8

interface CorpusState {
  chunkIds: string[]
  repoIds: string[]
  fileIds: string[]
  filePaths: string[]
  symbolNames: (string | null)[]
  startLines: number[]
  endLines: number[]
  contents: string[]
  tokens: string[][]
  vectors: Float32Array[]
  bm25: BM25Index
  signature: string
}

let corpusState: CorpusState | null = null

async function computeCorpusSignature(): Promise<string> {
  const count = await db.repoChunk.count()
  const latest = await db.repoChunk.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } })
  return `${count}:${latest?.id ?? ''}`
}

async function loadCorpus(provider: EmbeddingProvider): Promise<CorpusState> {
  const chunks = await db.repoChunk.findMany({
    include: { file: { select: { path: true } } },
    orderBy: { ordinal: 'asc' },
  })

  const chunkIds: string[] = []
  const repoIds: string[] = []
  const fileIds: string[] = []
  const filePaths: string[] = []
  const symbolNames: (string | null)[] = []
  const startLines: number[] = []
  const endLines: number[] = []
  const contents: string[] = []
  const tokens: string[][] = []
  const vectors: Float32Array[] = []

  for (const c of chunks) {
    chunkIds.push(c.id)
    repoIds.push(c.repoId)
    fileIds.push(c.fileId)
    filePaths.push(c.file.path)
    symbolNames.push(c.symbolName)
    startLines.push(c.startLine)
    endLines.push(c.endLine)
    contents.push(c.content)
    try {
      tokens.push(JSON.parse(c.tokens) as string[])
    } catch {
      tokens.push(tokenize(c.content))
    }
    try {
      vectors.push(deserializeVector(c.embedding))
    } catch {
      vectors.push(await provider.embed(c.content))
    }
  }

  return {
    chunkIds,
    repoIds,
    fileIds,
    filePaths,
    symbolNames,
    startLines,
    endLines,
    contents,
    tokens,
    vectors,
    bm25: new BM25Index(tokens.map((t, i) => ({ id: chunkIds[i], tokens: t }))),
    signature: await computeCorpusSignature(),
  }
}

async function getCorpus(): Promise<CorpusState> {
  const sig = await computeCorpusSignature()
  if (corpusState && corpusState.signature === sig) {
    return corpusState
  }
  const provider = getEmbeddingProvider()
  corpusState = await loadCorpus(provider)
  return corpusState
}

/** Force a reload on next access — used by the import API after adding repos. */
export function invalidateCorpus() {
  corpusState = null
}

export interface RetrieveOptions {
  /** When set, only chunks from these file IDs are searched. */
  filterFileIds?: string[]
  /** When set, only chunks belonging to this repo are searched. */
  repoId?: string
  topK?: number
}

export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
  const topK = opts.topK ?? TOP_K
  const corpus = await getCorpus()
  if (!corpus.chunkIds.length) return []

  // Build filtered index arrays
  const filter =
    opts.filterFileIds && opts.filterFileIds.length > 0
      ? new Set(opts.filterFileIds)
      : null
  const repoFilter = opts.repoId ? new Set([opts.repoId]) : null

  const filteredIdx: number[] = []
  for (let i = 0; i < corpus.chunkIds.length; i++) {
    if (filter && !filter.has(corpus.fileIds[i])) continue
    if (repoFilter && !repoFilter.has(corpus.repoIds[i])) continue
    filteredIdx.push(i)
  }
  if (!filteredIdx.length) return []

  const bm25Hits = (() => {
    if (!filter && !repoFilter) {
      return corpus.bm25.search(query, topK * 2)
    }
    const filteredDocs = filteredIdx.map((i) => ({
      id: corpus.chunkIds[i],
      tokens: corpus.tokens[i],
    }))
    const sub = new BM25Index(filteredDocs)
    return sub.search(query, topK * 2)
  })()

  const provider = getEmbeddingProvider()
  const qVec = await provider.embed(query)

  const vecHits = filteredIdx
    .map((i) => ({
      id: corpus.chunkIds[i],
      score: cosine(qVec, corpus.vectors[i]),
      idx: i,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK * 2)

  const fused = fuseHits(
    bm25Hits.map((h) => ({ id: h.id, score: h.score })),
    vecHits.map((h) => ({ id: h.id, score: h.score })),
    { topK },
  )

  const idToIdx = new Map(corpus.chunkIds.map((id, i) => [id, i]))
  return fused.map((f: SearchHit): RetrievedChunk => {
    const i = idToIdx.get(f.id)!
    return {
      chunkId: corpus.chunkIds[i],
      repoId: corpus.repoIds[i],
      fileId: corpus.fileIds[i],
      filePath: corpus.filePaths[i],
      symbolName: corpus.symbolNames[i],
      startLine: corpus.startLines[i],
      endLine: corpus.endLines[i],
      content: corpus.contents[i],
      bm25Score: f.bm25Score,
      vectorScore: f.vectorScore,
      fusedScore: f.fusedScore,
    }
  })
}

/** Counts for the stats banner. */
export async function corpusStats(): Promise<{ repos: number; files: number; chunks: number }> {
  const repos = await db.repo.count()
  const files = await db.file.count()
  const chunks = await db.repoChunk.count()
  return { repos, files, chunks }
}

/** Lookup a repo's owner / name / default branch — used to build citation links. */
export async function getRepoMeta(repoId: string): Promise<RetrievedRepoMeta | null> {
  const repo = await db.repo.findUnique({
    where: { id: repoId },
    select: { owner: true, name: true, defaultBranch: true },
  })
  if (!repo) return null
  return {
    owner: repo.owner,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
  }
}
