// RCOV.P2 — reverse an ignore: the line returns to 'uncovered' and
// re-enters normal hunting/seeding on the next cycle.
import { NextResponse } from 'next/server'
import { loadLineForUser } from '../_line'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, { params }) {
  const { id } = await params
  const ctx = await loadLineForUser(id)
  if (ctx.response) return ctx.response
  const { db, line } = ctx

  if (line.status !== 'ignored') {
    return NextResponse.json(
      { success: false, error: `Only ignored lines can be un-ignored (this one is '${line.status}').` },
      { status: 409 }
    )
  }

  const nowIso = new Date().toISOString()
  const { error } = await db
    .from('recon_bank_lines')
    .update({
      status: 'uncovered',
      ignore_reason: null,
      ignored_by: null,
      ignored_at: null,
      updated_at: nowIso,
    })
    .eq('id', line.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
