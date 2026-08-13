// HYGREL.1 — who is actually being held back, by name.
//
// The list-health page has shown a "Suppressed" COUNT since GAPS-P5 and has
// never shown a single name behind it. Measured on prod 2026-08-12 that count
// was 1,128, of which 21 had an email_bounce_escalations row (mig 515) and were
// therefore listed and releasable. The other 1,107 existed only as a number:
// stamped by the nightly engagement sweep, which writes no audit row, and
// reachable only by hand-written SQL. This endpoint is the missing half.
//
// ONE VIEW, TWO MECHANISMS. contacts.email_suppressed_at (mig 395) is written
// by both sweeps, so a row here says which one owns it (has_bounce_escalation).
// That matters operationally, not decoratively: a bounce-owned stamp must be
// released through the escalation route so its audit row closes with it, and
// the release endpoint beside this one refuses those on purpose.
//
// SAME SOURCE AS THE HEADLINE NUMBER. The rows come from
// contact_location_audience (mig 491) under exactly the filters the page's
// "Suppressed" stat uses — loc_email_marketing = true AND email_suppressed_at
// IS NOT NULL. A list that disagrees with the number printed above it is worse
// than no list, which is the same rule the page's own header comment states.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { ESCALATION_TABLE } from '@/lib/bounce-escalation-sweep'
import { HYGIENE_LIST_PAGE_DEFAULT, HYGIENE_LIST_PAGE_MAX } from '@/lib/email-hygiene'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const COLUMNS = 'id, name, email, email_suppressed_at, email_status, pipeline_stage_slug, '
  + 'email_hygiene_released_at, audience_location_id'

function intParam(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'email')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const requestedLocation = searchParams.get('location_id')
  // A malformed location is a 404, not a Postgres cast error surfaced as a 500
  // — and 404 rather than 400 so a probe cannot tell a bad uuid from a real
  // location it has no access to.
  if (requestedLocation && !uuidLike.safeParse(requestedLocation).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const locationId = requestedLocation || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard

  const limit = intParam(searchParams.get('limit'), HYGIENE_LIST_PAGE_DEFAULT, 1, HYGIENE_LIST_PAGE_MAX)
  const offset = intParam(searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)

  const db = createServerClient()

  // .range() + an explicit .order() is mandatory, not stylistic: every
  // .select() returns at most 1,000 rows whatever .limit() says, and this
  // population is already larger than that. The SECOND .order('id') is the
  // stable tiebreak — the engagement sweep stamps thousands of contacts inside
  // one 05:15 run, so email_suppressed_at alone is not unique and offset paging
  // over it would repeat and skip rows.
  //
  // count: 'exact' rides on the FIRST .select() after .from(); a .select()
  // chained after a filter silently ignores its options.
  const { data, error, count } = await db
    .from('contact_location_audience')
    .select(COLUMNS, { count: 'exact' })
    .eq('audience_location_id', locationId)
    .eq('loc_email_marketing', true)
    .not('email_suppressed_at', 'is', null)
    .order('email_suppressed_at', { ascending: false })
    .order('id')
    .range(offset, offset + limit - 1)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const rows = data || []
  const ids = rows.map((r) => r.id)

  // Which of these stamps belong to the bounce mechanism. A second bounded
  // read rather than an embed: an embedded-resource filter breaks the count
  // path above (CLASSIFY.1), and the id set is one page, never more than
  // HYGIENE_LIST_PAGE_MAX.
  //
  // Deliberately NOT filtered by location_id. The ids are already bounded to
  // this location's audience by the query above, so there is nothing to
  // enumerate — and an escalation is recorded at the contact's HOME location
  // (mig 515), which is not always the list they appear on. Filtering here
  // would report "no escalation" for a crossover contact and offer a release
  // button that the release endpoint then refuses.
  const bounceOwned = new Set()
  if (ids.length > 0) {
    const { data: escalations, error: escErr } = await db
      .from(ESCALATION_TABLE)
      .select('contact_id')
      .in('contact_id', ids)
      .eq('decision', 'suppress')
      .is('released_at', null)
      .order('contact_id')
    if (escErr) return NextResponse.json({ success: false, error: escErr.message }, { status: 500 })
    for (const row of escalations || []) bounceOwned.add(row.contact_id)
  }

  return NextResponse.json({
    success: true,
    data: {
      rows: rows.map((r) => ({
        contact_id: r.id,
        name: r.name || null,
        email: r.email || null,
        email_status: r.email_status || null,
        pipeline_stage_slug: r.pipeline_stage_slug || null,
        suppressed_at: r.email_suppressed_at,
        // A contact can carry both: released once, then re-suppressed for
        // bounces. Surfacing the earlier release stops an operator reading a
        // repeat listing as the release having silently failed.
        previously_released_at: r.email_hygiene_released_at || null,
        has_bounce_escalation: bounceOwned.has(r.id),
      })),
      total: count ?? 0,
      offset,
      limit,
      location_id: locationId,
    },
  })
}
