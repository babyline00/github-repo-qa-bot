/**
 * GET /api/stats
 *
 * Returns aggregate counts for the stats banner.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const [repos, files, chunks] = await Promise.all([
    db.repo.count(),
    db.file.count(),
    db.repoChunk.count(),
  ])
  return NextResponse.json({ repos, files, chunks })
}
