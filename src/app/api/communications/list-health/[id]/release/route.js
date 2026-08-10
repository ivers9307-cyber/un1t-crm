// GAPS-P5 — undo a repeat-bounce escalation.
//
// A suppression an operator cannot reverse is not a suppression, it is a
// deletion. This is the reverse: it closes the email_bounce_escalations row
// (mig 515) with release_reason='operator' and clears the shared hygiene stamp
// contacts.email_suppressed_at, putting the contact back in the marketing
// audience immediately.
//
// TWO CONSEQUENCES WORTH KNOWING, both deliberate:
//   • An operator release is PERMANENT as far as the sweep is concerned — it
//     never re-suppresses that contact for repeat bounces again. A rule that
//     overrules a human every night is not a rule, it is a nag.
//   • The stamp is shared with the nightly engagement sweep (mig 395), so
//     clearing it also clears an inactivity suppression the contact may have
//     been carrying. That is self-correcting rather than lossy: if they still
//     qualify as a 90-day non-opener, the engagement sweep re-stamps them the
//     same night, with its own reason. stamp_was_already_set on the row
//     records whether that was the case when we decided.
//
// Dismissing a `review` row uses the same endpoint: there is no stamp to
// clear, so it is purely an acknowledgement that the operator has looked.
//
// Detail route -> 404, not 403, so escalation ids cannot be enumerated.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { ESCALATION_TABLE, RELEASE_REASON_OPERATOR } from '@/lib/bounce-escalation-sweep'

export const runtime = 'nodejs'

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'email')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  // A malformed id is a 404, not a Postgres cast error surfaced as a 500.
  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const db = createServerClient()

  const { data: row, error } = await db
    .from(ESCALATION_TABLE)
    .select('id, contact_id, location_id, decision, released_at')
    .eq('id', id)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard

  // Already released — report it rather than rewriting who released it and
  // when, which would destroy the audit trail this table exists to hold.
  if (row.released_at) {
    return NextResponse.json({ success: true, data: { id: row.id, alreadyReleased: true } })
  }

  const nowIso = new Date().toISOString()
  const { error: relErr } = await db
    .from(ESCALATION_TABLE)
    .update({
      released_at: nowIso,
      released_by: user.id,
      release_reason: RELEASE_REASON_OPERATOR,
      release_note: 'Released by an operator from the list health page.',
    })
    .eq('id', row.id)
    .is('released_at', null)
  if (relErr) return NextResponse.json({ success: false, error: relErr.message }, { status: 500 })

  // Only a suppression put a stamp on. A review row never did, so clearing
  // one here would silently undo an unrelated inactivity suppression.
  let stampCleared = false
  if (row.decision === 'suppress') {
    const { error: stampErr } = await db
      .from('contacts')
      .update({ email_suppressed_at: null })
      .eq('id', row.contact_id)
      .not('email_suppressed_at', 'is', null)
    if (stampErr) return NextResponse.json({ success: false, error: stampErr.message }, { status: 500 })
    stampCleared = true
  }

  return NextResponse.json({
    success: true,
    data: { id: row.id, released_at: nowIso, decision: row.decision, stampCleared },
  })
}
