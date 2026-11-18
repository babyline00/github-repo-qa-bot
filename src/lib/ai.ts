/**
 * Streaming RAG chat for the GitHub Repo Q&A Bot. Wraps the z-ai-web-dev-sdk
 * chat completion endpoint with a retrieval-augmented system prompt that
 * instructs the model to ground each claim in a retrieved chunk via inline
 * `[^c1]` markers AND `path:line` references (so citations are useful even
 * when copied out of context).
 *
 * Same pluggable-provider seam as Project #1 so the AI layer is swappable.
 */

import type { RetrievedChunk, RetrievedRepoMeta } from '@/lib/retrieval'
import { githubBlobLink } from '@/lib/url-parser'

export interface ChatProvider {
  stream(args: {
    systemPrompt: string
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
  }): AsyncGenerator<string, void, unknown>
}

let cachedProvider: ChatProvider | null = null

class ZaiProvider implements ChatProvider {
  async *stream(args: {
    systemPrompt: string
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
  }): AsyncGenerator<string, void, unknown> {
    const ZAI = (await import('z-ai-web-dev-sdk')).default
    const zai = await ZAI.create()
    const messages = [
      { role: 'system' as const, content: args.systemPrompt },
      ...args.messages,
    ]
    const completion = await zai.chat.completions.create({
      messages,
      stream: true,
      thinking: { type: 'disabled' },
    })

    if (typeof completion === 'string') {
      yield completion
      return
    }
    let body: ReadableStream<Uint8Array> | undefined
    if (completion && typeof (completion as any).getReader === 'function') {
      body = completion as ReadableStream<Uint8Array>
    } else {
      body = (completion as any)?.body ?? (completion as any)?._body
    }
    if (!body) {
      const content = (completion as any)?.choices?.[0]?.message?.content
      if (typeof content === 'string' && content.length > 0) yield content
      return
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') {
          return
        }
        try {
          const obj = JSON.parse(payload)
          const delta = obj?.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            yield delta
          }
        } catch {
          // ignore partial JSON
        }
      }
    }
  }
}

class MockProvider implements ChatProvider {
  async *stream(args: {
    systemPrompt: string
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
  }): AsyncGenerator<string, void, unknown> {
    const lastUser = [...args.messages].reverse().find((m) => m.role === 'user')
    const text = lastUser?.content ?? ''
    yield `**[mock assistant]** You asked: "${text.slice(0, 120)}". ` +
      `(No live LLM configured — set the SDK config to enable real streaming.)`
  }
}

export function getChatProvider(): ChatProvider {
  if (cachedProvider) return cachedProvider
  if (process.env.PKC_DISABLE_LLM === '1') {
    cachedProvider = new MockProvider()
    return cachedProvider
  }
  try {
    cachedProvider = new ZaiProvider()
  } catch (e) {
    console.warn('[chat] ZaiProvider unavailable, using MockProvider:', (e as Error).message)
    cachedProvider = new MockProvider()
  }
  return cachedProvider
}

/** Test-only. */
export function __setChatProviderForTest(p: ChatProvider | null) {
  cachedProvider = p
}

export interface CitationMeta {
  chunkId: string
  repoId: string
  fileId: string
  filePath: string
  symbolName: string | null
  startLine: number
  endLine: number
  preview: string
  /** Pre-built "Open on GitHub" link. */
  githubUrl: string
}

/**
 * Build the RAG system prompt for the GitHub Repo Q&A Bot.
 *
 * The prompt instructs the LLM to:
 *   1. Answer ONLY from the retrieved chunks.
 *   2. Mark every factual claim with an inline `[^c1]` marker that matches
 *      the chunk's citation label.
 *   3. ALSO include a `path:line` reference (e.g. `src/lib/ai.ts:42`) so the
 *      citation is useful when copied out of context.
 *   4. Never fabricate sources or invent quotes.
 *
 * Returns the system prompt and a `citationMap` keyed by chunkId that the
 * UI uses to render the citation footer with "Open on GitHub" links.
 */
export function buildRagSystemPrompt(
  retrieved: RetrievedChunk[],
  repo: RetrievedRepoMeta | null,
): {
  systemPrompt: string
  citationMap: Record<string, CitationMeta>
} {
  if (!retrieved.length) {
    return {
      systemPrompt:
        'You are GitHub Repo Q&A Bot. No files have been imported yet. ' +
        'Answer the user\'s question briefly and tell them to paste a GitHub repo URL in the sidebar to enable grounded answers.',
      citationMap: {},
    }
  }
  const chunkLines: string[] = []
  const citationMap: Record<string, CitationMeta> = {}
  retrieved.forEach((c, i) => {
    const shortId = `c${i + 1}`
    const symbolTag = c.symbolName ? ` › ${c.symbolName}` : ''
    const locationTag = `${c.filePath}:${c.startLine}`
    chunkLines.push(
      `[^${shortId}]: (chunkId=${c.chunkId}) ` +
      `Source: ${locationTag}${symbolTag} (lines ${c.startLine}-${c.endLine})\n` +
      c.content,
    )
    const ref = repo?.defaultBranch ?? 'main'
    const owner = repo?.owner ?? ''
    const name = repo?.name ?? ''
    citationMap[c.chunkId] = {
      chunkId: c.chunkId,
      repoId: c.repoId,
      fileId: c.fileId,
      filePath: c.filePath,
      symbolName: c.symbolName,
      startLine: c.startLine,
      endLine: c.endLine,
      preview: c.content.slice(0, 160).replace(/\s+/g, ' ').trim(),
      githubUrl: githubBlobLink(owner, name, ref, c.filePath, c.startLine, c.endLine),
    }
  })
  const systemPrompt = [
    'You are GitHub Repo Q&A Bot — a RAG assistant that answers questions strictly grounded in chunks retrieved from a public GitHub repository.',
    'Below are the most relevant chunks retrieved from the user\'s imported repository.',
    'Rules:',
    '1. Answer ONLY using the information present in the provided chunks. If the answer is not in the chunks, say "I don\'t see that in the imported files."',
    '2. Every factual claim MUST be followed by BOTH:',
    '   - an inline citation in the form [^c1], [^c2], etc. — the marker MUST match the chunkId label below, AND',
    '   - a `path:line` reference (e.g. `src/lib/ai.ts:42`) so the citation is useful when copied out of context.',
    '3. Do not fabricate sources. Do not invent quotes. Do not paraphrase beyond what the chunks support.',
    '4. When a question asks "where is X used?" or "what does X do?", prefer listing concrete file:line references.',
    '5. Use markdown for structure (lists, code blocks, emphasis) where it improves readability.',
    '',
    'Retrieved chunks:',
    chunkLines.join('\n\n---\n\n'),
  ].join('\n')
  return { systemPrompt, citationMap }
}

/**
 * Map short citation markers like [^c1] in the assistant message back to
 * chunk IDs from the citation map. Returns an ordered list of unique
 * chunkIds actually cited in the message.
 */
export function extractCitations(message: string, retrieved: RetrievedChunk[]): string[] {
  const seen = new Set<string>()
  const re = /\[\^(c\d+)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(message)) !== null) {
    const idx = parseInt(m[1].slice(1), 10) - 1
    if (idx >= 0 && idx < retrieved.length) {
      seen.add(retrieved[idx].chunkId)
    }
  }
  return Array.from(seen)
}
