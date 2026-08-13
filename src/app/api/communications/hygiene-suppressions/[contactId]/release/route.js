// HYGREL.1 — release a contact from an engagement-hygiene suppression.
//
// KEYED ON THE CONTACT, NOT AN ESCALATION ROW. That is the entire point. The
// existing release route (…/list-health/[id]/release) takes an
// email_bounce_escalations id, so it can only undo what the bounce sweep did.
// The engagement sweep writes no row, so 1,107 of the 1,128 contacts suppressed
// on 2026-08-12 had no id to hand it and no release path at any URL.
//
// A RELEASE HERE IS PERMANENT, AND HAS TO BE. A released contact still meets
// every criterion the nightly sweep tests (3+ marketing sends in 90 days, zero
// opens, zero clicks, first send >90 days ago) — that is why they were stamped.
// Clearing email_suppressed_at alone would last until 05:15 the same night. So
// the write is a pair: clear the stamp AND set contacts.email_hygiene_released_at
// (mig 535), which the sweep filters on. Same rule the bounce release route
// states: a rule that overrules a human every night is not a rule, it is a nag.
//
// A BOUNCE-OWNED STAMP IS REFUSED, NOT SILENTLY STOLEN. If an active
// decision='suppress' escalation exists, that mechanism owns the stamp and has
// its own audit row that must close WITH the release. Clearing it from here
// would leave an open escalation asserting a suppression that no longer exists,
// which is the state mig 515 exists to make impossible. The operator is pointed
// at the Restore control on the repeat-bounce table instead.
//
// IDEMPOTENT. A second call on an already-released contact is a success that
// writes nothing, mirroring the bounce route's refusal to rewrite who released
// a row and when — the audit trail is the product here, not a side effect.
//
// Detail route -> 404, not 403, so contact ids cannot be enumerated.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { ESCALATION_TABLE } from '@/lib/bounce-escalation-sweep'
import { HYGIENE_RELEASES_TABLE } from '@/lib/email-hygiene'

export const runtime = 'nodejs'

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'email')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const { contactId } = await params
  // A malformed id is a 404, not a Postgres cast error surfaced as a 500.
  if (!uuidLike.safeParse(contactId).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const { searchParams } = new URL(request.url)
  const requestedLocation = searchParams.get('location_id')
  if (requestedLocation && !uuidLike.safeParse(requestedLocation).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const locationId = requestedLocation || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard

  const db = createServerClient()

  // Resolve the contact THROUGH the per-location audience view rather than
  // straight off contacts. Two things fall out of that and both are load
  // bearing: a contact on nobody's list at this location is a 404 (the tenant
  // boundary, since the service-role client bypasses RLS), and
  // audience_location_id is the value written to the audit row — the list the
  // release was made from. The pair (contact, location) is unique in the view.
  const { data: contact, error } = await db
    .from('contact_location_audience')
    .select('id, email_suppressed_at, email_hygiene_released_at, pipeline_stage_slug, audience_location_id')
    .eq('id', contactId)
    .eq('audience_location_id', locationId)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!contact) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // Already free. Report it rather than writing a second audit row for a
  // release that did nothing — a release log padded with no-ops is a log an
  // operator stops reading.
  if (!contact.email_suppressed_at) {
    return NextResponse.json({
      success: true,
      data: {
        contact_id: contact.id,
        alreadyReleased: true,
        released_at: contact.email_hygiene_released_at || null,
      },
    })
  }

  const { data: escalation, error: escErr } = await db
    .from(ESCALATION_TABLE)
    .select('id')
    .eq('contact_id', contactId)
    .eq('decision', 'suppress')
    .is('released_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (escErr) return NextResponse.json({ success: false, error: escErr.message }, { status: 500 })
  if (escalation) {
    return NextResponse.json({
      success: false,
      error: 'This contact is suppressed for repeat bounces. Restore them from the repeat-bounce table so the '
        + 'record of that decision closes with the release.',
    }, { status: 400 })
  }

  const nowIso = new Date().toISOString()

  // AUDIT ROW FIRST, STAMP SECOND — the order bounce-escalation-sweep.js and
  // the /suppress route both argue for, applied to the mirror case. If the
  // update below fails the contact stays suppressed and an unfulfilled release
  // row is left behind: untidy, visible, and correctable by pressing the button
  // again. The reverse order fails to a contact who is mailable again with
  // nothing on record saying who decided that, which is the state this whole
  // feature exists to end.
  const { data: auditRow, error: auditErr } = await db
    .from(HYGIENE_RELEASES_TABLE)
    .insert({
      contact_id: contact.id,
      location_id: contact.audience_location_id,
      released_by: user.id,
      released_at: nowIso,
      note: 'Released from an engagement-hygiene suppression by an operator on the list health page.',
      suppressed_at: contact.email_suppressed_at,
      pipeline_stage_slug: contact.pipeline_stage_slug || null,
    })
    .select('id')
    .maybeSingle()
  if (auditErr) return NextResponse.json({ success: false, error: auditErr.message }, { status: 500 })

  // NO compare-and-set here, unlike every other writer of this column, and the
  // exception is deliberate. The usual guard (…is('email_suppressed_at', null)
  // on the way in, .not(…) on the way out) exists so a concurrent clear wins.
  // A concurrent clear here — an open/click webhook, or a second operator —
  // agrees with us about the stamp and disagrees about nothing, while
  // email_hygiene_released_at MUST land in every one of those orderings: it is
  // the only thing standing between this release and the 05:15 sweep stamping
  // the contact straight back. Losing the race would mean losing the release.
  // An unconditional write of both columns is idempotent by construction.
  const { error: stampErr } = await db
    .from('contacts')
    .update({ email_suppressed_at: null, email_hygiene_released_at: nowIso })
    .eq('id', contact.id)
  if (stampErr) return NextResponse.json({ success: false, error: stampErr.message }, { status: 500 })

  return NextResponse.json({
    success: true,
    data: {
      contact_id: contact.id,
      release_id: auditRow?.id || null,
      released_at: nowIso,
      alreadyReleased: false,
    },
  })
}
