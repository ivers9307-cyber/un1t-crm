// CONSENT.3 — Consent history feed for the contact profile card.
// GAPS-P6 — plus the CSV export behind ?format=csv.
//
// GET /api/contacts/[id]/consent-log
//   Returns every consent_log row for the contact, joined to
//   profiles so we can show "performed by" as a name instead of a
//   UUID, and to locations so the row says WHICH business was
//   joined or left (mig 487 made consent_log location-aware).
//   Append-only audit table — no PATCH/DELETE on this route.
//
// GET /api/contacts/[id]/consent-log?format=csv
//   The same rows, as a CSV download — the subject-access-request
//   tool. It is deliberately the SAME route rather than a sibling:
//   the location gate below is the fix for a live IDOR (H1, 2026-06
//   platform audit), and a parallel export route would have been a
//   second place for that hole to reappear. One gate, two
//   representations.
//
// Access (H1, 2026-06 platform audit): this route uses
// createServerClient() (service role) which BYPASSES RLS — the
// location-scoped policy on consent_log only binds the `authenticated`
// role, so it does NOT filter this query. We resolve the contact's
// location_id and gate with assertLocationAccess(); without it any
// authenticated user could read any contact's consent history (incl.
// ip_address) by enumerating contact IDs. 404, not 403, so a contact
// id in another tenant is not confirmable by probing.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { normaliseConsentAction } from '@/lib/consent-actions'
import { buildConsentCsv, consentCsvFilename } from '@/lib/consent-csv'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PostgREST returns at most 1,000 rows per select regardless of .limit(),
// so every fetch here is .range()-paginated against an explicit .order().
const PAGE = 1000

// Hard cap for the on-screen feed. A contact would have to bounce in/out of
// consent on every channel daily for a year+ to hit this; if we ever do, the
// card says so and the export (uncapped) has the rest.
const MAX_ROWS = 500

// Runaway guard for the export. Not a truncation policy — if a contact ever
// genuinely has more than this, we refuse rather than hand a compliance
// officer a file that is quietly missing the end of somebody's history.
const CSV_MAX_ROWS = 50000

const SELECT =
  'id, created_at, channel, action, source, ip_address, performed_by, location_id, ' +
  'profiles:performed_by(full_name, email), locations:location_id(name)'

/**
 * Range-paginated read of one contact's consent history, newest first.
 *
 * The secondary sort on `id` is load-bearing, not decoration: a preference
 * change writes ONE ROW PER CHANNEL in a single insert, so three rows share
 * a `created_at` to the microsecond. Ordering on that column alone leaves
 * their relative order undefined, and an undefined order across `.range()`
 * windows silently duplicates some rows and drops others at the page seam.
 *
 * @returns {Promise<{rows: Array, error?: string, overflow?: boolean}>}
 */
async function fetchConsentRows(db, contactId, max) {
  const rows = []
  for (let from = 0; from < max; from += PAGE) {
    const to = Math.min(from + PAGE, max) - 1
    const { data, error } = await db
      .from('consent_log')
      .select(SELECT)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)
    if (error) return { rows: [], error: error.message }
    rows.push(...(data || []))
    if (!data || data.length < to - from + 1) break
  }
  return { rows, overflow: rows.length >= max }
}

// Flatten the joined profile/location so neither the client nor the CSV
// builder has to walk a nested object. performed_by may be null (self-service
// preference centre, the ClassPass auto-trigger, a webhook) — that is a real
// state, rendered in the UI rather than filtered here. `action` is normalised
// onto the canonical vocabulary (GAPS-P6): rows written before mig 516 spell
// an opt-out 'opted_out', and a reader that does not fold those shows a
// withdrawal of consent as if it were something else.
function flatten(r) {
  return {
    id: r.id,
    created_at: r.created_at,
    channel: r.channel,
    action: normaliseConsentAction(r.action),
    source: r.source,
    ip_address: r.ip_address,
    location_name: r.locations?.name || null,
    performed_by_name: r.profiles?.full_name || null,
    performed_by_email: r.profiles?.email || null,
  }
}

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const wantsCsv = new URL(request.url).searchParams.get('format') === 'csv'
  const db = createServerClient()

  // Resolve the contact's location and gate on it before returning any
  // consent rows (H1). A non-existent contact and a contact in another
  // tenant both look the same to the caller (404 either way). The name
  // columns are only used for the download filename.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('location_id, first_name, last_name')
    .eq('id', params.id)
    .maybeSingle()
  if (contactErr) {
    return NextResponse.json({ success: false, error: contactErr.message }, { status: 500 })
  }
  if (!contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  const { rows: raw, error, overflow } = await fetchConsentRows(
    db, params.id, wantsCsv ? CSV_MAX_ROWS : MAX_ROWS,
  )
  if (error) {
    // A partial export is the failure this whole change exists to prevent —
    // a hole in a GDPR evidence trail that nothing announces. Fail the
    // request instead of serving the pages that did come back.
    return NextResponse.json({ success: false, error }, { status: 500 })
  }

  const rows = raw.map(flatten)

  if (wantsCsv) {
    if (overflow) {
      return NextResponse.json({
        success: false,
        error: `Consent history exceeds ${CSV_MAX_ROWS} rows — export refused rather than truncated. Query consent_log directly for this contact.`,
      }, { status: 413 })
    }
    // UTF-8 BOM so Excel renders accented names correctly (same convention
    // as the attendee export).
    return new Response('\uFEFF' + buildConsentCsv(contact, rows), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${consentCsvFilename({ ...contact, id: params.id })}"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  return NextResponse.json({
    success: true,
    rows,
    truncated: rows.length === MAX_ROWS,
  })
}
