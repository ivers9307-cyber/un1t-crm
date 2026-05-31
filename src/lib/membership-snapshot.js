// Membership snapshot — DASH-MEMBERSHIP.1.
//
// Computes the point-in-time membership breakdown for a location and
// upserts it into membership_snapshots (one row per location per month).
// Powers the business dashboard's 12-month trend chart. The live
// breakdown cards read `contacts` directly; this is only for history.
//
// Cohort = contacts Glofox labels a member (status in member /
// credit_member). Split by membership_type:
//   monthly_recurring — type='time'        (subscriptions)
//   class_packs        — type='num_classes' (credit packs)
//   payg               — type='payg'
// Plus two sub-metrics worth trending: active recurring (state=active)
// and "dead" packs (num_classes with no credits left = NULL credits).

const MEMBER_STATUSES = ['member', 'credit_member']

/**
 * First-of-month date string (YYYY-MM-01) for a given date. The
 * snapshot's logical key — re-running in the same month upserts the
 * same row. Pure; exported for tests.
 */
export function firstOfMonth(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d)
  const y = dt.getUTCFullYear()
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

/**
 * Count contacts matching a set of equality filters at a location.
 * Uses a head-only exact count (no rows transferred). `extra` is an
 * optional callback to apply further query constraints (e.g. is null).
 */
async function countContacts(db, locationId, filters, extra = null) {
  let q = db
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
  for (const [col, val] of Object.entries(filters)) {
    q = Array.isArray(val) ? q.in(col, val) : q.eq(col, val)
  }
  if (extra) q = extra(q)
  const { count, error } = await q
  if (error) throw new Error(`countContacts(${JSON.stringify(filters)}): ${error.message}`)
  return count || 0
}

/**
 * Compute the membership counts for one location. Returns the shape
 * stored in membership_snapshots (minus the keys the cron adds).
 */
export async function computeMembershipCounts(db, locationId) {
  const base = { glofox_membership_status: MEMBER_STATUSES }

  const [total, monthly, packs, payg, activeRecurring, deadPacks] = await Promise.all([
    countContacts(db, locationId, base),
    countContacts(db, locationId, { ...base, glofox_membership_type: 'time' }),
    countContacts(db, locationId, { ...base, glofox_membership_type: 'num_classes' }),
    countContacts(db, locationId, { ...base, glofox_membership_type: 'payg' }),
    countContacts(db, locationId, { ...base, glofox_membership_type: 'time', glofox_membership_state: 'active' }),
    countContacts(db, locationId, { ...base, glofox_membership_type: 'num_classes' },
      (q) => q.is('trial_credits_remaining', null)),
  ])

  const intervals = ['1 month', '3 months', '6 months', '12 months']
  const intervalCounts = await Promise.all(intervals.map((iv) =>
    countContacts(db, locationId, { ...base, glofox_membership_type: 'time', glofox_billing_interval: iv })))
  const recurringByInterval = Object.fromEntries(
    intervals.map((iv, i) => [iv, intervalCounts[i]]))

  return {
    total_members: total,
    monthly_recurring: monthly,
    class_packs: packs,
    payg,
    active_recurring: activeRecurring,
    dead_packs: deadPacks,
    detail: { recurring_by_interval: recurringByInterval },
  }
}

/**
 * Compute + upsert the snapshot for a location at the given month.
 * Idempotent via the (location_id, snapshot_date) unique constraint.
 * Returns the written counts.
 */
export async function writeMembershipSnapshot(db, locationId, opts = {}) {
  const snapshotDate = opts.snapshotDate || firstOfMonth(opts.now ? new Date(opts.now) : new Date())
  const counts = await computeMembershipCounts(db, locationId)
  const row = { location_id: locationId, snapshot_date: snapshotDate, ...counts }
  const { error } = await db
    .from('membership_snapshots')
    .upsert(row, { onConflict: 'location_id,snapshot_date' })
  if (error) throw new Error(`writeMembershipSnapshot: ${error.message}`)
  return { snapshot_date: snapshotDate, ...counts }
}


/**
 * Read the last `months` monthly snapshots for a location, oldest →
 * newest, for the business-board trend chart. Returns a plain array of
 * { month: 'YYYY-MM', monthly_recurring, class_packs, payg,
 *   total_members, active_recurring, dead_packs }.
 */
export async function fetchMembershipTrend(db, locationId, months = 12) {
  const { data, error } = await db
    .from('membership_snapshots')
    .select('snapshot_date, monthly_recurring, class_packs, payg, total_members, active_recurring, dead_packs')
    .eq('location_id', locationId)
    .order('snapshot_date', { ascending: false })
    .limit(months)
  if (error) throw new Error(`fetchMembershipTrend: ${error.message}`)
  const rows = (data || []).slice().reverse() // oldest → newest for the chart
  return rows.map((r) => ({
    month: typeof r.snapshot_date === 'string' ? r.snapshot_date.slice(0, 7) : r.snapshot_date,
    monthly_recurring: r.monthly_recurring,
    class_packs: r.class_packs,
    payg: r.payg,
    total_members: r.total_members,
    active_recurring: r.active_recurring,
    dead_packs: r.dead_packs,
  }))
}
