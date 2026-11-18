/**
 * DELETE /api/repos/[id]
 *
 * Removes a repo and all its files / chunks (cascaded by Prisma schema).
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { invalidateCorpus } from '@/lib/retrieval'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    await db.repo.delete({ where: { id } })
  } catch (e) {
    return NextResponse.json({ error: `Delete failed: ${(e as Error).message}` }, { status: 404 })
  }
  invalidateCorpus()
  return NextResponse.json({ ok: true })
}
