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
  radarSummary,
  computeRecoveryStats,
  computeTrend,
  classifyContact,
  MEMBER_STATUSES,
} from '@/lib/churn-radar'

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
  'total_bookings_30d, joined_at, lifetime_value_cents'

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
 * RADAR-OVERDUE.1 — the authoritative arrears signal. Aggregates every
 * OPEN `PAST_DUE` invoice per contact at the location (from
 * `glofox_invoices`, kept current by the INVOICE_UPDATED webhook) into
 * `{ amountCents, count, oldestDueAt }`. This DRIVES the Overdue tab and
 * pulls past-due members off the at-risk list — replacing the stale,
 * unreliable `glofox_membership_state='locked'` signal (see the audit at
 * docs/CHURN_OVERDUE_AUDIT_2026-06.md). Returns `{ ids: Set, byId: Map }`.
 */
async function fetchPastDue(db, locationId) {
  const byId = new Map()
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('glofox_invoices')
      .select('contact_id, amount_cents, invoice_date')
      .eq('location_id', locationId)
      .eq('status', 'PAST_DUE')
      .not('contact_id', 'is', null)
      .order('contact_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    for (const r of data || []) {
      const cur = byId.get(r.contact_id) || { amountCents: 0, count: 0, oldestDueAt: null }
      cur.amountCents += Number(r.amount_cents) || 0
      cur.count += 1
      if (r.invoice_date && (!cur.oldestDueAt || r.invoice_date < cur.oldestDueAt)) {
        cur.oldestDueAt = r.invoice_date
      }
      byId.set(r.contact_id, cur)
    }
    if (!data || data.length < PAGE) break
  }
  return { ids: new Set(byId.keys()), byId }
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
 * base can exceed Supabase's ~1000-row response cap.
 */
async function fetchMembers(db, locationId) {
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
  // can affect the radar. The bound also keeps this query well under
  // Supabase's 1000-row response cap without needing to paginate.
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const { data } = await db
    .from('churn_radar_actions')
    .select('contact_id, action, snooze_until, created_at')
    .eq('location_id', locationId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
  return data || []
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
  const members = allMembers.filter((m) => !dismissed.has(m.id))
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

  // RADAR-OVERDUE.1 — the headline Overdue count + value are the FULL
  // past-due chase-list (incl. ex-members who still owe), so the badge
  // matches the Overdue tab. radarSummary only sees the member base.
  const overdueIds = [...pastDue.ids].filter((id) => !dismissed.has(id))
  const overdueValueCents = overdueIds.reduce(
    (sum, id) => sum + (pastDue.byId.get(id)?.amountCents || 0), 0)

  const finalSummary = {
    ...summary, quarantine: quarantineOpen, snoozed, recovery,
    overdue: overdueIds.length, overdueValueCents,
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
  const members = allMembers.filter((m) => !dismissed.has(m.id))
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
export async function loadOverdue(db, locationId, nowMs = Date.now()) {
  const [pastDue, actions, dismissed] = await Promise.all([
    fetchPastDue(db, locationId),
    fetchActions(db, locationId),
    fetchDismissed(db, locationId),
  ])
  const ids = [...pastDue.ids].filter((id) => !dismissed.has(id))
  const contacts = await fetchContactsByIds(db, ids)

  // Actions are newest-first — first hit per contact is the latest.
  const lastContacted = new Map()
  for (const a of actions) {
    if (CONTACTING_ACTIONS.includes(a.action) && !lastContacted.has(a.contact_id)) {
      lastContacted.set(a.contact_id, { action: a.action, at: a.created_at })
    }
  }

  const overdue = buildOverdue(contacts, nowMs, { pastDueById: pastDue.byId }).map((r) => ({
    ...r,
    lastContacted: lastContacted.get(r.contactId) || null,
  }))
  const totalValueCents = overdue.reduce((sum, r) => sum + (r.amountOwedCents || 0), 0)
  return { overdue, summary: { total: overdue.length, totalValueCents } }
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
  const contacts = allContacts.filter((c) => !dismissed.has(c.id))

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
