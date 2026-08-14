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

// PMSUPP.1 — this cron now also reconciles our database against POSTMARK's
// own suppression list for the marketing stream, in BOTH directions. Read
// reconcilePostmarkSuppressions below for why the two directions are handled
// differently; the short version is that one of them only ever adds a refusal
// and the other would infer a consent change, which is the class of silent
// write that caused the incident above.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { MARKETING_STREAM } from '@/lib/postmark'
import { listPostmarkSuppressions, suppressAtPostmark } from '@/lib/postmark-suppressions'
import { CONSENT_ACTIONS, LEGACY_CONSENT_ACTIONS, isConsentOptOut } from '@/lib/consent-actions'
import { CONSENT_SOURCE_CATEGORIES, sourcesInCategory } from '@/lib/consent-sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// CLAUDE.md — every .select() returns at most 1,000 rows regardless of
// .limit(), so both reads below .range()-paginate under an explicit .order().
export const PAGE_SIZE = 1000

// How many suppressions ONE run may push. The first run after this ships has
// a standing backlog to clear (every opt-out ever taken through our own
// surfaces), and a cron that tries to make thousands of Postmark calls in one
// invocation is a timeout, not a repair. The set is ordered, healed addresses
// drop out of it, and the job runs daily — so it converges, and the response
// reports what is left.
export const MAX_SUPPRESSIONS_PER_RUN = 500

// PMSUPP.1 — WHICH opt-outs the auto-heal is allowed to push, by
// consent_log.source. Derived from the GAPS-P7 taxonomy in
// @/lib/consent-sources rather than hand-listed, so a source added there is
// classified once and this set follows.
//
//   VOLUNTARY      → push. A person's own decision: an unsubscribe link, the
//                    preference centre, a form, or staff recording a choice
//                    somebody made at the desk.
//   BULK           → skip. Imported state and one-off corrections.
//   POLICY         → skip. A standing rule reclassified them; nobody left.
//   DELIVERABILITY → skip. Postmark is where those came from in the first
//                    place, and it already refuses the address.
//
// THE ONE ADDITION BEYOND VOLUNTARY is `duplicate_propagation` (DUPEUNSUB.1),
// which the taxonomy files under POLICY. That classification is right for what
// it was written for — the NET LIST CHANGE headline excludes it so one
// person's decision is not counted once per duplicate record we happen to
// hold. But in SUBSTANCE it mirrors a genuine opt-out onto another address the
// same person owns, and suppressing that address is exactly the belt-and-
// braces this change buys everywhere else. It is an exception on purpose, not
// a taxonomy mistake.
export const AUTO_HEAL_SOURCES = Object.freeze(
  [...sourcesInCategory(CONSENT_SOURCE_CATEGORIES.VOLUNTARY), 'duplicate_propagation'].sort(),
)

// Both spellings. mig 516 backfilled 'opted_out' to 'opt_out', but
// consent-actions.js keeps the legacy vocabulary precisely so a reader is
// correct against anything restored from an older dump — deriving the list
// from it beats writing 'opted_out' out by hand and forgetting why.
const OPT_OUT_ACTIONS = Object.freeze([
  CONSENT_ACTIONS.OPT_OUT,
  ...Object.keys(LEGACY_CONSENT_ACTIONS).filter(isConsentOptOut),
])

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

/**
 * Page through a query under an explicit order, honouring the 1,000-row cap.
 * `build(from, to)` must return a fresh query builder each call — a builder is
 * single-use.
 *
 * Returns { rows, error }: same posture as findConsentDrift above, because a
 * partial read must never be mistaken for a complete one. Half the mailable
 * set would make the auto-heal suppress people who are still opted in
 * somewhere, which is the one thing it must never do.
 */
async function pageAll(build, label) {
  const rows = []
  for (let page = 0; ; page += 1) {
    const from = page * PAGE_SIZE
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) {
      console.error(`[consent-drift-check] ${label} read failed:`, error.message)
      return { rows: [], error: `${label}: ${error.message}` }
    }
    const batch = data || []
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return { rows, error: null }
  }
}

/**
 * Addresses our database says are opted out of email marketing GLOBALLY.
 *
 * contacts.email_marketing is the denormalised mirror of
 * contact_preferences.email_marketing (mig 155 trigger) — the same column the
 * audience builder used before LOCCOMMS.3, and still the honest answer to "is
 * this person globally opted out". A location-scoped opt-out deliberately does
 * NOT appear here: it leaves the global row true, and a Postmark suppression
 * is server-wide.
 */
export async function loadOptedOutEmails(db) {
  return pageAll(
    (from, to) => db
      .from('contacts')
      .select('id, email')
      .eq('email_marketing', false)
      .not('email', 'is', null)
      .order('id', { ascending: true })
      .range(from, to),
    'contacts',
  )
}

/**
 * Addresses the SENDER would still mail marketing to, anywhere.
 *
 * The filters mirror buildAudienceQuery exactly — per-location consent on
 * contact_location_audience (mig 491), plus the reputation and repeat-bounce
 * gates — so "mailable" here means what it means at send time, not something
 * adjacent to it.
 *
 * Ordered by (id, audience_location_id): id alone is NOT unique on this view
 * (one row per list the contact is on), and .range() over a non-unique sort
 * silently drops and repeats rows at the page boundaries.
 */
export async function loadMailableEmails(db) {
  return pageAll(
    (from, to) => db
      .from('contact_location_audience')
      .select('id, email, audience_location_id')
      .eq('loc_email_marketing', true)
      .not('email_status', 'in', '("bounced","complained")')
      .is('email_suppressed_at', null)
      .not('email', 'is', null)
      .order('id', { ascending: true })
      .order('audience_location_id', { ascending: true })
      .range(from, to),
    'contact_location_audience',
  )
}

/**
 * The contacts whose email-marketing opt-out was a PERSON'S DECISION, by
 * consent_log.source (see AUTO_HEAL_SOURCES).
 *
 * Evidence, not state: this says why the opt-out happened, and the caller
 * intersects it with contacts.email_marketing = false, which says whether it
 * still holds. Somebody who opted out voluntarily and later opted back in is
 * excluded by that intersection, not by this query.
 */
export async function loadVoluntaryOptOutContactIds(db) {
  const { rows, error } = await pageAll(
    (from, to) => db
      .from('consent_log')
      .select('id, contact_id')
      .eq('channel', 'email_marketing')
      .in('action', OPT_OUT_ACTIONS)
      .in('source', AUTO_HEAL_SOURCES)
      .order('id', { ascending: true })
      .range(from, to),
    'consent_log',
  )
  if (error) return { ids: null, error }
  return { ids: new Set(rows.map(r => r.contact_id)), error: null }
}

const lower = (e) => String(e || '').trim().toLowerCase()

/**
 * Reconcile our consent state against Postmark's suppression list on the
 * marketing stream, in both directions.
 *
 * ┌─ THE ASYMMETRY IS THE POINT ─────────────────────────────────────────────┐
 * │ WE SAY OPTED OUT, POSTMARK IS NOT SUPPRESSED → AUTO-HEAL.                │
 * │   Pushing the suppression only ever ADDS a refusal. It cannot make       │
 * │   anybody newly mailable and it cannot change a consent record, so it is │
 * │   safe to do unattended. This is the direction that closes the gap this  │
 * │   whole change exists for: opt-outs taken on OUR surfaces never reached  │
 * │   Postmark, so our database was the single gate — and mig 544 is what a  │
 * │   single gate failing looks like.                                        │
 * │                                                                          │
 * │ POSTMARK IS SUPPRESSED, WE SAY MAILABLE → REPORT ONLY. NEVER WRITE.      │
 * │   It usually means we missed an opt-out. But "usually" is not "always",  │
 * │   and inferring a consent change from a suppression and writing it       │
 * │   unattended is exactly the silent write that produced the incident this │
 * │   cron was built for. It also has an equally wrong repair in the other   │
 * │   direction (lifting Postmark's suppression), which would reactivate a   │
 * │   hard bounce. A human decides; the job reports.                         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Never throws. Returns `{ error }` set when it could not complete, which the
 * caller turns into "no heartbeat" — a check that could not look must go
 * stale rather than report health it never measured.
 */
export async function reconcilePostmarkSuppressions(db, { stream = MARKETING_STREAM } = {}) {
  const empty = {
    missingSuppression: 0, suppressed: 0, suppressFailed: 0, remaining: 0,
    suppressedButMailable: 0, byReason: {}, suppressedButMailableSample: [],
  }

  // Read Postmark FIRST. An empty list from a failed dump would read as
  // "nothing is suppressed" and push the entire opted-out backlog for no
  // reason — listPostmarkSuppressions returns an explicit error so it cannot.
  const { suppressions, error: pmError } = await listPostmarkSuppressions({ stream })
  if (pmError) return { ...empty, error: `postmark: ${pmError}` }

  const { rows: optedOut, error: optedOutError } = await loadOptedOutEmails(db)
  if (optedOutError) return { ...empty, error: optedOutError }

  const { rows: mailableRows, error: mailableError } = await loadMailableEmails(db)
  if (mailableError) return { ...empty, error: mailableError }

  const { ids: voluntaryOptOuts, error: voluntaryError } = await loadVoluntaryOptOutContactIds(db)
  if (voluntaryError) return { ...empty, error: voluntaryError }

  // Case-insensitive on every axis: contacts are stored mixed-case in this
  // database and Postmark echoes whatever casing it was given.
  const mailable = new Set(mailableRows.map(r => lower(r.email)))
  const suppressedReason = new Map(
    suppressions.filter(s => s?.EmailAddress).map(s => [lower(s.EmailAddress), s.SuppressionReason || 'Unknown']),
  )

  // ── Direction 1: auto-heal ────────────────────────────────────────
  //
  // TWO FILTERS, EACH FOR A DIFFERENT REASON.
  //
  // 1. STILL MAILABLE SOMEWHERE → skip. "Opted out globally" alone is not
  //    enough: someone opted out globally but opted IN at one location (the
  //    LEADCAP.1 waitlist shape, the case consent_drift_rows itself excludes)
  //    is genuinely mailable there, and a Postmark suppression is per
  //    (server, stream) — it would silently kill the mail they asked for.
  //
  // 2. NOT A PERSON'S DECISION → skip (AUTO_HEAL_SOURCES, above). This is a
  //    SCOPING choice, made by the owner on measured numbers rather than a
  //    technical limit: 5,177 addresses are opted out and unsuppressed today,
  //    but 3,963 of them are `bulk_import` and 1,533 `auto_classpass_backfill`
  //    — imported opted-out state and ClassPass relay addresses, never
  //    subscribers who left. Only ~132 are somebody's actual decision.
  //
  //    Pushing all 5,177 would take ten days at the cap and, worse, would turn
  //    Postmark's suppression list into a 5,000-row mirror of our own database.
  //    That list is currently a READABLE RECORD of who asked to leave and how
  //    — its `Origin` and `SuppressionReason` were used on 2026-08-14 to
  //    reconstruct what had happened to these opt-outs in the first place.
  //    Drowning 132 decisions in 5,000 imported rows spends that forensic
  //    value for no added protection: the bulk rows are already refused by our
  //    own database, which is the gate that was never in doubt for them.
  //
  //    The decision is "backfill the genuine ones, forward-suppress everything
  //    new" — the forward half is the route-level suppression in
  //    /api/unsubscribe and /api/preferences, whose paths are voluntary by
  //    construction and therefore need no source check at all.
  const missing = []
  const seen = new Set()
  for (const contact of optedOut) {
    const key = lower(contact.email)
    if (!key || seen.has(key)) continue
    if (mailable.has(key) || suppressedReason.has(key)) continue
    if (!voluntaryOptOuts.has(contact.id)) continue
    seen.add(key)
    missing.push(contact.email)
  }

  const toPush = missing.slice(0, MAX_SUPPRESSIONS_PER_RUN)
  let suppressed = 0
  let suppressFailed = 0
  if (toPush.length > 0) {
    const result = await suppressAtPostmark(toPush, { stream })
    suppressed = result?.ok || 0
    suppressFailed = result?.failed?.length || 0
    console.error(
      `[consent-drift-check] ${missing.length} contact(s) opted out in the CRM were not suppressed at Postmark — ` +
      `pushed ${suppressed}, failed ${suppressFailed}, ${Math.max(missing.length - toPush.length, 0)} left for the next run`,
    )
  }

  // ── Direction 2: report only ──────────────────────────────────────
  const suppressedButMailable = mailableRows
    .filter(r => suppressedReason.has(lower(r.email)))
    .reduce((acc, r) => {
      const key = lower(r.email)
      if (!acc.seen.has(key)) {
        acc.seen.add(key)
        acc.rows.push({ email: r.email, reason: suppressedReason.get(key) })
      }
      return acc
    }, { seen: new Set(), rows: [] }).rows

  const byReason = {}
  for (const r of suppressedButMailable) byReason[r.reason] = (byReason[r.reason] || 0) + 1

  if (suppressedButMailable.length > 0) {
    console.error(
      `[consent-drift-check] ${suppressedButMailable.length} address(es) are SUPPRESSED AT POSTMARK but still mailable in the CRM ` +
      `(${JSON.stringify(byReason)}) — most likely an opt-out we missed. NOT auto-repaired: inferring a consent change ` +
      `unattended is the silent write this check exists to catch. Sample: ` +
      suppressedButMailable.slice(0, 20).map(r => `${r.email} (${r.reason})`).join(', '),
    )
  }

  return {
    error: null,
    missingSuppression: missing.length,
    suppressed,
    suppressFailed,
    remaining: Math.max(missing.length - toPush.length, 0),
    suppressedButMailable: suppressedButMailable.length,
    byReason,
    // Capped so the JSON response stays readable; the console line above
    // carries the operator-facing sample.
    suppressedButMailableSample: suppressedButMailable.slice(0, 50),
  }
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

  // PMSUPP.1 — the second half of the check: our database vs Postmark.
  const postmark = await reconcilePostmarkSuppressions(db)
  if (postmark.error) {
    // Same rule as the drift query above — no heartbeat. A reconciliation that
    // could not read one of its two sides has not checked anything, and going
    // stale is how that surfaces. Nothing customer-facing depends on this
    // route, so failing loudly here costs nobody their opt-out.
    return NextResponse.json(
      { success: false, error: postmark.error, data: { drift: rows.length, contacts: rows } },
      { status: 500 },
    )
  }

  await stampHeartbeat('consent-drift-check')
  return NextResponse.json({ success: true, data: { drift: rows.length, contacts: rows, postmark } })
}
