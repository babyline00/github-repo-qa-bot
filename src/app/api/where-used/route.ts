/**
 * POST /api/where-used
 *
 * Body: { repoId: string, symbolName: string }
 *
 * Returns an array of `{ fileId, filePath, lineMatches, preview }` — one
 * entry per file in the repo where the symbol appears outside comments.
 *
 * Pure regex whole-word match (case-sensitive). Comment-aware via a
 * line-based heuristic that handles the common comment styles per language.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { whereUsed, type WhereUsedInput } from '@/lib/where-used'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface WhereUsedBody {
  repoId: string
  symbolName: string
}

export async function POST(req: NextRequest) {
  let body: WhereUsedBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.repoId || !body.symbolName) {
    return NextResponse.json({ error: 'repoId and symbolName are required' }, { status: 400 })
  }

  const files = await db.file.findMany({
    where: { repoId: body.repoId },
    select: { id: true, path: true, content: true },
  })

  const inputs: WhereUsedInput[] = files.map((f) => ({
    fileId: f.id,
    filePath: f.path,
    content: f.content,
  }))

  const results = whereUsed(body.symbolName, inputs)
  return NextResponse.json({ repoId: body.repoId, symbolName: body.symbolName, results })
}
