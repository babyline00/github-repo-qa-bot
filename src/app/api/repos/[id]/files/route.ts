/**
 * GET /api/repos/[id]/files
 *
 * Returns the file tree of a repo (with chunk counts per file) for the
 * sidebar file filter. Excludes the raw file content to keep the payload
 * small.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const repo = await db.repo.findUnique({ where: { id } })
  if (!repo) {
    return NextResponse.json({ error: 'Repo not found' }, { status: 404 })
  }
  const files = await db.file.findMany({
    where: { repoId: id },
    orderBy: { path: 'asc' },
    select: {
      id: true,
      path: true,
      language: true,
      lineCount: true,
      _count: { select: { chunks: true } },
    },
  })
  return NextResponse.json({ repo, files })
}
