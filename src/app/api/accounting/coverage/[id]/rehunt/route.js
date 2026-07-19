// RCOV.P2 — queue a single line for an immediate re-hunt (the QStash
// worker / */5min sweeper cron picks it up). For uncovered/not_found
// lines the status is left unchanged — huntLine's own outcome moves
// it. A needs_attention line is RE-OPENED as 'uncovered' in the same
// update: claim_recon_hunt_batch (mig 370) and the QStash worker's CAS
// only claim uncovered/not_found, so re-queuing it as-is would leave a
// row no drain path can ever claim (a permanently-queued board lie;
// pre-finalizer-guard it also wedged the weekly report). The rejected
// find's message-id stays excluded by the hunt engine's own exclusion
// query, and the rejected queue link stays on invoices_queue_id for
// the audit trail.
import { NextResponse } from 'next/server'
import { loadLineForUser } from '../_line'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const ALLOWED_FROM = ['uncovered', 'not_found', 'needs_attention']

// Pure patch builder (unit-tested): the queue fields for a re-hunt,
// plus the needs_attention → uncovered re-open described above.
export function rehuntPatch(line, nowIso) {
  return {
    hunt_queued_at: nowIso,
    hunt_claimed_at: null,
    updated_at: nowIso,
    ...(line.status === 'needs_attention' ? { status: 'uncovered' } : {}),
  }
}

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

  const { error } = await db
    .from('recon_bank_lines')
    .update(rehuntPatch(line, new Date().toISOString()))
    .eq('id', line.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data: { queued: true } })
}
