// POST /api/admin/webhook-dead-letter/[id]/resolve — the human acknowledge
// path (DEADLETTER-UI.1).
//
// WHO. Master, or OWNER AT THE ROW'S LOCATION — the same judgement the replay
// route makes, through the same helpers (./_helpers.js), so the two actions
// on a row can never disagree about who may take them. It used to gate on
// `user.role === 'owner'` (the caller's ACTIVE-studio role) with no row check,
// so an owner in org B could resolve org A's rows by walking the bigserial id.
// A row the caller cannot see answers 404, not 403, and the visibility check
// runs BEFORE the row-state answer (a 409 for an invisible row would confirm
// the id exists). A NULL-location inbound row follows where its recipient
// routes today; any other NULL row is master-only.
//
// Most email-family dead letters are DELIBERATELY not auto-replayable
// (postmark_queue would reset an exhausted retry budget; email_ticket_* would
// double-send mail the member already has — see src/lib/postmark-queue.js and
// src/lib/webhook-replay.js). For those, "handled" is something a human did
// outside this table: re-filed the mail, configured the missing mailbox,
// suppressed the address. This route records that decision so the row stops
// counting against integration health.
//
// Body: { status?: 'resolved' | 'discarded' } — default 'resolved'.
//   resolved  = a human dealt with the event.
//   discarded = a human decided it needs no action (spam to an unknown
//               address, a test payload). Same effect on the health count;
//               kept distinct so the record says which call was made.
//
// Only 'pending' and 'failed' rows can be acknowledged; already-terminal rows
// answer 409. NO auto-processing hides here — the route writes status columns
// and nothing else.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { resolveDeadLetterLocation, canReplayDeadLetter } from '../../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_TARGETS = new Set(['resolved', 'discarded'])

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  // Next 16 hands route handlers a PROMISE for params. Reading `params.id`
  // synchronously was `undefined`, so every Resolve/Discard click 400'd
  // "Missing id" in production (MAIL-DEADLETTER.1). `await` also accepts a
  // plain object, so direct callers are unaffected.
  const { id } = await params
  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 })
  }

  let body = {}
  try { body = await request.json() } catch { /* empty body → default */ }
  const target = body?.status ?? 'resolved'
  if (!ALLOWED_TARGETS.has(target)) {
    return NextResponse.json({
      success: false,
      error: `Invalid status. Must be one of: ${[...ALLOWED_TARGETS].join(', ')}`,
    }, { status: 400 })
  }

  const db = createServerClient()

  const { data: row, error: fetchErr } = await db
    .from('webhook_dead_letter')
    .select('id, status, provider, payload, location_id')
    .eq('id', id)
    .single()
  if (fetchErr || !row) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // Visibility BEFORE any state answer — same order as the replay route.
  const locationId = await resolveDeadLetterLocation(db, row)
  if (!canReplayDeadLetter(user, locationId)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  if (row.status !== 'pending' && row.status !== 'failed') {
    return NextResponse.json({ success: false, error: `Row already ${row.status}` }, { status: 409 })
  }

  // resolved_at is stamped for BOTH targets — it is what the integration-
  // health count keys on (`resolved_at IS NULL`), and a discarded row must
  // stop nagging exactly like a resolved one.
  const { error: updErr } = await db
    .from('webhook_dead_letter')
    .update({ status: target, resolved_at: new Date().toISOString() })
    .eq('id', id)
  if (updErr) {
    return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { id: row.id, status: target } })
}
