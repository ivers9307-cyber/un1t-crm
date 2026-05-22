// LEAD-RADAR.1 — server-side data access for the Lead Radar.
//
// Fetches the non-member contact rows + the recent action log for a
// location, runs the pure scoring (lead-radar.js), and overlays
// per-contact action state (last contacted, active snooze, cleanup
// triage). DB-touching — kept out of lead-radar.js so that module
// stays pure + unit-tested.

import {
  buildFunnel,
  buildCleanup,
  buildClassPass,
  leadRadarSummary,
  computeLeadConversionStats,
  computeLeadTrend,
  NON_MEMBER_STATUSES,
} from '@/lib/lead-radar'

// Columns the scorer + UI need from contacts. Narrow on purpose —
// the non-member base is ~7,000 rows, so every column counts.
const CONTACT_COLUMNS =
  'id, name, email, phone, glofox_membership_status, ' +
  'last_attended_at, last_booked_at, joined_at, lead_source'

const CONTACTING_ACTIONS = ['contacted']

/**
 * Fetch every non-member contact at a location. Paginated — the
 * non-member base (~7,000 rows) far exceeds Supabase's ~1000-row
 * response cap.
 */
async function fetchNonMembers(db, locationId) {
  const rows = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('contacts')
      .select(CONTACT_COLUMNS)
      .eq('location_id', locationId)
      .in('glofox_membership_status', NON_MEMBER_STATUSES)
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
    .from('lead_radar_actions')
    .select('contact_id, action, snooze_until, created_at')
    .eq('location_id', locationId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
  return data || []
}

// Reduce the action log to per-contact maps: most-recent contacting
// action, active snooze, and the set of cleanup-triaged contacts.
function indexActions(actions) {
  const lastContacted = new Map()
  const snoozedUntil = new Map()
  const triaged = new Set()
  for (const a of actions) {
    if (a.action === 'snoozed' && a.snooze_until) {
      const cur = snoozedUntil.get(a.contact_id)
      if (!cur || a.snooze_until > cur) snoozedUntil.set(a.contact_id, a.snooze_until)
    }
    if (CONTACTING_ACTIONS.includes(a.action) && !lastContacted.has(a.contact_id)) {
      lastContacted.set(a.contact_id, { action: a.action, at: a.created_at })
    }
    if (a.action === 'cleanup_archive' || a.action === 'cleanup_keep') {
      triaged.add(a.contact_id)
    }
  }
  return { lastContacted, snoozedUntil, triaged }
}

/**
 * Load the scored funnel for a location — the live non-member cohort
 * worth a follow-up. Snoozed contacts are counted but excluded from
 * the list. Each funnel row carries its most recent contacting
 * action.
 *
 * @returns {Promise<{ funnel: object[], summary: object }>}
 */
export async function loadFunnel(db, locationId, nowMs = Date.now()) {
  const [contacts, actions] = await Promise.all([
    fetchNonMembers(db, locationId),
    fetchActions(db, locationId),
  ])
  const { lastContacted, snoozedUntil } = indexActions(actions)

  const scored = buildFunnel(contacts, nowMs)
  const funnel = []
  let snoozed = 0
  for (const r of scored) {
    const snz = snoozedUntil.get(r.contactId)
    if (snz && new Date(snz).getTime() > nowMs) { snoozed++; continue }
    funnel.push({ ...r, lastContacted: lastContacted.get(r.contactId) || null })
  }

  // LEAD-OUTCOMES.1 — did the outreach land? Of the leads contacted
  // in the last 90 days, how many booked or attended afterwards.
  const conversion = computeLeadConversionStats(contacts, actions, nowMs)

  const summary = leadRadarSummary(contacts, nowMs)
  const finalSummary = { ...summary, snoozed, conversion }

  // LEAD-TREND.1 — week-over-week deltas vs the most recent weekly
  // snapshot (written by the lead-radar-snapshot cron). Null until
  // the first snapshot exists.
  const { data: snapshot } = await db
    .from('lead_radar_snapshots')
    .select('captured_at, funnel_total, attending, fresh, cleanup_total')
    .eq('location_id', locationId)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  finalSummary.trend = computeLeadTrend(finalSummary, snapshot || null)

  return { funnel, summary: finalSummary }
}

/**
 * Load the cleanup list — dormant non-member records that are
 * archive candidates and haven't yet been triaged (no cleanup_*
 * action). Returns the full sorted list; the API route paginates.
 *
 * @returns {Promise<{ cleanup: object[], summary: object }>}
 */
export async function loadCleanup(db, locationId, nowMs = Date.now()) {
  const [contacts, actions] = await Promise.all([
    fetchNonMembers(db, locationId),
    fetchActions(db, locationId),
  ])
  const { triaged } = indexActions(actions)

  const rows = buildCleanup(contacts, nowMs).filter((r) => !triaged.has(r.contactId))
  const summary = leadRadarSummary(contacts, nowMs)
  return { cleanup: rows, summary: { ...summary, triaged: triaged.size } }
}

/**
 * LEAD-CLASSPASS.1 — load the ClassPass list for a location: every
 * classpass_payg non-member, most recently active first. Read-only —
 * no action overlay, no snooze, no triage — so unlike loadFunnel /
 * loadCleanup it skips the action-log fetch entirely. The API route
 * paginates the returned list.
 *
 * @returns {Promise<{ classpass: object[], summary: object }>}
 */
export async function loadClassPass(db, locationId, nowMs = Date.now()) {
  const contacts = await fetchNonMembers(db, locationId)
  const classpass = buildClassPass(contacts, nowMs)
  const summary = leadRadarSummary(contacts, nowMs)
  return { classpass, summary }
}
