// Membership snapshot — DASH-MEMBERSHIP.1 (daily since TREND-DAILY.1).
//
// Computes the point-in-time membership breakdown for a location and
// upserts it into membership_snapshots (one row per location per DAY;
// rows before 2026-07-29 are the legacy monthly first-of-month
// baselines and stay valid points on the same axis). Powers the
// business dashboard's trend chart. The live breakdown cards read
// `contacts` directly; this is only for history.
//
// Cohort = contacts Glofox labels a member (status in member /
// credit_member). Split by membership_type:
//   monthly_recurring — type='time'        (subscriptions)
//   class_packs        — type='num_classes' (credit packs)
//   payg               — type='payg'
// Plus two sub-metrics worth trending: active recurring (state=active)
// and "dead" packs (num_classes with no credits left = NULL credits).

import { dublinDayStr } from '@/lib/dublin-time'

const MEMBER_STATUSES = ['member', 'credit_member']

/**
 * First-of-month date string (YYYY-MM-01) for a given date. Was the
 * snapshot's logical key when the cron ran monthly; still used by
 * studio-pulse as the month-comparison boundary. Pure; exported.
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
 * Compute + upsert the snapshot for a location for the current Dublin
 * day (or opts.snapshotDate / opts.now). Idempotent via the
 * (location_id, snapshot_date) unique constraint — the daily cron
 * re-running just refreshes the same day's row.
 */
export async function writeMembershipSnapshot(db, locationId, opts = {}) {
  const snapshotDate = opts.snapshotDate || dublinDayStr(opts.now ? new Date(opts.now) : Date.now())
  const counts = await computeMembershipCounts(db, locationId)
  const row = { location_id: locationId, snapshot_date: snapshotDate, ...counts }
  const { error } = await db
    .from('membership_snapshots')
    .upsert(row, { onConflict: 'location_id,snapshot_date' })
  if (error) throw new Error(`writeMembershipSnapshot: ${error.message}`)
  return { snapshot_date: snapshotDate, ...counts }
}


/**
 * First-of-month date string `months` calendar months before today
 * (Dublin). Pure string math — no Date parsing/formatting mix.
 */
function monthsAgoFirst(months, todayStr = dublinDayStr(Date.now())) {
  const y = Number(todayStr.slice(0, 4))
  const m = Number(todayStr.slice(5, 7))
  const total = y * 12 + (m - 1) - months
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`
}

/**
 * Read the snapshot trend for a location over the last `months`
 * calendar months, oldest → newest, for the business-board trend
 * chart. Returns a plain array of { date: 'YYYY-MM-DD',
 * month: 'YYYY-MM', monthly_recurring, class_packs, payg,
 * total_members, active_recurring, dead_packs }.
 *
 * granularity:
 *   'monthly' (default) — first-of-month rows only. The pre-daily
 *     behaviour; keeps the mobile TrendMini at ≤12 columns.
 *   'daily' — every snapshot in the window (web line chart; the cron
 *     writes one row per day so this is ≤ ~370 rows, under the
 *     1k-row select cap).
 */
export async function fetchMembershipTrend(db, locationId, months = 12, { granularity = 'monthly' } = {}) {
  const { data, error } = await db
    .from('membership_snapshots')
    .select('snapshot_date, monthly_recurring, class_packs, payg, total_members, active_recurring, dead_packs')
    .eq('location_id', locationId)
    .gte('snapshot_date', monthsAgoFirst(months))
    .order('snapshot_date', { ascending: true })
    .limit(800)
  if (error) throw new Error(`fetchMembershipTrend: ${error.message}`)
  let rows = data || []
  if (granularity === 'monthly') {
    rows = rows.filter((r) => String(r.snapshot_date).endsWith('-01'))
  }
  return rows.map((r) => ({
    date: String(r.snapshot_date).slice(0, 10),
    month: String(r.snapshot_date).slice(0, 7),
    monthly_recurring: r.monthly_recurring,
    class_packs: r.class_packs,
    payg: r.payg,
    total_members: r.total_members,
    active_recurring: r.active_recurring,
    dead_packs: r.dead_packs,
  }))
}
