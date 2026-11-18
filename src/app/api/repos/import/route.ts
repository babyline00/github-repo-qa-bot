/**
 * POST /api/repos/import
 *
 * Body: { url: string }
 *
 * Parses a GitHub URL, fetches the top 50 smallest supported files via the
 * unauthenticated contents API (60 req/hr), AST-chunks TS/JS / regex-chunks
 * other langs, embeds each chunk, and persists the repo + files + chunks.
 *
 * Returns: { ok, repoId, fileCount, chunkCount }
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseGithubUrl } from '@/lib/url-parser'
import { ingestRepo, MAX_FILES } from '@/lib/github-fetch'
import { chunkTsJsAsync } from '@/lib/chunker-ast'
import { chunkRegex } from '@/lib/chunker-regex'
import { tokenize } from '@/lib/tokenizer'
import {
  getEmbeddingProvider,
  serializeVector,
  type EmbeddingProvider,
} from '@/lib/embeddings'
import { invalidateCorpus } from '@/lib/retrieval'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ImportBody {
  url: string
}

export async function POST(req: NextRequest) {
  let body: ImportBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const url = (body.url ?? '').trim()
  if (!url) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 })
  }
  const parsed = parseGithubUrl(url)
  if (!parsed) {
    return NextResponse.json(
      { error: 'Not a valid GitHub repo URL. Expected https://github.com/owner/repo or git@github.com:owner/repo.git' },
      { status: 400 },
    )
  }

  // Avoid duplicate imports of the same (owner, name).
  const existing = await db.repo.findFirst({
    where: { owner: parsed.owner, name: parsed.name },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json(
      { ok: true, repoId: existing.id, fileCount: 0, chunkCount: 0, reused: true },
      { status: 200 },
    )
  }

  let ingest
  try {
    ingest = await ingestRepo(parsed.owner, parsed.name, parsed.branch)
  } catch (e) {
    return NextResponse.json(
      { error: `GitHub ingest failed: ${(e as Error).message}` },
      { status: 502 },
    )
  }

  const provider = getEmbeddingProvider()
  const { meta, files } = ingest

  // Persist the repo first.
  const repo = await db.repo.create({
    data: {
      owner: meta.owner,
      name: meta.name,
      url: meta.url,
      defaultBranch: meta.defaultBranch,
      description: meta.description,
    },
  })

  let totalChunks = 0

  for (const file of files) {
    const lines = file.content.split('\n')
    // Chunk
    let chunks: { ordinal: number; symbolName: string | null; startLine: number; endLine: number; content: string }[] = []
    const lang = file.language as 'ts' | 'tsx' | 'js' | 'jsx' | 'py' | 'go' | 'rs' | 'md'
    if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx') {
      const astChunks = await chunkTsJsAsync(file.content, lang)
      chunks = astChunks.map((c, i) => ({
        ordinal: i + 1,
        symbolName: c.symbolName,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
      }))
    } else {
      const regexChunks = chunkRegex(file.content, 50)
      chunks = regexChunks.map((c) => ({
        ordinal: c.ordinal,
        symbolName: null,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
      }))
    }
    // If the chunker returned nothing (e.g. an empty file), fall back to a
    // single whole-file chunk so we still index it.
    if (chunks.length === 0) {
      chunks = [
        {
          ordinal: 1,
          symbolName: null,
          startLine: 1,
          endLine: lines.length || 1,
          content: file.content,
        },
      ]
    }

    // Persist the file
    const fileRow = await db.file.create({
      data: {
        repoId: repo.id,
        path: file.path,
        language: file.language,
        lineCount: lines.length,
        content: file.content,
      },
    })

    // Embed each chunk
    const chunkRows = await Promise.all(
      chunks.map(async (c) => {
        const vec = await provider.embed(c.content)
        return {
          repoId: repo.id,
          fileId: fileRow.id,
          ordinal: c.ordinal,
          symbolName: c.symbolName,
          startLine: c.startLine,
          endLine: c.endLine,
          content: c.content,
          tokens: JSON.stringify(tokenize(c.content)),
          embedding: serializeVector(vec),
        }
      }),
    )

    // Persist chunks in a single createMany
    await db.repoChunk.createMany({ data: chunkRows })
    totalChunks += chunkRows.length
  }

  invalidateCorpus()

  return NextResponse.json({
    ok: true,
    repoId: repo.id,
    fileCount: files.length,
    chunkCount: totalChunks,
    cap: MAX_FILES,
  })
}

// Reference the embedding provider type so the import stays valid even when
// tree-sitter bindings aren't installed (the chunker falls back to regex).
void (0 as unknown as EmbeddingProvider)
