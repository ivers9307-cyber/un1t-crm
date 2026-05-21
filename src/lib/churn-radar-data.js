// CHURN-RADAR.1 — server-side data access for the radar.
//
// Fetches the member rows + the recent action log for a location,
// runs the pure scoring (churn-radar.js), and overlays per-contact
// action state (last contacted, active snooze). DB-touching — kept
// out of churn-radar.js so that module stays pure + unit-tested.

import {
  buildRadar,
  radarSummary,
  classifyContact,
  MEMBER_STATUSES,
} from '@/lib/churn-radar'

// Columns the scorer + UI need from contacts.
const MEMBER_COLUMNS =
  'id, name, glofox_membership_status, glofox_membership_plan, ' +
  'last_attended_at, last_booked_at, total_attended_30d, total_attended_7d, ' +
  'total_noshow_30d, total_bookings_30d, joined_at, lifetime_value_cents'

const CONTACTING_ACTIONS = ['contacted', 'task_assigned', 'winback_sent']

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
  const [members, actions] = await Promise.all([
    fetchMembers(db, locationId),
    fetchActions(db, locationId),
  ])

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

  const scored = buildRadar(members, nowMs)
  const radar = []
  let snoozed = 0
  for (const r of scored) {
    const snz = snoozedUntil.get(r.contactId)
    if (snz && new Date(snz).getTime() > nowMs) { snoozed++; continue }
    radar.push({ ...r, lastContacted: lastContacted.get(r.contactId) || null })
  }

  const summary = radarSummary(members, nowMs)
  return { radar, summary: { ...summary, snoozed } }
}

/**
 * Load the quarantine list — paying members with zero activity
 * footprint that haven't yet been triaged (no quarantine_* action).
 */
export async function loadQuarantine(db, locationId) {
  const [members, actions] = await Promise.all([
    fetchMembers(db, locationId),
    fetchActions(db, locationId),
  ])
  const triaged = new Set(
    actions
      .filter((a) => a.action === 'quarantine_stale' || a.action === 'quarantine_keep')
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
