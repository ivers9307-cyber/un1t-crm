// GAPS-P5 — the applier for the repeat-bounce decision.
//
// The decision lives in bounce-escalation.js and is pure. This file does the
// fetching and the writing, and is deliberately the ONLY thing here that
// touches the database, so the rule can be reasoned about without a DB and the
// I/O can be reasoned about without re-arguing the rule.
//
// REUSES THE EXISTING EXCLUSION MECHANISM. A contact is removed from marketing
// sends by exactly one thing this feature is allowed to touch:
// contacts.email_suppressed_at (mig 395). buildAudienceQuery /
// buildAudienceQueryAsync (postmark.js) add `.is('email_suppressed_at', null)`
// on every marketing send and count, sendEmailStep in sequences records a skip
// on it, and host-contact-list's isEmailable refuses it. Administrative and
// transactional mail deliberately ignore it. Nothing parallel is invented here
// — the same stamp, set for a different documented reason.
//
// AUDIT. The stamp is a bare timestamp with no room for a reason, so every
// decision also writes an email_bounce_escalations row (mig 515) carrying the
// count, the campaign ids, the bounce types, the delivery count and the
// timestamps that produced it. The audit row is written BEFORE the stamp: a
// suppression with no explanation is not acceptable, an explanation with no
// suppression is merely untidy and self-heals on the next run.
//
// REVERSIBLE, THREE WAYS.
//   1. An operator releases the row (/api/communications/list-health/[id]/
//      release) — clears the stamp and marks the row released_reason
//      'operator', which this sweep then treats as permanent: that contact is
//      never auto-suppressed again.
//   2. Any open or click clears the stamp via the Postmark webhook, as it
//      always has. The reconcile pass below then closes the audit row so the
//      record does not claim a suppression that is not in force.
//   3. Straight SQL on contacts.email_suppressed_at, same as before — the
//      reconcile pass tidies up after that too.
//
// IDEMPOTENT. A contact with an active escalation row is never re-inserted;
// the row's counts are rewritten only when the contact has actually bounced in
// more campaigns since. A settled estate produces zero writes.

import {
  SUCCESSFUL_RECIPIENT_STATUSES,
  decideBounceEscalation,
  groupBouncesByContact,
} from './bounce-escalation.js'
import { logInfo, logError } from './log.js'

export const ESCALATION_TABLE = 'email_bounce_escalations'

/** An operator undid this. Permanent: the sweep never re-suppresses them. */
export const RELEASE_REASON_OPERATOR = 'operator'
/** The stamp went away underneath us; the record is closed to match reality. */
export const RELEASE_REASON_STAMP_CLEARED = 'stamp_cleared_externally'
/**
 * LISTHEALTH-ACT.1 (mig 520) — an operator escalated a `review` row to a
 * suppression. The review row closes with THIS reason, not RELEASE_REASON_
 * OPERATOR, and the difference is load-bearing: 'operator' means a human said
 * no and is treated as permanent below, which would both misrecord the
 * decision and stop this sweep refreshing the counts on the suppression the
 * operator just created.
 */
export const RELEASE_REASON_OPERATOR_SUPPRESSED = 'operator_suppressed'

/** `reason` written on an escalation a human created rather than the rule. */
export const REASON_OPERATOR_REVIEW_SUPPRESSED = 'operator_suppressed_after_review'

// Mirrors the PostgREST 1,000-row select cap (CLAUDE.md): every scan
// .range()-paginates with an explicit .order().
const PAGE = 1000
// Ids per .in() — keeps the request URL bounded.
const CHUNK = 200

/** Page a builder to exhaustion. Throws on the first PostgREST error. */
async function fetchAllPages(buildQuery) {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

function chunked(list, size = CHUNK) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Close audit rows whose suppression is no longer in force.
 *
 * An open or click clears contacts.email_suppressed_at (the Postmark
 * processor has done that since EMAIL-HYGIENE.1), as does re-consent through
 * the preference centre. Without this pass the escalation row would keep
 * claiming a suppression that is not applied, the operator would see a wrong
 * number on the list-health page, and the contact could never be re-evaluated
 * because an active row blocks re-insertion.
 *
 * Released with a reason of 'stamp_cleared_externally', NOT 'operator', so the
 * permanent-override rule stays reserved for a human decision.
 */
async function reconcileClearedSuppressions(db, nowIso, dry, errors) {
  const active = await fetchAllPages(() => db
    .from(ESCALATION_TABLE)
    .select('id, contact_id')
    .is('released_at', null)
    .eq('decision', 'suppress')
    .order('id'))
  if (active.length === 0) return 0

  const byContact = new Map(active.map((r) => [r.contact_id, r.id]))
  const staleIds = []
  for (const ids of chunked([...byContact.keys()])) {
    const { data, error } = await db
      .from('contacts')
      .select('id, email_suppressed_at')
      .in('id', ids)
    if (error) throw new Error(`contact stamp check failed: ${error.message}`)
    for (const row of data || []) {
      if (!row.email_suppressed_at) staleIds.push(byContact.get(row.id))
    }
  }
  if (staleIds.length === 0 || dry) return staleIds.length

  for (const ids of chunked(staleIds)) {
    const { error } = await db
      .from(ESCALATION_TABLE)
      .update({
        released_at: nowIso,
        release_reason: RELEASE_REASON_STAMP_CLEARED,
        release_note: 'contacts.email_suppressed_at was cleared elsewhere (engagement, re-consent or a manual edit), so the suppression is no longer in force.',
      })
      .in('id', ids)
      .is('released_at', null)
    if (error) errors.push(`auto-release failed: ${error.message}`)
  }
  return staleIds.length
}

/**
 * Every bounced recipient row in the estate, grouped by contact.
 *
 * Keyed on bounce_type, NOT bounced_at, and that difference is load-bearing.
 * Two code paths write a bounce and only one of them writes a timestamp: the
 * Postmark webhook sets status/bounced_at/bounce_type together, while
 * campaign-sender's permanent-rejection branch (Postmark 300 invalid email,
 * 406 inactive recipient) sets status='bounced' and bounce_type='rejected'
 * with NO bounced_at. Filtering on bounced_at would silently drop every
 * rejection — 42 events over 11 contacts at Stillorgan alone, and a
 * send-time rejection is the STRONGEST evidence an address is dead.
 * mig 515's email_bounce_type_summary uses the same predicate so the
 * operator-facing breakdown and this scan can never disagree.
 */
async function loadBounceHistory(db) {
  const rows = await fetchAllPages(() => db
    .from('campaign_recipients')
    .select('contact_id, campaign_id, bounce_type, bounced_at')
    .not('bounce_type', 'is', null)
    .order('id'))
  return groupBouncesByContact(rows)
}

/** contact ids with at least one recipient row that proves a delivery. */
async function loadDeliveryCounts(db, contactIds) {
  const counts = new Map()
  for (const ids of chunked(contactIds)) {
    const rows = await fetchAllPages(() => db
      .from('campaign_recipients')
      .select('contact_id')
      .in('contact_id', ids)
      .in('status', SUCCESSFUL_RECIPIENT_STATUSES)
      .order('id'))
    for (const row of rows) counts.set(row.contact_id, (counts.get(row.contact_id) || 0) + 1)
  }
  return counts
}

async function loadExistingEscalations(db, contactIds) {
  const byContact = new Map()
  for (const ids of chunked(contactIds)) {
    const rows = await fetchAllPages(() => db
      .from(ESCALATION_TABLE)
      .select('id, contact_id, decision, released_at, release_reason, bounced_campaign_count')
      .in('contact_id', ids)
      .order('id'))
    for (const row of rows) {
      const list = byContact.get(row.contact_id)
      if (list) list.push(row)
      else byContact.set(row.contact_id, [row])
    }
  }
  return byContact
}

async function loadRows(db, table, columns, ids) {
  const out = new Map()
  for (const chunk of chunked(ids)) {
    const { data, error } = await db.from(table).select(columns).in('id', chunk)
    if (error) throw new Error(`${table} lookup failed: ${error.message}`)
    for (const row of data || []) out.set(row.id, row)
  }
  return out
}

/**
 * Evaluate every contact with a bounce history and apply the `suppress` verdict.
 *
 * @param {object} args
 * @param {object} args.db    service-role Supabase client
 * @param {Date}   [args.now] injected clock (the decision helper is pure)
 * @param {boolean}[args.dry] decide and report, write nothing
 */
export async function runRepeatBounceSweep({ db, now = new Date(), dry = false } = {}) {
  const nowIso = new Date(now).toISOString()
  const errors = []
  const result = {
    ok: true,
    dry: Boolean(dry),
    scannedBounceRows: 0,
    contactsWithBounces: 0,
    candidates: 0,
    suppressed: 0,
    review: 0,
    refreshed: 0,
    unchanged: 0,
    autoReleased: 0,
    skippedOperatorReleased: 0,
    skippedNoLocation: 0,
    errors,
  }

  let byContact
  try {
    result.autoReleased = await reconcileClearedSuppressions(db, nowIso, dry, errors)
    byContact = await loadBounceHistory(db)
  } catch (err) {
    errors.push(err?.message || String(err))
    logError('bounce-escalation-sweep', 'sweep aborted before any write', { err: errors.at(-1) })
    return { ...result, ok: false }
  }

  result.contactsWithBounces = byContact.size
  result.scannedBounceRows = [...byContact.values()].reduce((n, rows) => n + rows.length, 0)

  // Shortlist first. With zero deliveries assumed, the only non-keep verdict
  // the helper can return is `suppress`, so this is exactly "3+ distinct
  // campaigns and no hard bounce" — the population worth a delivery lookup.
  // Learning about deliveries can only ever soften suppress to review, never
  // promote a keep, so nothing is missed by shortlisting here.
  const shortlist = []
  for (const [contactId, bounces] of byContact) {
    if (decideBounceEscalation({ bounces, successfulDeliveries: 0 }, { now }).outcome === 'suppress') {
      shortlist.push(contactId)
    }
  }
  result.candidates = shortlist.length
  if (shortlist.length === 0) {
    if (errors.length) result.ok = false
    logInfo('bounce-escalation-sweep', 'sweep complete', result)
    return result
  }

  let deliveryCounts, existing, contacts
  try {
    deliveryCounts = await loadDeliveryCounts(db, shortlist)
    existing = await loadExistingEscalations(db, shortlist)
    contacts = await loadRows(db, 'contacts', 'id, email, location_id, email_suppressed_at', shortlist)
  } catch (err) {
    errors.push(err?.message || String(err))
    logError('bounce-escalation-sweep', 'sweep aborted before any write', { err: errors.at(-1) })
    return { ...result, ok: false }
  }

  // Decide, then split into "needs a new row", "needs its counts refreshed"
  // and "nothing to do".
  const toInsert = []
  const toRefresh = []
  const needCampaignLocation = new Set()

  for (const contactId of shortlist) {
    const decision = decideBounceEscalation(
      { bounces: byContact.get(contactId), successfulDeliveries: deliveryCounts.get(contactId) || 0 },
      { now },
    )
    if (decision.outcome === 'keep') continue

    const rows = existing.get(contactId) || []
    if (rows.some((r) => r.released_at && r.release_reason === RELEASE_REASON_OPERATOR)) {
      // An operator has already looked at this contact and said no. Their
      // judgement outranks the rule; re-suppressing would overrule a human
      // every night with no new information.
      result.skippedOperatorReleased += 1
      continue
    }
    const active = rows.find((r) => !r.released_at)
    if (active) {
      if ((active.bounced_campaign_count || 0) !== decision.distinctCampaignCount) {
        toRefresh.push({ id: active.id, decision })
      } else {
        result.unchanged += 1
      }
      continue
    }

    const contact = contacts.get(contactId)
    if (!contact?.location_id) needCampaignLocation.add(contactId)
    toInsert.push({ contactId, decision, contact })
  }

  // location_id is NOT NULL on the audit table: service-role routes bypass
  // RLS, so the column is the only tenant boundary the list-health surface
  // has. A contact whose own row carries no location falls back to the
  // location of a campaign they bounced from; if neither exists the row is
  // skipped rather than parked under a guessed tenant.
  let campaignLocations = new Map()
  if (needCampaignLocation.size > 0) {
    const campaignIds = new Set()
    for (const { contactId, decision } of toInsert) {
      if (needCampaignLocation.has(contactId)) decision.campaignIds.forEach((id) => campaignIds.add(id))
    }
    try {
      campaignLocations = await loadRows(db, 'campaigns', 'id, location_id', [...campaignIds])
    } catch (err) {
      errors.push(err?.message || String(err))
    }
  }

  const rowsToInsert = []
  for (const { contactId, decision, contact } of toInsert) {
    const locationId = contact?.location_id
      || decision.campaignIds.map((id) => campaignLocations.get(id)?.location_id).find(Boolean)
      || null
    if (!locationId) {
      result.skippedNoLocation += 1
      continue
    }
    if (decision.outcome === 'suppress') result.suppressed += 1
    else result.review += 1

    rowsToInsert.push({
      contact_id: contactId,
      location_id: locationId,
      decision: decision.outcome,
      reason: decision.reason,
      bounced_campaign_count: decision.distinctCampaignCount,
      bounced_campaign_ids: decision.campaignIds,
      bounce_types: decision.bounceTypes,
      bounce_events: decision.bounceEvents,
      successful_deliveries: decision.successfulDeliveries,
      first_bounce_at: decision.firstBounceAt,
      last_bounce_at: decision.lastBounceAt,
      evaluated_at: decision.evaluatedAt,
      // Whether the contact was ALREADY suppressed when this decision landed
      // (the nightly hygiene sweep stamps the same column for inactivity).
      // Without it, an operator releasing this row cannot tell whether the
      // stamp they are clearing was ours.
      stamp_was_already_set: Boolean(contact?.email_suppressed_at),
      suppressed_at: decision.outcome === 'suppress' ? nowIso : null,
    })
  }

  if (dry) {
    logInfo('bounce-escalation-sweep', 'dry run complete', result)
    return { ...result, ok: errors.length === 0 }
  }

  // Refresh first (cheap, no side effect on the audience), then insert the
  // audit rows, then stamp — never the other way round.
  for (const { id, decision } of toRefresh) {
    const { error } = await db.from(ESCALATION_TABLE).update({
      bounced_campaign_count: decision.distinctCampaignCount,
      bounced_campaign_ids: decision.campaignIds,
      bounce_types: decision.bounceTypes,
      bounce_events: decision.bounceEvents,
      successful_deliveries: decision.successfulDeliveries,
      last_bounce_at: decision.lastBounceAt,
      evaluated_at: decision.evaluatedAt,
    }).eq('id', id)
    if (error) errors.push(`escalation refresh failed: ${error.message}`)
    else result.refreshed += 1
  }

  const stampIds = []
  for (const chunk of chunked(rowsToInsert)) {
    const { error } = await db.from(ESCALATION_TABLE).insert(chunk)
    if (error) {
      // Do NOT stamp this chunk: a suppression whose audit row failed to land
      // is precisely the untraceable state this table exists to prevent.
      errors.push(`escalation insert failed: ${error.message}`)
      for (const row of chunk) {
        if (row.decision === 'suppress') result.suppressed -= 1
        else result.review -= 1
      }
      continue
    }
    for (const row of chunk) if (row.decision === 'suppress') stampIds.push(row.contact_id)
  }

  for (const chunk of chunked(stampIds)) {
    const { error } = await db
      .from('contacts')
      .update({ email_suppressed_at: nowIso })
      .in('id', chunk)
      // Re-assert the guard so a concurrent open-webhook clear, or a stamp
      // the hygiene sweep set between our read and this write, wins.
      .is('email_suppressed_at', null)
    if (error) errors.push(`suppression stamp failed: ${error.message}`)
  }

  result.ok = errors.length === 0
  if (result.ok) logInfo('bounce-escalation-sweep', 'sweep complete', result)
  else logError('bounce-escalation-sweep', 'sweep completed with errors', result)
  return result
}
