/**
 * POST /api/chat
 *
 * Body: { message, sessionId?, filterFileIds?, repoId? }
 *
 * Streaming RAG over the imported repo's chunks. Same streaming protocol
 * as Project #1: text/plain stream of LLM deltas followed by a final
 * `\n---CITATIONS---\n<json>` footer that the client parses for the
 * citation cards. The X-Session-Id header echoes the (possibly new) session
 * id so a brand-new session can be tracked by the client.
 *
 * Each citation card carries { chunkId, repoId, fileId, filePath, symbolName,
 * startLine, endLine, preview, githubUrl } so the UI can render an
 * "Open on GitHub" link to the cited lines.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { retrieve, getRepoMeta, type RetrievedChunk, type RetrievedRepoMeta } from '@/lib/retrieval'
import {
  getChatProvider,
  buildRagSystemPrompt,
  extractCitations,
  type CitationMeta,
} from '@/lib/ai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ChatRequestBody {
  message: string
  sessionId?: string
  filterFileIds?: string[]
  repoId?: string
}

export async function POST(req: NextRequest) {
  let body: ChatRequestBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const message = (body.message ?? '').trim()
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 })
  }

  // 1. Retrieve grounded chunks (optionally filtered by file IDs + repo).
  const retrieved: RetrievedChunk[] = await retrieve(message, {
    filterFileIds: body.filterFileIds,
    repoId: body.repoId,
    topK: 8,
  })

  // 2. Get the repo metadata (for citation github links). When retrieved is
  // empty, fall back to the body's repoId.
  let repoMeta: RetrievedRepoMeta | null = null
  const repoIdForMeta = retrieved[0]?.repoId ?? body.repoId ?? null
  if (repoIdForMeta) {
    repoMeta = await getRepoMeta(repoIdForMeta)
  }

  // 3. Get or create a chat session.
  let sessionId = body.sessionId
  if (!sessionId) {
    const title = message.slice(0, 60) + (message.length > 60 ? '…' : '')
    const session = await db.chatSession.create({ data: { title } })
    sessionId = session.id
  }

  // 4. Load prior messages for context.
  const priorMessages = await db.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  })
  const recent = priorMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-8)
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))

  // 5. Persist the user message.
  await db.chatMessage.create({
    data: { sessionId, role: 'user', content: message },
  })

  // 6. Build the system prompt + citation map.
  const { systemPrompt, citationMap } = buildRagSystemPrompt(retrieved, repoMeta)

  // 7. Stream the assistant response, buffering the full message so we can
  //    persist it after the stream completes.
  const provider = getChatProvider()
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let fullMessage = ''
      try {
        for await (const delta of provider.stream({
          systemPrompt,
          messages: [...recent, { role: 'user', content: message }],
        })) {
          fullMessage += delta
          controller.enqueue(encoder.encode(delta))
        }
      } catch (e) {
        const err = `[stream error] ${(e as Error).message}`
        fullMessage += err
        controller.enqueue(encoder.encode(err))
      }

      // 8. Resolve cited chunk IDs from [^c1] markers and build the citation footer.
      const citedChunkIds = extractCitations(fullMessage, retrieved)
      const citations: CitationMeta[] = citedChunkIds
        .map((cid) => citationMap[cid])
        .filter((c): c is CitationMeta => !!c)

      // 9. Persist the assistant message with citations.
      await db.chatMessage.create({
        data: {
          sessionId,
          role: 'assistant',
          content: fullMessage,
          citations: JSON.stringify(citations),
        },
      })
      await db.chatSession.update({ where: { id: sessionId }, data: { updatedAt: new Date() } })

      // 10. Emit the structured footer for the client.
      const footer =
        '\n\n---CITATIONS---\n' +
        JSON.stringify({ sessionId, citations })
      controller.enqueue(encoder.encode(footer))
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'X-Session-Id': sessionId,
    },
  })
}
