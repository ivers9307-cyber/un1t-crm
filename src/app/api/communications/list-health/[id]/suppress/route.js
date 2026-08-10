// LISTHEALTH-ACT.1 (mig 520) — act on a `review` row.
//
// GAPS-P5 gave the review cohort one verb: dismiss. That cohort is the one the
// rule deliberately refuses to auto-act on (the address HAS accepted mail
// before, so the bounces could be a mailbox that was full for a stretch), which
// makes it precisely the cohort where a human judgement is the point. An
// operator who looked at three campaigns of failures and concluded the address
// is dead had nowhere to put that conclusion except SQL against
// contacts.email_suppressed_at, and that path writes no audit row. This route
// is that judgement, recorded.
//
// NOTHING HERE IS AUTOMATIC. The sweep still never suppresses a review row; it
// takes an authenticated operator with the email permission, one row at a time.
//
// THE AUDIT TRAIL IS THE SAME ONE THE RULE WRITES. Not a variant, not a note
// field: a real email_bounce_escalations row with decision='suppress', the
// evidence copied forward from the review row it came from, and a `reason` that
// says a human made the call. The order is audit row first, stamp second, for
// the reason bounce-escalation-sweep.js states: a suppression with no
// explanation is unacceptable, an explanation with no suppression is untidy and
// self-heals on the next sweep.
//
// APPEND, DON'T EDIT. The review row is CLOSED (release_reason
// 'operator_suppressed', mig 520) and a new row is opened, rather than the
// review row's decision being flipped in place. The in-place edit would have
// needed no migration and would have destroyed the record that the rule said
// review, which is the same thing the release route refuses to do when it
// declines to rewrite who released a row and when. mig 515's partial unique
// index (one row per contact where released_at is null) also forces the close
// before the insert, so the two are one sequence, not a choice.
//
// UNDO IS THE EXISTING ROUTE. What this creates is an ordinary
// decision='suppress' row, so POST …/[id]/release closes it with
// release_reason='operator' and clears the stamp exactly as it does for an
// automatic suppression, and the sweep's permanent-override then applies.
//
// Detail route -> 404, not 403, so escalation ids cannot be enumerated.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import {
  ESCALATION_TABLE,
  RELEASE_REASON_OPERATOR_SUPPRESSED,
  REASON_OPERATOR_REVIEW_SUPPRESSED,
} from '@/lib/bounce-escalation-sweep'

export const runtime = 'nodejs'

// Everything the audit row needs to stand on its own, carried forward from the
// review row so the new record explains itself without a join back.
const EVIDENCE = 'bounced_campaign_count, bounced_campaign_ids, bounce_types, bounce_events, '
  + 'successful_deliveries, first_bounce_at, last_bounce_at'

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
    .select(`id, contact_id, location_id, decision, released_at, ${EVIDENCE}`)
    .eq('id', id)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard

  // Only the review cohort. A suppression is already suppressed, and offering
  // this on one would mean a second active row for the same contact, which
  // mig 515's partial unique index rejects anyway.
  if (row.decision !== 'review') {
    return NextResponse.json(
      { success: false, error: 'Only a contact awaiting review can be suppressed here.' },
      { status: 400 },
    )
  }
  // Already actioned by someone else. Report it rather than opening a second
  // row for a contact who may already be suppressed.
  if (row.released_at) {
    return NextResponse.json({ success: true, data: { id: row.id, alreadyActioned: true, suppressed: false } })
  }

  // Read the stamp BEFORE touching it: the nightly hygiene sweep (mig 395)
  // stamps the same column for inactivity, and without this an operator
  // releasing the row we are about to write cannot tell whether the stamp they
  // are clearing was ours to clear.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, email_suppressed_at')
    .eq('id', row.contact_id)
    .maybeSingle()
  if (contactErr) return NextResponse.json({ success: false, error: contactErr.message }, { status: 500 })

  const nowIso = new Date().toISOString()

  // CAS on released_at IS NULL — two operators clicking at once must not both
  // get past here, or the second insert trips the one-active-row index.
  const { data: closed, error: closeErr } = await db
    .from(ESCALATION_TABLE)
    .update({
      released_at: nowIso,
      released_by: user.id,
      release_reason: RELEASE_REASON_OPERATOR_SUPPRESSED,
      release_note: 'Escalated to a suppression by an operator from the list health page.',
    })
    .eq('id', row.id)
    .is('released_at', null)
    .select('id')
  if (closeErr) return NextResponse.json({ success: false, error: closeErr.message }, { status: 500 })
  if (!closed || closed.length === 0) {
    return NextResponse.json({ success: true, data: { id: row.id, alreadyActioned: true, suppressed: false } })
  }

  // The audit row, before the stamp. If this fails the contact is NOT
  // suppressed and the review row is closed with nothing recorded against it —
  // untidy, and self-healing: the sweep skips only rows released as 'operator',
  // so this contact is re-evaluated on the next run and a fresh review row
  // appears.
  const { data: inserted, error: insertErr } = await db
    .from(ESCALATION_TABLE)
    .insert({
      contact_id: row.contact_id,
      location_id: row.location_id,
      decision: 'suppress',
      reason: REASON_OPERATOR_REVIEW_SUPPRESSED,
      bounced_campaign_count: row.bounced_campaign_count,
      bounced_campaign_ids: row.bounced_campaign_ids || [],
      bounce_types: row.bounce_types || [],
      bounce_events: row.bounce_events ?? 0,
      successful_deliveries: row.successful_deliveries ?? 0,
      first_bounce_at: row.first_bounce_at,
      last_bounce_at: row.last_bounce_at,
      evaluated_at: nowIso,
      stamp_was_already_set: Boolean(contact?.email_suppressed_at),
      suppressed_at: nowIso,
    })
    .select('id')
    .maybeSingle()
  if (insertErr) {
    return NextResponse.json({ success: false, error: insertErr.message }, { status: 500 })
  }

  // Same guard the sweep uses: a stamp that landed between our read and this
  // write (hygiene sweep, or a concurrent action) wins, and the row above
  // already recorded that it was there first.
  const { error: stampErr } = await db
    .from('contacts')
    .update({ email_suppressed_at: nowIso })
    .eq('id', row.contact_id)
    .is('email_suppressed_at', null)
  if (stampErr) return NextResponse.json({ success: false, error: stampErr.message }, { status: 500 })

  return NextResponse.json({
    success: true,
    data: {
      id: inserted?.id || null,
      reviewed_id: row.id,
      decision: 'suppress',
      suppressed: true,
      stamp_was_already_set: Boolean(contact?.email_suppressed_at),
    },
  })
}
