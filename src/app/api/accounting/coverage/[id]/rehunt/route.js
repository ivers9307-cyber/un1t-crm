// RCOV.P2 — queue a single line for an immediate re-hunt (the */5min
// drain cron picks it up). Status is left unchanged — huntLine's own
// outcome moves it; rejected-find exclusions are handled inside the
// hunt engine.
import { NextResponse } from 'next/server'
import { loadLineForUser } from '../_line'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_FROM = ['uncovered', 'not_found', 'needs_attention']

export async function POST(request, { params }) {
  const { id } = await params
  const ctx = await loadLineForUser(id)
  if (ctx.response) return ctx.response
  const { db, line } = ctx

  if (!ALLOWED_FROM.includes(line.status)) {
    return NextResponse.json(
      { success: false, error: `Cannot re-hunt a line in '${line.status}' state.` },
      { status: 409 }
    )
  }

  const nowIso = new Date().toISOString()
  const { error } = await db
    .from('recon_bank_lines')
    .update({ hunt_queued_at: nowIso, hunt_claimed_at: null, updated_at: nowIso })
    .eq('id', line.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data: { queued: true } })
}
