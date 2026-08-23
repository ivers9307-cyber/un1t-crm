// CHURN-RADAR.1 — server-side data access for the radar.
//
// Fetches the member rows + the recent action log for a location,
// runs the pure scoring (churn-radar.js), and overlays per-contact
// action state (last contacted, active snooze). DB-touching — kept
// out of churn-radar.js so that module stays pure + unit-tested.

import {
  buildRadar,
  buildWinback,
  buildOverdue,
  bucketArrears,
  radarSummary,
  computeRecoveryStats,
  computeTrend,
  classifyContact,
  MEMBER_STATUSES,
} from '@/lib/churn-radar'
import { nettedOutByRetry, isMembershipInvoice } from '@/lib/glofox-arrears'
import { combineGroupActivity, rollupByPerson } from '@/lib/person-rollup'
import { selectAll } from '@/lib/select-all'

// Columns the scorer + UI need from contacts. glofox_membership_type
// and trial_credits_remaining drive the live-membership gate (a class
// pack is only live while credits remain); last_payment_at backs the
// overdue chase-list.
const MEMBER_COLUMNS =
  'id, name, glofox_membership_status, glofox_membership_plan, ' +
  'glofox_membership_type, glofox_membership_state, ' +
  'glofox_membership_expiry, glofox_membership_price_cents, ' +
  'glofox_billing_interval, trial_credits_remaining, ' +
  'last_attended_at, last_booked_at, last_payment_at, ' +
  'total_attended_30d, total_attended_7d, total_noshow_30d, ' +
  'total_bookings_30d, joined_at, lifetime_value_cents, person_group_id'

const CONTACTING_ACTIONS = ['contacted', 'task_assigned', 'winback_sent', 'outreach_sent']

// Actions that triage a quarantine record — once a member carries one
// they're off the quarantine backlog (kept, or marked stale).
const QUARANTINE_TRIAGE_ACTIONS = ['quarantine_stale', 'quarantine_keep']

// CHURN-CLEAN.1 — actions that permanently exclude a contact from the
// radar (the operator has reclassified them as "not a member"). Unlike
// a snooze (≤90 days), these never expire — a misclassified trial /
// one-off must stay off the list for good — so they're fetched without
// the 90-day window fetchActions() uses. 'quarantine_stale' is the
// legacy quarantine "mark stale" decision; it now excludes everywhere,
// not just the quarantine backlog.
const EXCLUSION_ACTIONS = ['dismissed', 'quarantine_stale']

/**
 * The set of contact ids the operator has permanently dismissed from
 * the radar at this location. Unbounded by time (a dismissal is
 * permanent) and tiny in practice, so a single un-paged select is safe.
 */
async function fetchDismissed(db, locationId) {
  const { data } = await db
    .from('churn_radar_actions')
    .select('contact_id')
    .eq('location_id', locationId)
    .in('action', EXCLUSION_ACTIONS)
  return new Set((data || []).map((r) => r.contact_id))
}

/**
 * Page every `glofox_invoices` row at a location with a given status,
 * selecting only the columns the caller needs. Paginated — the invoice
 * table can exceed Supabase's ~1000-row response cap.
 */
async function fetchInvoicesByStatus(db, locationId, status, columns) {
  const rows = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('glofox_invoices')
      .select(columns)
      .eq('location_id', locationId)
      .eq('status', status)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

/**
 * RADAR-OVERDUE.1 — the authoritative arrears signal. Aggregates every
 * OPEN `PAST_DUE` invoice per contact at the location (from
 * `glofox_invoices`, kept current by the INVOICE_UPDATED webhook) into
 * `{ amountCents, count, oldestDueAt }`. This DRIVES the Overdue tab and
 * pulls past-due members off the at-risk list — replacing the stale,
 * unreliable `glofox_membership_state='locked'` signal (see the audit at
 * docs/CHURN_OVERDUE_AUDIT_2026-06.md). Returns `{ ids: Set, byId: Map }`.
 *
 * ARREARS-NETTING.1 — Glofox issues a NEW invoice id per payment ATTEMPT
 * for one-off purchases (class packs, single-class fees, signup upfront
 * fees), so a card that fails then succeeds leaves an orphaned PAST_DUE row
 * (the failed attempt) plus a separate PAID row (the success). Glofox's own
 * profile nets the purchase to €0. Before aggregating, we net those settled
 * retries out: a PAST_DUE row whose member (glofox_user_id) has a PAID
 * `glofox_invoices` row of the same amount_cents within ±7 days is excluded
 * from the Overdue list + total (shared pure helper `nettedOutByRetry`).
 *
 * Exported for reuse by the engagement→churn analytics (P2-7) — the at-risk
 * classification needs the same authoritative arrears context.
 *
 * ARREARS-TYPE.1 — also splits the PAST_DUE aggregate by CHARGE TYPE: a
 * membership payment (a failed subscription renewal / first payment → the
 * Overdue tab) vs every other charge (fees, custom charges, class bookings,
 * class packs, products → the Unpaid-charges tab), via isMembershipInvoice on
 * `line_item_subtypes` (webhook rows) or the report event the June backfill
 * kept at raw_payload.candidate.glofoxEvent (backfilled rows have no line
 * items; PostgREST aliases it to `glofox_event` in the select). `ids` / `byId`
 * keep covering EVERY open PAST_DUE so the 'overdue' classification, the
 * profile pill and the P2-7 analytics are unchanged.
 * Returns `{ ids, byId, pendingById, membershipById, chargesById }`.
 */
export async function fetchPastDue(db, locationId) {
  const [pastDueRows, pendingRows, paidRows] = await Promise.all([
    fetchInvoicesByStatus(db, locationId, 'PAST_DUE', 'id, contact_id, glofox_user_id, amount_cents, invoice_date, status, line_item_subtypes, glofox_event:raw_payload->candidate->>glofoxEvent'),
    fetchInvoicesByStatus(db, locationId, 'PENDING', 'id, contact_id, glofox_user_id, amount_cents, invoice_date, status, line_item_subtypes'),
    fetchInvoicesByStatus(db, locationId, 'PAID', 'glofox_user_id, amount_cents, invoice_date'),
  ])
  // AWAITING-AUTH.2 — every PENDING invoice ("awaiting authorization" in Glofox:
  // a payment in progress, not yet confirmed) feeds the Awaiting-authorization
  // tab, whatever its charge type (class booking, product buy, fee or renewal).
  // Pending is never owed/overdue (see bucketArrears / the de-count); PAST_DUE
  // drives the Overdue + Unpaid-charges debt lists.
  const openRows = [...pastDueRows, ...pendingRows]
  // Net cross-invoice-id payment retries out before aggregating.
  const { kept } = nettedOutByRetry(openRows, paidRows)

  // OWED-PENDING.1 / AWAITING-AUTH.1 / ARREARS-TYPE.1 — aggregate the netted
  // rows per contact. PENDING stands alone (Awaiting authorization only).
  // PAST_DUE feeds `byId` (every debt — drives the 'overdue' classification)
  // AND one of the two tab maps by charge type.
  const byId = new Map()           // every PAST_DUE
  const membershipById = new Map() // PAST_DUE membership payments → Overdue
  const chargesById = new Map()    // PAST_DUE everything else → Unpaid charges
  const pendingById = new Map()    // PENDING → Awaiting authorization
  const add = (target, r) => {
    const cur = target.get(r.contact_id) || { amountCents: 0, count: 0, oldestDueAt: null }
    cur.amountCents += Number(r.amount_cents) || 0
    cur.count += 1
    if (r.invoice_date && (!cur.oldestDueAt || r.invoice_date < cur.oldestDueAt)) {
      cur.oldestDueAt = r.invoice_date
    }
    target.set(r.contact_id, cur)
  }
  for (const r of kept) {
    // A row with no contact_id can't be surfaced on a contact-keyed list.
    if (r.contact_id == null) continue
    if (r.status === 'PENDING') { add(pendingById, r); continue }
    add(byId, r)
    add(isMembershipInvoice(r) ? membershipById : chargesById, r)
  }
  // ids = PAST_DUE contacts only — a pending fee never classifies a member as
  // 'overdue' (no pill, off the chase-list); it shows in Awaiting authorization instead.
  return { ids: new Set(byId.keys()), byId, pendingById, membershipById, chargesById }
}

/**
 * Fetch the radar-relevant columns for an explicit list of contact ids
 * (the past-due cohort — which may include ex-members outside the member
 * base, so it can't reuse fetchMembers). Chunked to stay under the
 * URL-length / row caps.
 */
async function fetchContactsByIds(db, ids) {
  const list = Array.from(ids)
  if (list.length === 0) return []
  const rows = []
  const CHUNK = 300
  for (let i = 0; i < list.length; i += CHUNK) {
    const { data, error } = await db
      .from('contacts')
      .select('id, name, glofox_membership_status, glofox_membership_type, glofox_membership_plan, last_attended_at, last_payment_at')
      .in('id', list.slice(i, i + CHUNK))
    if (error) throw new Error(error.message)
    rows.push(...(data || []))
  }
  return rows
}

/**
 * Fetch every paying member at a location. Paginated — the member
 * base can exceed Supabase's ~1000-row response cap. Exported for reuse
 * by the engagement→churn analytics (P2-7), which needs the same active
 * base + columns the radar scores on.
 */
export async function fetchMembers(db, locationId) {
  const rows = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('contacts')
      .select(MEMBER_COLUMNS)
      .eq('location_id', locationId)
      .in('glofox_membership_status', MEMBER_STATUSES)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

async function fetchActions(db, locationId) {
  // 90-day window: snoozes are capped at 90 days and "last contacted"
  // only needs the most recent action per contact, so nothing older
  // can affect the radar.
  // AUDIT P1-2 — paginated. A busy location logs many actions per contact,
  // so even a 90-day window can exceed the 1000-row cap; a truncated log
  // would silently lose snoozes/contacted state for contacts past row 1000.
  // selectAll throws on a DB error; keep this best-effort (the original
  // swallowed errors and returned []) so the radar still renders.
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
  try {
    return await selectAll((from, to) => db
      .from('churn_radar_actions')
      .select('contact_id, action, snooze_until, created_at')
      .eq('location_id', locationId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .order('contact_id', { ascending: true })
      .range(from, to))
  } catch {
    return []
  }
}

const GROUPS_PAGE_SIZE = 1000
const GROUPS_HARD_LIMIT = 20_000

/**
 * CHURN-RADAR-PERSON-AWARE — combine cross-account activity and deduplicate
 * a sweep's contact rows to one row per person, using the person_groups table.
 *
 * If no rows in the sweep carry a person_group_id, returns the input unchanged
 * (fast path — the common case for most contacts).
 *
 * On any DB error, degrades gracefully by returning the raw rows so the radar
 * still works; never throws.
 *
 * Fix: loads person_groups and grouped contacts via location-scoped paginated
 * queries rather than giant .in(groupIds) calls that overflow Supabase's URL
 * limit when there are ~895 groups (~33 KB URL → silent error → empty map).
 *
 * @param {object} db - Supabase server client
 * @param {string} locationId - The location being swept
 * @param {Array<object>} rows - Sweep contact rows (already dismissed-filtered)
 * @returns {Promise<Array<object>>}
 */
async function applyPersonRollup(db, locationId, rows) {
  const hasGroups = rows.some((r) => r.person_group_id)
  if (!hasGroups) return rows

  try {
    // 1. Load ALL person_groups for this location (paginated, location-scoped).
    //    Avoids the giant .in(groupIds) URL-overflow with ~895 groups.
    const primaryByGroup = new Map()
    let pgStart = 0
    while (true) {
      const pgEnd = Math.min(pgStart + GROUPS_PAGE_SIZE - 1, GROUPS_HARD_LIMIT - 1)
      const { data: page, error: pgErr } = await db
        .from('person_groups')
        .select('id, primary_contact_id')
        .eq('location_id', locationId)
        .order('id', { ascending: true })
        .range(pgStart, pgEnd)
      if (pgErr) throw new Error(pgErr.message)
      if (!Array.isArray(page) || page.length === 0) break
      for (const g of page) {
        if (g.primary_contact_id) primaryByGroup.set(g.id, g.primary_contact_id)
      }
      if (page.length < GROUPS_PAGE_SIZE) break
      if (primaryByGroup.size >= GROUPS_HARD_LIMIT) break
      pgStart += GROUPS_PAGE_SIZE
    }

    // 2. Load ALL grouped contacts at this location (cross-status — includes
    //    accounts the sweep didn't load, e.g. an active classpass_payg alongside
    //    a dormant member). Location-scoped + paginated, no .in(groupIds).
    const allGroupContacts = []
    let gcStart = 0
    while (true) {
      const gcEnd = Math.min(gcStart + GROUPS_PAGE_SIZE - 1, GROUPS_HARD_LIMIT - 1)
      const { data: page, error: gcErr } = await db
        .from('contacts')
        .select('id, person_group_id, last_attended_at, last_booked_at, total_attended_30d, total_attended_7d, total_noshow_30d')
        .eq('location_id', locationId)
        .not('person_group_id', 'is', null)
        .order('id', { ascending: true })
        .range(gcStart, gcEnd)
      if (gcErr) throw new Error(gcErr.message)
      if (!Array.isArray(page) || page.length === 0) break
      allGroupContacts.push(...page)
      if (page.length < GROUPS_PAGE_SIZE) break
      if (allGroupContacts.length >= GROUPS_HARD_LIMIT) break
      gcStart += GROUPS_PAGE_SIZE
    }

    // 3. Build combined activity across ALL accounts in each group.
    const combinedByGroup = combineGroupActivity(allGroupContacts)

    // 4. Deduplicate to one row per person, injecting combined activity.
    return rollupByPerson(rows, { combinedByGroup, primaryByGroup })
  } catch {
    // Degrade gracefully — radar works with raw rows, just without dedup.
    return rows
  }
}

/**
 * Load the scored at-risk radar for a location. Snoozed members are
 * counted but excluded from the list. Each radar row carries its
 * most recent contacting action.
 *
 * @returns {Promise<{ radar: object[], summary: object }>}
 */
export async function loadRadar(db, locationId, nowMs = Date.now()) {
  const [allMembers, actions, dismissed, pastDue] = await Promise.all([
    fetchMembers(db, locationId),
    fetchActions(db, locationId),
    fetchDismissed(db, locationId),
    fetchPastDue(db, locationId),
  ])
  // CHURN-CLEAN.1 — operator-dismissed "not a member" contacts drop off
  // every surface AND the summary counts (active base, at-risk, etc.).
  const dismissed_members = allMembers.filter((m) => !dismissed.has(m.id))
  // CHURN-RADAR-PERSON-AWARE — combine cross-account activity and deduplicate
  // to one row per person so a dormant member with an active ClassPass account
  // isn't wrongly flagged, and a person with 2+ member accounts counts once.
  const members = await applyPersonRollup(db, locationId, dismissed_members)
  // RADAR-OVERDUE.1 — invoice-driven overdue context: past-due members are
  // pulled off the at-risk list + counted as overdue (not the stale
  // membership.status='locked' field).
  const ctx = { pastDueIds: pastDue.ids, pastDueById: pastDue.byId }

  // Actions are newest-first — first hit per contact is the latest.
  const lastContacted = new Map()
  const snoozedUntil = new Map()
  const triaged = new Set()
  for (const a of actions) {
    if (a.action === 'snoozed' && a.snooze_until) {
      const cur = snoozedUntil.get(a.contact_id)
      if (!cur || a.snooze_until > cur) snoozedUntil.set(a.contact_id, a.snooze_until)
    }
    if (QUARANTINE_TRIAGE_ACTIONS.includes(a.action)) triaged.add(a.contact_id)
    if (CONTACTING_ACTIONS.includes(a.action) && !lastContacted.has(a.contact_id)) {
      lastContacted.set(a.contact_id, { action: a.action, at: a.created_at })
    }
  }

  const scored = buildRadar(members, nowMs, ctx)
  const radar = []
  let snoozed = 0
  for (const r of scored) {
    const snz = snoozedUntil.get(r.contactId)
    if (snz && new Date(snz).getTime() > nowMs) { snoozed++; continue }
    radar.push({ ...r, lastContacted: lastContacted.get(r.contactId) || null })
  }

  // radarSummary counts every no-footprint member as quarantine; a
  // member that's already been triaged is off the backlog, so subtract
  // them — the badge + card then match the visible quarantine list.
  const summary = radarSummary(members, nowMs, ctx)
  let quarantineOpen = 0
  for (const c of members) {
    if (!triaged.has(c.id) && classifyContact(c, ctx) === 'quarantine') quarantineOpen++
  }

  // RADAR-OUTCOMES.1 — did the outreach work? Correlate the action log
  // against attendance: of the members contacted in the last 90 days,
  // how many came back to training afterwards.
  const recovery = computeRecoveryStats(members, actions, nowMs)

  // RADAR-OVERDUE.1 / AWAITING-AUTH.1 / ARREARS-TYPE.1 — split the full arrears
  // set so the headline badges match their tabs: Overdue (PAST_DUE membership
  // payments — failed renewals), Unpaid charges (every other PAST_DUE charge)
  // and Awaiting authorization (PENDING, not yet collected). Incl. ex-members
  // who owe. Pending never counts as Overdue or Unpaid charges. (A contact can
  // land in more than one bucket — a failed renewal AND a failed fee, say.)
  const { overdueById, unpaidById, awaitingAuthById } = bucketArrears(pastDue)
  let overdueCount = 0, overdueValueCents = 0
  let unpaidChargesCount = 0, unpaidChargesValueCents = 0
  let awaitingAuthCount = 0, awaitingAuthValueCents = 0
  for (const [id, agg] of overdueById) {
    if (dismissed.has(id)) continue
    overdueCount++; overdueValueCents += agg.amountCents || 0
  }
  for (const [id, agg] of unpaidById) {
    if (dismissed.has(id)) continue
    unpaidChargesCount++; unpaidChargesValueCents += agg.amountCents || 0
  }
  for (const [id, agg] of awaitingAuthById) {
    if (dismissed.has(id)) continue
    awaitingAuthCount++; awaitingAuthValueCents += agg.amountCents || 0
  }

  const finalSummary = {
    ...summary, quarantine: quarantineOpen, snoozed, recovery,
    overdue: overdueCount, overdueValueCents,
    unpaidCharges: unpaidChargesCount, unpaidChargesValueCents,
    awaitingAuth: awaitingAuthCount, awaitingAuthValueCents,
  }

  // RADAR-TREND.1 — week-over-week deltas vs the most recent weekly
  // snapshot (written by the churn-radar-snapshot cron). Null trend
  // until the first snapshot exists.
  const { data: snapshot } = await db
    .from('churn_radar_snapshots')
    .select('captured_at, active_base, at_risk, high_risk, overdue, paused, quarantine, revenue_at_risk_cents, overdue_value_cents')
    .eq('location_id', locationId)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  finalSummary.trend = computeTrend(finalSummary, snapshot || null)

  return { radar, summary: finalSummary }
}

/**
 * Load the quarantine list — paying members with zero activity
 * footprint that haven't yet been triaged (no quarantine_* action).
 */
export async function loadQuarantine(db, locationId) {
  const [allMembers, actions, dismissed] = await Promise.all([
    fetchMembers(db, locationId),
    fetchActions(db, locationId),
    fetchDismissed(db, locationId),
  ])
  const dismissed_members = allMembers.filter((m) => !dismissed.has(m.id))
  // CHURN-RADAR-PERSON-AWARE — combine cross-account activity so a member
  // who shows quarantine on one account but activity on another isn't surfaced.
  const members = await applyPersonRollup(db, locationId, dismissed_members)
  const triaged = new Set(
    actions
      .filter((a) => QUARANTINE_TRIAGE_ACTIONS.includes(a.action))
      .map((a) => a.contact_id),
  )
  return members
    .filter((c) => classifyContact(c) === 'quarantine' && !triaged.has(c.id))
    .map((c) => ({
      contactId: c.id,
      name: c.name || 'Member',
      membershipStatus: c.glofox_membership_status,
      membershipPlan: c.glofox_membership_plan || null,
      joinedAt: c.joined_at,
      lifetimeValueCents: c.lifetime_value_cents || 0,
    }))
    // Longest-tenured first — those are the most likely stale records.
    .sort((a, b) => new Date(a.joinedAt || 0) - new Date(b.joinedAt || 0))
}

/**
 * Load the overdue chase-list — contacts with an OPEN `PAST_DUE` invoice
 * (RADAR-OVERDUE.1). Driven by `glofox_invoices`, the authoritative
 * arrears signal, NOT the stale membership.status='locked' field — so a
 * class-pack holder who paid upfront never appears, and a subscriber
 * whose renewal genuinely failed always does. Each row carries the real
 * amount owed + how long the oldest invoice has been overdue, plus its
 * most recent contacting action. No snooze filtering — a debt doesn't
 * snooze. Operator-dismissed contacts are excluded.
 *
 * @returns {Promise<{ overdue: object[], summary: object }>}
 */
/**
 * Build every open-arrears row at the location (minus dismissed), each with its
 * most recent contacting action, split into the three tabs: `overdue` (PAST_DUE
 * membership payments — the chase-list), `unpaidCharges` (every other PAST_DUE
 * charge) and `awaitingAuth` (PENDING, not yet collected). Shared by
 * loadOverdue + loadUnpaidCharges + loadAwaitingAuth so they read identical data.
 */
async function loadArrearsRows(db, locationId, nowMs) {
  const [pastDue, actions, dismissed] = await Promise.all([
    fetchPastDue(db, locationId),
    fetchActions(db, locationId),
    fetchDismissed(db, locationId),
  ])
  // ARREARS-TYPE.1 — by charge type: PAST_DUE membership payments → Overdue,
  // every other PAST_DUE charge → Unpaid charges, PENDING → Awaiting
  // authorization. A contact may appear in more than one tab.
  const { overdueById, unpaidById, awaitingAuthById } = bucketArrears(pastDue)
  const ids = [...new Set([...overdueById.keys(), ...unpaidById.keys(), ...awaitingAuthById.keys()])].filter((id) => !dismissed.has(id))
  const contacts = await fetchContactsByIds(db, ids)

  // Actions are newest-first — first hit per contact is the latest.
  const lastContacted = new Map()
  for (const a of actions) {
    if (CONTACTING_ACTIONS.includes(a.action) && !lastContacted.has(a.contact_id)) {
      lastContacted.set(a.contact_id, { action: a.action, at: a.created_at })
    }
  }
  const withAction = (r) => ({ ...r, lastContacted: lastContacted.get(r.contactId) || null })

  const overdue = buildOverdue(contacts, nowMs, { pastDueById: overdueById }).map(withAction)
  const unpaidCharges = buildOverdue(contacts, nowMs, { pastDueById: unpaidById }).map(withAction)
  const awaitingAuth = buildOverdue(contacts, nowMs, { pastDueById: awaitingAuthById }).map(withAction)
  return { overdue, unpaidCharges, awaitingAuth }
}

export async function loadOverdue(db, locationId, nowMs = Date.now()) {
  const { overdue } = await loadArrearsRows(db, locationId, nowMs)
  const totalValueCents = overdue.reduce((sum, r) => sum + (r.amountOwedCents || 0), 0)
  return { overdue, summary: { total: overdue.length, totalValueCents } }
}

/**
 * Load the "Unpaid charges" tab — contacts with an open CONFIRMED past-due
 * charge that is NOT a membership payment: late-cancel / no-show fees, staff
 * custom charges, class bookings, class packs and products, at any amount
 * (ARREARS-TYPE.1 — the old <€50 rule is gone). PENDING 'awaiting
 * authorization' charges are NOT here — they live in their own tab
 * (loadAwaitingAuth). Same row shape as Overdue.
 *
 * @returns {Promise<{ charges: object[], summary: object }>}
 */
export async function loadUnpaidCharges(db, locationId, nowMs = Date.now()) {
  const { unpaidCharges } = await loadArrearsRows(db, locationId, nowMs)
  const totalValueCents = unpaidCharges.reduce((sum, r) => sum + (r.amountOwedCents || 0), 0)
  return { charges: unpaidCharges, summary: { total: unpaidCharges.length, totalValueCents } }
}

/**
 * AWAITING-AUTH.1 — load the "Awaiting authorization" tab: contacts with a
 * PENDING custom-charge fee (a no-show / late-cancel fee Glofox has applied but
 * not yet collected — it shows as "Awaiting authorization" in Glofox). These are
 * NOT confirmed debts, so they're kept off the Overdue chase-list AND out of the
 * Unpaid-charges tab; they get their own low-priority tab. Same row shape as
 * Overdue (returns `charges` so the UI can reuse the charges list).
 *
 * @returns {Promise<{ charges: object[], summary: object }>}
 */
export async function loadAwaitingAuth(db, locationId, nowMs = Date.now()) {
  const { awaitingAuth } = await loadArrearsRows(db, locationId, nowMs)
  const totalValueCents = awaitingAuth.reduce((sum, r) => sum + (r.amountOwedCents || 0), 0)
  return { charges: awaitingAuth, summary: { total: awaitingAuth.length, totalValueCents } }
}

/**
 * Page every `glofox_invoices` row for a SINGLE contact with a given status.
 * Like fetchInvoicesByStatus but keyed by contact_id (the profile is one
 * contact, not a whole location). Paginated for the same 1k-row reason.
 */
async function fetchContactInvoicesByStatus(db, contactId, status, columns) {
  const rows = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('glofox_invoices')
      .select(columns)
      .eq('contact_id', contactId)
      .eq('status', status)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

/**
 * PROFILE-ARREARS.1 — the open CONFIRMED past-due total for ONE contact, for the
 * contact profile page. fetchPastDue aggregates the whole location to drive
 * the Overdue chase-list; the profile needs the single-contact figure so an
 * ungrouped member (the ~99% case) shows the SAME arrears the chase-list
 * flags instead of a blank "—". Uses the identical glofox_invoices columns
 * and the shared `nettedOutByRetry` settled-retry netting, so the profile,
 * the radar (fetchPastDue) and the grouped person view (person-aggregate)
 * all agree.
 *
 * AWAITING-AUTH.1 — PAST_DUE only. PENDING "awaiting authorization" fees are
 * provisional (they expire if the customer never pays), so they are NOT counted
 * as owed here: they must not light the profile "Payment overdue" pill, inflate
 * the profile arrears figure, or keep a member on the Overdue chase-list via the
 * refresh-member re-flag. They surface only in the Awaiting-authorization tab.
 *
 * Best-effort: any DB error (or a pre-migration glofox_invoices) returns
 * zeros rather than crashing the profile render.
 *
 * @returns {Promise<{ arrearsCents: number, count: number }>}
 *   arrearsCents — summed amount of the surviving (non-settled-retry) PAST_DUE rows
 *   count — number of those surviving rows (drives the "Payment overdue" pill)
 */
export async function loadContactArrears(db, contactId) {
  if (!contactId) return { arrearsCents: 0, count: 0 }
  try {
    const [pastDueRows, paidRows] = await Promise.all([
      fetchContactInvoicesByStatus(db, contactId, 'PAST_DUE', 'id, contact_id, glofox_user_id, amount_cents, invoice_date'),
      fetchContactInvoicesByStatus(db, contactId, 'PAID', 'glofox_user_id, amount_cents, invoice_date'),
    ])
    const { kept } = nettedOutByRetry(pastDueRows, paidRows)
    const arrearsCents = kept.reduce((sum, r) => sum + (Number(r.amount_cents) || 0), 0)
    return { arrearsCents, count: kept.length }
  } catch {
    return { arrearsCents: 0, count: 0 }
  }
}

// WINBACK.1 — statuses a former member can carry. ex_member is in
// here even though it's outside MEMBER_STATUSES; a lapsed member
// whose Glofox status flipped to ex_member is a clear win-back case.
const WINBACK_CONTACT_STATUSES = ['member', 'credit_member', 'ex_member']

/**
 * Fetch every contact that could be a former member. Paginated, like
 * fetchMembers, but widened to include ex_member.
 */
async function fetchWinbackContacts(db, locationId) {
  const rows = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('contacts')
      .select(MEMBER_COLUMNS)
      .eq('location_id', locationId)
      .in('glofox_membership_status', WINBACK_CONTACT_STATUSES)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

/**
 * Load the win-back list — former members worth re-winning. Snoozed
 * contacts are counted but excluded; each row carries its most recent
 * contacting action.
 *
 * @returns {Promise<{ winback: object[], summary: object }>}
 */
export async function loadWinback(db, locationId, nowMs = Date.now()) {
  const [allContacts, actions, dismissed] = await Promise.all([
    fetchWinbackContacts(db, locationId),
    fetchActions(db, locationId),
    fetchDismissed(db, locationId),
  ])
  const dismissed_contacts = allContacts.filter((c) => !dismissed.has(c.id))
  // CHURN-RADAR-PERSON-AWARE — combine cross-account activity so a former
  // member who is still active on another account doesn't appear as a win-back.
  const contacts = await applyPersonRollup(db, locationId, dismissed_contacts)

  // Actions are newest-first — first hit per contact is the latest.
  const lastContacted = new Map()
  const snoozedUntil = new Map()
  for (const a of actions) {
    if (a.action === 'snoozed' && a.snooze_until) {
      const cur = snoozedUntil.get(a.contact_id)
      if (!cur || a.snooze_until > cur) snoozedUntil.set(a.contact_id, a.snooze_until)
    }
    if (CONTACTING_ACTIONS.includes(a.action) && !lastContacted.has(a.contact_id)) {
      lastContacted.set(a.contact_id, { action: a.action, at: a.created_at })
    }
  }

  const scored = buildWinback(contacts, nowMs)
  const winback = []
  let snoozed = 0
  for (const r of scored) {
    const snz = snoozedUntil.get(r.contactId)
    if (snz && new Date(snz).getTime() > nowMs) { snoozed++; continue }
    winback.push({ ...r, lastContacted: lastContacted.get(r.contactId) || null })
  }
  return { winback, summary: { total: winback.length, snoozed } }
}
