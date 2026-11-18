/**
 * GET /api/repos
 *
 * Returns the list of imported repos with file/chunk counts.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const repos = await db.repo.findMany({
    orderBy: { importedAt: 'desc' },
    include: { _count: { select: { files: true, chunks: true } } },
  })
  return NextResponse.json({ repos })
}
