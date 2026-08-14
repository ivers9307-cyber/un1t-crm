// GET /api/cron/consent-drift-check — daily check that the two consent tables
// still agree (CLASSPASS-CONSENT.2).
//
// Marketing consent lives in two places: contact_preferences (the global row an
// operator sees in the CRM) and contact_location_preferences (the per-location
// row the SENDER reads, via contact_location_audience.loc_email_marketing —
// campaign-sender.js gates on `.eq('loc_email_marketing', true)`).
//
// They drifted apart silently and nothing looked. mig 544 fixed the cause: on a
// contact INSERTED already at classpass_payg, the ClassPass opt-out trigger
// fires BEFORE the trigger that creates the location row (Postgres orders AFTER
// triggers alphabetically by name), so the opt-out fanned out to zero rows and
// the location row was then created DEFAULT true. Eleven ClassPass contacts sat
// logged as opted out of all six channels while still passing the sender's
// consent gate. Nobody would have found that without a complaint.
//
// This is the standing check for the NEXT cause, whatever it turns out to be.
// It reports rather than repairs: an automatic fix would paper over a live
// write-path bug and make the next one just as invisible as this one was.
//
// Bearer CRON_SECRET. Heartbeat on a clean run only, so a query failure
// surfaces as staleness rather than a silent green.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Contacts opted out of email marketing globally but still mailable on a
 * location list. Backed by the mig 544 consent_drift_rows() function, which
 * excludes source='waitlist_form' — that shape is the legitimate LEADCAP.1
 * case (opted out at Stillorgan, opted IN to the Hatch Street waitlist).
 *
 * Returns [] on failure rather than throwing: the caller distinguishes the two
 * by the returned error, and a thrown query must not take the route down
 * before it can report.
 */
export async function findConsentDrift(db) {
  const { data, error } = await db.rpc('consent_drift_rows')
  if (error) {
    console.error('[consent-drift-check] query failed:', error.message)
    return { rows: [], error: error.message }
  }
  return { rows: data || [], error: null }
}

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { rows, error } = await findConsentDrift(db)

  if (error) {
    // No heartbeat — a failed check must go stale, not report success.
    return NextResponse.json({ success: false, error }, { status: 500 })
  }

  if (rows.length > 0) {
    console.error(
      `[consent-drift-check] ${rows.length} contact(s) opted out of email marketing globally but still mailable at a location: ` +
      rows.map(r => r.email).join(', '),
    )
  }

  await stampHeartbeat('consent-drift-check')
  return NextResponse.json({ success: true, data: { drift: rows.length, contacts: rows } })
}
