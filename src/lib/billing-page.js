// INTEG-D1 — tenant "Billing & usage" page: pure helpers + read-only
// assembler shared by /settings/billing and GET /api/settings/billing
// (one query/aggregation path, two callers — the SAAS4-M3
// usage-summary pattern).
//
// READ-ONLY. Nothing here writes: wallet balances stay wallet_apply-
// only (src/lib/wallet.js), and the single billing write surface is
// the auto-topup CONFIG route (three dormant wallets.auto_topup_*
// columns — config, not balance).
//
// PINNING-GATED. An org with zero active tier pinnings gets
// { pinned: false, locations: [] } and the page renders a quiet empty
// state — that is every real org today (UN1T Group, CCF Autos), so
// this whole surface is inert until a location is pinned via the
// admin plan-assignment leg.
//
// Meter sources (mirrors the mig 411/421 ledger split):
//   wa_template_send / email_send — usage_rollups_daily (nightly, can
//     lag a day; labelled as such in the UI).
//   ai_message — DERIVED live: COUNT of usage_events rows with
//     meter='anthropic_tokens' and an allowance-eligible source
//     (source != 'assistant_chat'; the staff assistant is metered but
//     allowance-EXEMPT per Richard 2026-07-19, and is surfaced as a
//     separate number, never against the allowance).

import { METER_KEYS } from '@shared/plans'
import { getLocationPlan } from '@/lib/plans'
import { getWallet, currentPeriodStart, nextPeriodStart } from '@/lib/wallet'
import { dublinTodayStr, dublinDayStartMs, addDaysISO } from '@/lib/dublin-time'

const DAY_MS = 24 * 3600 * 1000

// Lapse-warning thresholds (Richard's mockup spec): warn when MORE
// THAN €10 of wallet credit will expire within 7 days of the Dublin
// month end. Wallet credit is a monthly usage budget — it never rolls
// over (explicit expiry_reset at the boundary, mig 420).
export const LAPSE_WARNING_MIN_CENTS = 1000
export const LAPSE_WARNING_WINDOW_DAYS = 7

/**
 * Pure: the last day of the Dublin calendar month containing dateStr.
 * Wallet credit expires at the end of the billing month (= Dublin
 * calendar month v1 — src/lib/wallet.js documents the assumption), so
 * this is the "expires <date>" the wallet block shows.
 *
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @returns {string} 'YYYY-MM-DD' — last day of that month
 */
export function lastDayOfDublinMonth(dateStr) {
  return addDaysISO(nextPeriodStart(dateStr), -1)
}

function utcMsOfDateStr(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/**
 * Pure: whole days from todayStr to the end of its Dublin month
 * (0 on the last day of the month). Calendar math only — both dates
 * are timezoneless date strings compared via UTC ms.
 *
 * @param {string} todayStr - 'YYYY-MM-DD'
 * @returns {number}
 */
export function daysLeftInMonth(todayStr) {
  return Math.round(
    (utcMsOfDateStr(lastDayOfDublinMonth(todayStr)) - utcMsOfDateStr(todayStr)) / DAY_MS
  )
}

/**
 * Pure: should the late-month lapse warning show for a wallet?
 * True when MORE than €10 (strict >) of credit would expire within
 * LAPSE_WARNING_WINDOW_DAYS of the month end. Negative / zero / small
 * balances never warn — there is nothing meaningful to lose.
 *
 * @param {{ balanceCents: number, todayStr?: string }} p
 * @returns {boolean}
 */
export function walletLapseWarning({ balanceCents, todayStr = dublinTodayStr() }) {
  if (!(Number(balanceCents) > LAPSE_WARNING_MIN_CENTS)) return false
  return daysLeftInMonth(todayStr) <= LAPSE_WARNING_WINDOW_DAYS
}

/**
 * Pure: shape month-to-date usage against the resolved allowances for
 * one location. Keys follow shared/plans.js METER_KEYS; `over` is the
 * "+N over" red suffix the meters row renders (0 = within allowance).
 *
 * @param {object|null} allowances - resolved allowance numbers per meter
 * @param {object|null} used - MTD usage per meter
 * @returns {Record<string, { used: number, allowance: number, over: number }>}
 */
export function shapeMeterUsage(allowances, used) {
  const out = {}
  for (const key of METER_KEYS) {
    const allowance = toCount(allowances?.[key])
    const u = toCount(used?.[key])
    out[key] = { used: u, allowance, over: Math.max(0, u - allowance) }
  }
  return out
}

/**
 * Pure: fold usage_rollups_daily rows into per-location per-meter
 * quantity totals: { [location_id]: { [meter]: quantity } }.
 *
 * @param {Array<{ location_id: string, meter: string, quantity: number|string }>} rows
 */
export function foldRollupsByLocation(rows) {
  const byLocation = {}
  for (const row of rows || []) {
    const loc = (byLocation[row.location_id] ||= {})
    loc[row.meter] = (loc[row.meter] || 0) + (Number(row.quantity) || 0)
  }
  return byLocation
}

function toCount(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// Month rollups for the pinned locations. Two meters × ≤31 days ×
// locations can exceed the PostgREST 1k cap for a large org —
// .range()-paginate with an explicit order (the pipeline-reclassify
// pattern, same as usage-summary.js).
async function fetchMonthRollups(db, locationIds, monthStart) {
  const PAGE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data } = await db
      .from('usage_rollups_daily')
      .select('location_id, meter, quantity')
      .in('location_id', locationIds)
      .in('meter', ['wa_template_send', 'email_send'])
      .gte('day', monthStart)
      .order('day', { ascending: true })
      .order('location_id', { ascending: true })
      .order('meter', { ascending: true })
      .range(from, from + PAGE - 1)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

// Live derived ai_message counts for one location: billable (allowance-
// eligible) vs staff-assistant (allowance-EXEMPT, shown separately).
// occurred_at is timestamptz, so the month boundary must be the UTC
// instant of Dublin local midnight on the 1st (dublinDayStartMs), not
// a naive 'T00:00:00Z' — during IST those differ by an hour.
async function fetchAiMessageCounts(db, locationId, monthStartIso) {
  const base = () =>
    db
      .from('usage_events')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('meter', 'anthropic_tokens')
      .gte('occurred_at', monthStartIso)
  const [{ count: billable }, { count: exempt }] = await Promise.all([
    base().neq('source', 'assistant_chat'),
    base().eq('source', 'assistant_chat'),
  ])
  return { billable: billable || 0, exempt: exempt || 0 }
}

/**
 * Assemble everything /settings/billing renders for one org.
 *
 * @param {object} db - service-role client (route/page constructs it)
 * @param {string} orgId
 * @param {{ todayStr?: string }} [opts] - injectable for tests
 * @returns {Promise<{
 *   organization_id: string,
 *   month_start: string,
 *   pinned: boolean,
 *   locations: Array<object>,
 *   billing_contact: null,
 *   billing_contact_supported: false,
 * }>}
 */
export async function getBillingPageData(db, orgId, { todayStr = dublinTodayStr() } = {}) {
  const monthStart = currentPeriodStart(todayStr)
  const monthStartIso = new Date(dublinDayStartMs(monthStart)).toISOString()

  const { data: locs, error } = await db
    .from('locations')
    .select('id, name')
    .eq('organization_id', orgId)
    .eq('is_host_anchor', false)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`getBillingPageData: ${error.message}`)

  // Resolve pinnings first — unpinned locations are INVISIBLE to
  // billing (getLocationPlan() null = "no plan constraints", the
  // normal state for every existing location).
  const pinned = []
  for (const loc of locs || []) {
    const plan = await getLocationPlan(db, loc.id)
    if (plan) pinned.push({ loc, plan })
  }

  const base = {
    organization_id: orgId,
    month_start: monthStart,
    // No billing-contact columns exist on organizations/org_settings
    // yet (verified 2026-07-20) — the page renders the fields disabled
    // with a "coming soon" note; no migration in this item by design.
    billing_contact: null,
    billing_contact_supported: false,
  }
  if (pinned.length === 0) return { ...base, pinned: false, locations: [] }

  const rollupsByLocation = foldRollupsByLocation(
    await fetchMonthRollups(db, pinned.map((p) => p.loc.id), monthStart)
  )

  const locations = []
  for (const { loc, plan } of pinned) {
    const [wallet, ai, { data: ledger }] = await Promise.all([
      getWallet(db, loc.id),
      fetchAiMessageCounts(db, loc.id, monthStartIso),
      db
        .from('wallet_transactions')
        .select('id, kind, amount_cents, meter, qty, unit_rate_cents, balance_after_cents, note, created_at')
        .eq('location_id', loc.id)
        .order('created_at', { ascending: false })
        .limit(20),
    ])

    const rollups = rollupsByLocation[loc.id] || {}
    const balanceCents = wallet?.balance_cents ?? 0

    locations.push({
      location_id: loc.id,
      location_name: loc.name,
      plan: {
        tier_name: plan.tier.plan.name,
        tier_slug: plan.tier.plan.slug,
        price_cents: plan.tier.version.price_cents,
        currency: plan.tier.version.currency || 'EUR',
        effective_from: plan.tier.version.effective_from,
        addons: plan.addons.map((a) => ({
          name: a.plan.name,
          slug: a.plan.slug,
          price_cents: a.version.price_cents,
        })),
      },
      meters: shapeMeterUsage(plan.resolved?.allowances, {
        wa_template_send: rollups.wa_template_send,
        email_send: rollups.email_send,
        ai_message: ai.billable,
      }),
      assistant_exempt_messages: ai.exempt,
      wallet: {
        balance_cents: balanceCents,
        period_start: wallet?.period_start ?? null,
        expires_on: lastDayOfDublinMonth(todayStr),
        lapse_warning: walletLapseWarning({ balanceCents, todayStr }),
        auto_topup: {
          enabled: wallet?.auto_topup_enabled ?? false,
          amount_cents: wallet?.auto_topup_amount_cents ?? null,
          threshold_cents: wallet?.auto_topup_threshold_cents ?? null,
        },
        ledger: ledger || [],
      },
    })
  }

  return { ...base, pinned: true, locations }
}
