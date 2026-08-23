// INTEG-B1/B2 — Integrations hub assembly.
//
// One place that turns today's scattered connection storage into the
// uniform card states the master-only hub page renders:
//
//   channel_connections  glofox / unifi / sensibo / thinq / twilio_sender /
//                        bca / instagram — the registry (migs 230/411/412),
//                        with legacy location-field fallback via the
//                        connection-registry pure mappers (dual-read, same
//                        rules as getConnection()).
//   xero_connections     per-location Xero OAuth binding (tenant + scopes).
//   whatsapp_numbers     per-location WA Cloud API numbers (read-only here).
//   ad_accounts          Meta/TikTok ad account presence (read-only here).
//   shelly_connections / per-location smart-plug account + adopted device
//   shelly_devices       counts (migs 562/563) — non-secret columns only,
//                        deep-linking to /automations/shelly.
//   locations.settings   customer_agent block → the AI-agent live signal.
//   location_plans /     the plan & wallet strip (INTEG-C4) — pinned
//   wallets / usage      tier + wallet balance + MTD meter usage vs
//                        allowance; read-only and PINNING-GATED (an
//                        unpinned location yields plan: null and no
//                        wallet/usage query runs when nothing is pinned).
//
// Status model (mirrors channel_connections.status + the hub mockup):
//   connected | action_needed | error | not_connected
// (coming_soon / platform_managed are presentation-only tiers, not row
// states — the UI applies them to static cards.)
//
// SECRETS NEVER LEAVE THIS MODULE. The assembler selects no token
// columns from the registry / whatsapp_numbers, maps
// ad_accounts.access_token straight to a has_access_token boolean
// (same posture as maskConnectionRow / maskAccountRow / publicShape),
// and selects neither shelly_connections.auth_key nor its
// auth_key_fingerprint — only key_hint, which publicConnectionView
// already treats as non-secret.
//
// Pure helpers up top (unit-tested in integrations-hub.test.js); the
// single async assembler at the bottom does batched reads only — one
// query per table, never one per location (PostgREST row cap noted:
// every read here is bounded — locations are few, and each source
// table holds at most a handful of rows per location).

import { logWarn } from '@/lib/log'
import { registryRowFromLegacy } from '@/lib/connection-registry'
import { EXPIRY_SOON_DAYS } from '@/lib/connection-health'
import { getSendBudget, tierDailyLimit } from '@/lib/whatsapp-budget'
import { resolveAllowances } from '@/lib/plans'
import { currentPeriodStart, nextPeriodStart } from '@/lib/wallet'
import { addDaysISO, dublinDayStr } from '@/lib/dublin-time'
import { METERS, METER_KEYS } from '@shared/plans'

export { EXPIRY_SOON_DAYS }

// Severity order for aggregating many rows into one card chip.
const STATUS_RANK = { error: 3, action_needed: 2, connected: 1, not_connected: 0 }

/**
 * Aggregate row statuses into a card-level status: any error wins,
 * then action_needed, then connected; no rows (or only unknown
 * strings) → not_connected. Pure.
 */
export function worstStatus(statuses) {
  let best = null
  for (const s of statuses || []) {
    if (!(s in STATUS_RANK)) continue
    if (best === null || STATUS_RANK[s] > STATUS_RANK[best]) best = s
  }
  if (best === null) return 'not_connected'
  // 'connected' outranks 'not_connected' for the card chip: a card with
  // one connected location and one unconnected shows Connected (the
  // per-location rows carry the detail) — matches the mockup's Glofox
  // card (Stillorgan connected, Hatch not).
  return best
}

/** Whole days until an ISO timestamp (ceil), or null when absent/invalid. Pure. */
export function daysUntil(value, now = new Date()) {
  if (!value) return null
  const t = new Date(value).getTime()
  if (Number.isNaN(t)) return null
  return Math.ceil((t - now.getTime()) / 86400000)
}

/**
 * Grade one whatsapp_numbers row into the hub status model. Read-only
 * mirror of the health columns the refresh-whatsapp-health cron and
 * template webhooks maintain (migs 329/393) — no WA send/routing code
 * is touched by the hub. Pure.
 */
export function gradeWhatsappNumber(row) {
  if (!row) return { status: 'not_connected', message: null }
  if (row.is_active === false) {
    return { status: 'not_connected', message: 'Number deactivated' }
  }
  if (row.token_invalid_at) {
    return {
      status: 'error',
      message: `Access token invalid since ${String(row.token_invalid_at).slice(0, 10)}`,
    }
  }
  if (row.quality_rating === 'RED') {
    return { status: 'action_needed', message: 'Meta quality rating is RED' }
  }
  return { status: 'connected', message: null }
}

/**
 * Grade one xero_connections row. Registry semantics: 'error' = the
 * last operation failed, see message (the three *_sync_error columns
 * are exactly that — a failed token refresh surfaces there too).
 * expires_at is deliberately NOT graded: Xero access tokens refresh
 * lazily on use (src/lib/xero/client.js), so a past expires_at just
 * means no recent API call. Pure.
 */
export function gradeXeroConnection(row) {
  if (!row || !row.tenant_id) return { status: 'not_connected', message: null }
  const syncError = row.accounts_sync_error || row.contacts_sync_error || row.tax_rates_sync_error
  if (syncError) return { status: 'error', message: String(syncError).slice(0, 300) }
  return { status: 'connected', message: null }
}

/**
 * Grade one shelly_connections row (SHELLY-UI.7). The column is
 * CHECK-constrained to connected|action_needed|error (mig 562), so the
 * three cases below are the whole domain — but an unknown string is
 * graded 'error' rather than waved through as connected, because the
 * one thing this card must never do is paint a broken studio green.
 *
 * The 'error' copy reads as RETRYING on purpose (PR-1 review obligation
 * 6): reconcile.js parks a failing connection for 5 minutes, so a single
 * blip from Shelly's cloud sets status='error' and clears itself on the
 * next tick. "Error — check the connection" would send an operator to
 * re-paste a key that is perfectly fine. 'action_needed' is the state
 * that genuinely needs hands: the auth key rotates whenever the owner
 * changes their Shelly password, and only a re-paste fixes it.
 *
 * `last_error` is a Shelly-side message written by reconcile.js
 * (redactSecret'd there) — never a URL and never the key. Pure.
 */
export function gradeShellyConnection(row) {
  if (!row) return { status: 'not_connected', message: null }
  switch (row.status) {
    case 'connected':
      return { status: 'connected', message: null }
    case 'action_needed':
      return {
        status: 'action_needed',
        message: 'Re-paste the Shelly auth key (it changes when the Shelly password changes)',
      }
    case 'error':
      return {
        status: 'error',
        message: row.last_error
          ? `Retrying — ${String(row.last_error).slice(0, 300)}`
          : 'Retrying — Shelly unreachable',
      }
    default:
      return { status: 'error', message: 'Unknown connection state' }
  }
}

/**
 * The AI-agent live signal from locations.settings.customer_agent.
 * INVARIANT (CLAUDE.md): enabled=true is LIVE FOR EVERYONE regardless
 * of test_mode — real test mode is enabled=false + test_mode=true. Pure.
 */
export function agentSignal(customerAgent) {
  const s = customerAgent || {}
  if (s.enabled) return 'live'
  if (s.test_mode) return 'test'
  return 'off'
}

/** Deep link to the existing per-location integrations tab. Pure. */
export function locationTabHref(locationId, tabKey) {
  return `/settings/locations/${locationId}?tab=${tabKey}`
}

/**
 * Grade one org's tenant_email_domains row (mig 427) into the Email-delivery
 * card's status vocabulary. B3 shipped the sending-domain wizard, so the hub
 * card now reflects real state:
 *   no row            → 'platform'      (sending via the shared account — the
 *                                        default/normal state for every org today)
 *   status='live'     → 'connected'     (custom domain verified + routing)
 *   pending/verifying → 'action_needed' (setup in progress)
 *   failed/disabled   → 'error'         (needs attention)
 *   anything else     → 'platform'      (defensive — the shared account is the
 *                                        safe fallback the send path already uses)
 * SECRET: the caller must select only the non-secret allowlist (never
 * postmark_server_token); this grades from the lifecycle status alone. Pure.
 */
export function gradeTenantEmail(row) {
  if (!row) return 'platform'
  switch (row.status) {
    case 'live': return 'connected'
    case 'pending':
    case 'verifying': return 'action_needed'
    case 'failed':
    case 'disabled': return 'error'
    default: return 'platform'
  }
}

/**
 * Deep link to the tenant email-domain wizard (INTEG-B3, /settings/email-domain).
 * Master reads ?organization_id to view a specific org; an owner resolves their
 * own org and the param is ignored — so appending it is master-correct and
 * owner-safe. Pure.
 */
export function emailDomainHref(orgId) {
  return orgId ? `/settings/email-domain?organization_id=${orgId}` : '/settings/email-domain'
}

// Card labels used by the attention strip.
const CARD_LABELS = {
  glofox: 'Glofox',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  xero: 'Xero',
  ads: 'Meta Ads',
  shelly: 'Shelly plugs',
  unifi: 'UniFi Access',
  climate: 'Climate devices',
  bca: 'BCA Submit',
}

/**
 * Build the "Needs attention" strip from assembled card rows.
 * Ordering (per the hub spec): error rows first, then tokens expiring
 * within `expirySoonDays`, then not_connected rows with evidence of a
 * partial setup (a registry row exists but is graded not_connected, or
 * a deactivated WhatsApp number) — bare absence never nags. Pure.
 *
 * @param {Array<{cardKey:string, locationId:string, locationName:string,
 *   status:string, message?:string|null, tokenExpiresAt?:string|null,
 *   partialSetup?:boolean, href:string}>} rows
 */
export function buildAttention(rows, { now = new Date(), expirySoonDays = EXPIRY_SOON_DAYS } = {}) {
  const errors = []
  const expiring = []
  const setup = []
  for (const r of rows || []) {
    const label = CARD_LABELS[r.cardKey] || r.cardKey
    if (r.status === 'error') {
      errors.push({
        severity: 'error',
        cardKey: r.cardKey,
        label,
        locationId: r.locationId,
        locationName: r.locationName,
        message: r.message || 'Connection error — see the integration page.',
        href: r.href,
      })
      continue
    }
    const days = daysUntil(r.tokenExpiresAt, now)
    if (days !== null && days <= expirySoonDays) {
      expiring.push({
        severity: 'warning',
        cardKey: r.cardKey,
        label,
        locationId: r.locationId,
        locationName: r.locationName,
        message: days <= 0
          ? 'Access token has expired. Reconnect to resume.'
          : `Access token expires in ${days} day${days === 1 ? '' : 's'}.`,
        href: r.href,
      })
      continue
    }
    if (r.status === 'action_needed') {
      expiring.push({
        severity: 'warning',
        cardKey: r.cardKey,
        label,
        locationId: r.locationId,
        locationName: r.locationName,
        message: r.message || 'Needs attention — see the integration page.',
        href: r.href,
      })
      continue
    }
    if (r.status === 'not_connected' && r.partialSetup) {
      setup.push({
        severity: 'info',
        cardKey: r.cardKey,
        label,
        locationId: r.locationId,
        locationName: r.locationName,
        message: r.message || 'Setup incomplete.',
        href: r.href,
      })
    }
  }
  return [...errors, ...expiring, ...setup]
}

// ─────────────────────────────────────────────────────────────
// Plan & wallet strip (INTEG-C4) — pure derivation helpers
// ─────────────────────────────────────────────────────────────
//
// Read-only aggregation kept LOCAL to the hub assembler on purpose:
// enforcement (draw posting) lives on the C3 track and a shared
// getBillingState-shaped helper may land later — when it does, this
// section collapses onto it. Nothing here writes; the strip only
// renders what plans/wallets/usage already recorded.

// Lapse warning (Richard's requirement): flag a wallet whose UNUSED
// credit is about to evaporate — strictly more than €10 of balance
// with 7 or fewer days until the monthly reset expires it.
export const LAPSE_WARN_MIN_CENTS = 1000
export const LAPSE_WARN_DAYS = 7

/**
 * Pure calendar-day difference between two YYYY-MM-DD strings
 * (to - from, in whole days). Timezoneless calendar math via UTC —
 * the addDaysISO pattern. null on unparseable input.
 */
export function calendarDaysBetween(fromStr, toStr) {
  const from = Date.parse(String(fromStr) + 'T00:00:00Z')
  const to = Date.parse(String(toStr) + 'T00:00:00Z')
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return Math.round((to - from) / 86400000)
}

/**
 * The date the current wallet credit expires: the LAST day of the
 * Dublin month containing todayStr (the monthly-reset cron zeroes the
 * balance at the next period start — see src/lib/wallet.js). Pure.
 */
export function billingExpiresOn(todayStr) {
  return addDaysISO(nextPeriodStart(todayStr), -1)
}

/**
 * Should the strip show the late-month lapse warning? True when a
 * balance STRICTLY over €10 would expire within LAPSE_WARN_DAYS days
 * (inclusive — the expiry day itself still warns). Pure.
 */
export function walletLapseWarning({ balanceCents, todayStr, expiresOn }) {
  if (!(Number(balanceCents) > LAPSE_WARN_MIN_CENTS)) return false
  const days = calendarDaysBetween(todayStr, expiresOn ?? billingExpiresOn(todayStr))
  return days !== null && days <= LAPSE_WARN_DAYS
}

/**
 * Group active location_plans embed rows into per-location pins:
 * { [locationId]: { tier: {plan, version}|null, addons: [{plan, version}] } }.
 * A location absent from the result (or with tier: null) is UNPINNED —
 * the normal state for every UN1T location today. Pure.
 */
export function groupPlanPins(rows) {
  const byLoc = {}
  for (const r of rows || []) {
    const plan = r?.version?.plan
    if (!plan) continue
    const { plan: _plan, ...version } = r.version
    const bucket = (byLoc[r.location_id] ||= { tier: null, addons: [] })
    if (plan.kind === 'tier') {
      bucket.tier = { plan, version } // one active tier pin per location (DB-enforced)
    } else if (plan.kind === 'addon') {
      bucket.addons.push({ plan, version })
    }
  }
  return byLoc
}

/**
 * Fold usage_rollups_daily rows into per-location per-meter MTD sums:
 * { [locationId]: { [meter]: quantity } }. Pure.
 */
export function foldMeterUsage(rows) {
  const byLoc = {}
  for (const r of rows || []) {
    if (!r?.location_id || !r?.meter) continue
    const loc = (byLoc[r.location_id] ||= {})
    loc[r.meter] = (loc[r.meter] || 0) + (Number(r.quantity) || 0)
  }
  return byLoc
}

// Draw ledger rows may carry either the billing meter key or the
// finer-grained unit-rate key (wa marketing/utility split, email per
// 1k — see shared/plans.js UNIT_RATE_KEYS); fold both onto the meter
// the strip displays so the suffix stays correct whichever the C3
// enforcement rollup posts.
const DRAW_METER_ALIASES = {
  wa_marketing: 'wa_template_send',
  wa_utility: 'wa_template_send',
  email_per_1k: 'email_send',
}

/**
 * Fold wallet_transactions draw rows (kind='draw', current period)
 * into per-location per-meter cents DRAWN (positive — draw
 * amount_cents are stored negative): { [locationId]: { [meter]: cents } }.
 * Pure.
 */
export function foldDrawCents(rows) {
  const byLoc = {}
  for (const r of rows || []) {
    if (!r?.location_id || !r?.meter) continue
    const meter = DRAW_METER_ALIASES[r.meter] || r.meter
    const loc = (byLoc[r.location_id] ||= {})
    loc[meter] = (loc[meter] || 0) + Math.max(0, -(Number(r.amount_cents) || 0))
  }
  return byLoc
}

/**
 * Build the strip's meter states from a resolved allowance set
 * (resolveAllowances output) + MTD usage + MTD overage draws. One
 * entry per shared/plans.js METER_KEYS, in registry order. Pure.
 *
 * @returns {Array<{ key, label, unit, used, allowance, overQty, overageDrawnCents }>}
 */
export function buildBillingMeters(resolved, usage = {}, drawnCents = {}) {
  return METER_KEYS.map((key) => {
    const allowance = Number(resolved?.allowances?.[key]) || 0
    const used = Number(usage[key]) || 0
    return {
      key,
      label: METERS[key].label,
      unit: METERS[key].unit,
      used,
      allowance,
      overQty: Math.max(0, used - allowance),
      overageDrawnCents: Number(drawnCents[key]) || 0,
    }
  })
}

// ─────────────────────────────────────────────────────────────
// Async assembler — batched reads, one query per table
// ─────────────────────────────────────────────────────────────

// Registry columns the hub reads. NO access_token / app_secret — the
// hub never needs secrets, so it never selects them.
const REGISTRY_HUB_COLUMNS =
  'id, location_id, platform, status, is_active, label, display_name, ' +
  'external_account_id, config, token_expires_at, last_error, last_ok_at'

const REGISTRY_PLATFORMS = ['glofox', 'unifi', 'sensibo', 'thinq', 'twilio_sender', 'bca', 'instagram']

// ── Shelly plugs (SHELLY-UI.7) ────────────────────────────────────────
//
// The hub card deep-links to /automations/shelly — the ACTIVE-LOCATION
// page — rather than to a per-location tab, because by decision there is
// no LocationIntegrations Shelly tab: managing another studio's plugs
// means switching location first. So every row carries the same href;
// the location name on the row is what tells the operator which studio
// the numbers describe. (Obligation 16: the card reads only non-secret
// columns and deep-links to that page.)
export const SHELLY_HREF = '/automations/shelly'

// Ceiling on the device read. Equal to the PostgREST 1,000-row select cap,
// so asking for more would be theatre — the cap applies regardless of
// .limit(). The per-location adopt cap is MAX_DEVICES_PER_LOCATION = 50
// (src/lib/shelly/schemas.js, pinned equal to reconcile.js's MAX_DEVICES),
// so this read is EXACT up to 20 in-scope locations and every real caller
// today is far under that: master sees the whole estate (a handful of
// locations), an owner only their own org's. Past 20 the counts would
// silently UNDERCOUNT, so a full page is logged rather than trusted —
// and note what does NOT depend on it: the card's STATUS comes from
// shelly_connections, which is one row per location and exactly bounded.
const SHELLY_DEVICE_ROW_CAP = 1000

function pickRegistry(rows, locationId, platform) {
  return (rows || []).find((r) => r.location_id === locationId && r.platform === platform) || null
}

// Non-array plain-object slice or {} — for reading a locations.settings sub-slice
// safely. Kept local (the connection-registry has its own copy for its mappers).
function plainSlice(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

// Billing meters that read straight off usage_rollups_daily
// (ai_message has no rollup meter — derived from usage_events, see
// shared/plans.js).
const ROLLUP_BILLING_METERS = METER_KEYS
  .map((key) => METERS[key].rollupMeter)
  .filter(Boolean)

// MTD rollups for the strip. locations × 2 meters × ≤31 days can pass
// the PostgREST 1k cap once enough locations are pinned —
// .range()-paginate with an explicit order (the pipeline-reclassify
// pattern, same as usage-summary.js).
async function fetchBillingRollups(db, locationIds, monthStart) {
  const PAGE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data } = await db
      .from('usage_rollups_daily')
      .select('location_id, meter, quantity')
      .in('location_id', locationIds)
      .in('meter', ROLLUP_BILLING_METERS)
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

// Current-period overage draws (kind='draw'; `period` stamps the
// wallet's period_start when the entry posted — mig 420). One draw
// per meter per location per day by design, but paginate anyway.
async function fetchPeriodDraws(db, locationIds, periodStart) {
  const PAGE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data } = await db
      .from('wallet_transactions')
      .select('location_id, meter, amount_cents')
      .in('location_id', locationIds)
      .eq('kind', 'draw')
      .eq('period', periodStart)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

// ai_message MTD = COUNT of allowance-eligible usage_events rows
// (meter='anthropic_tokens', source != 'assistant_chat' — the staff
// assistant is metered but allowance-exempt; month semantics match
// mig 421's org_ai_spend_month_cents). Head-only counts with plain
// column filters (the embedded-filter/head trap doesn't apply), one
// per TIER-PINNED location — bounded by the pinned count (zero
// today), the deliberate exception to one-query-per-table until an
// ai_message rollup meter exists.
async function fetchAiMessageCounts(db, locationIds, monthStart) {
  const entries = await Promise.all(locationIds.map(async (locationId) => {
    const { count } = await db
      .from('usage_events')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('meter', 'anthropic_tokens')
      .neq('source', 'assistant_chat')
      .gte('created_at', monthStart)
    return [locationId, count || 0]
  }))
  return Object.fromEntries(entries)
}

/**
 * Assemble the plan & wallet strip rows (INTEG-C4). Read-only and
 * PINNING-GATED: a location without an ACTIVE tier pin in
 * location_plans yields { locationId, plan: null } (the strip's quiet
 * placeholder), and when NOTHING is pinned — every UN1T location
 * today — no wallet/usage/ledger query runs at all.
 */
async function assembleBillingStrip(db, locs, todayStr) {
  const ids = locs.map((l) => l.id)
  const unpinnedAll = () => locs.map((l) => ({ locationId: l.id, plan: null }))
  if (!ids.length) return []

  const { data: pinRows } = await db
    .from('location_plans')
    .select(
      'location_id, ' +
      'version:plan_versions!plan_version_id(id, plan_id, effective_from, price_cents, currency, allowances, unit_rates_cents, features, ' +
      'plan:plans!plan_id(id, slug, name, kind))'
    )
    .in('location_id', ids)
    .eq('active', true)

  const pins = groupPlanPins(pinRows || [])
  const pinnedIds = ids.filter((id) => pins[id]?.tier)
  if (!pinnedIds.length) return unpinnedAll()

  const monthStart = currentPeriodStart(todayStr)
  const expiresOn = billingExpiresOn(todayStr)

  const [walletsRes, rollupRows, drawRows, aiCounts] = await Promise.all([
    db.from('wallets')
      .select('location_id, balance_cents, period_start')
      .in('location_id', pinnedIds),
    fetchBillingRollups(db, pinnedIds, monthStart),
    fetchPeriodDraws(db, pinnedIds, monthStart),
    fetchAiMessageCounts(db, pinnedIds, monthStart),
  ])

  const walletByLoc = Object.fromEntries(
    (walletsRes.data || []).map((w) => [w.location_id, w])
  )
  const usageByLoc = foldMeterUsage(rollupRows)
  const drawsByLoc = foldDrawCents(drawRows)

  return locs.map((loc) => {
    const pin = pins[loc.id]
    if (!pin?.tier) return { locationId: loc.id, plan: null }

    const resolved = resolveAllowances(pin.tier.version, pin.addons.map((a) => a.version))
    // No wallet row yet is normal (wallet_apply creates it lazily) —
    // render a zero balance for the current period.
    const wallet = walletByLoc[loc.id] || null
    const balanceCents = Number(wallet?.balance_cents) || 0
    const usage = { ...(usageByLoc[loc.id] || {}), ai_message: aiCounts[loc.id] || 0 }

    return {
      locationId: loc.id,
      plan: {
        name: pin.tier.plan.name,
        slug: pin.tier.plan.slug,
        effectiveFrom: pin.tier.version.effective_from,
        priceCents: pin.tier.version.price_cents,
        currency: pin.tier.version.currency || 'EUR',
        addons: pin.addons.map((a) => ({
          name: a.plan.name,
          slug: a.plan.slug,
          priceCents: a.version.price_cents,
        })),
      },
      wallet: {
        balanceCents,
        periodStart: wallet?.period_start || monthStart,
        expiresOn,
        lapseWarning: walletLapseWarning({ balanceCents, todayStr, expiresOn }),
      },
      meters: buildBillingMeters(resolved, usage, drawsByLoc[loc.id] || {}),
    }
  })
}

/**
 * Assemble the Email-delivery card's per-ORG state (INTEG-B3, mig 427).
 * Keyed by organization_id: ONE lookup per distinct org (deduped), never
 * one per location. SECRET: selects only the non-secret allowlist (the
 * tenantEmailStatePayload shape) — postmark_server_token is NEVER selected,
 * so the token can't leak into the hub payload. The org set derives entirely
 * from `locs`, which the route already scoped to the caller's org(s), so this
 * inherits that scope (master → every in-scope org; owner → only their own).
 * Each entry carries the in-scope locationIds of its org so the UI's location
 * scope switcher can filter the org rows.
 */
async function assembleEmailDelivery(db, locs, orgIds) {
  if (!orgIds.length) return []
  const [domRes, orgRes] = await Promise.all([
    db.from('tenant_email_domains')
      // Allowlist ONLY — postmark_server_token is a live sending credential
      // and is deliberately never selected here.
      .select('organization_id, status, sending_domain, from_email, from_name, dkim_verified, return_path_verified, last_error')
      .in('organization_id', orgIds),
    db.from('organizations').select('id, name').in('id', orgIds),
  ])
  const rowByOrg = Object.fromEntries((domRes.data || []).map((r) => [r.organization_id, r]))
  const nameByOrg = Object.fromEntries((orgRes.data || []).map((o) => [o.id, o.name]))
  const locsByOrg = {}
  for (const l of locs) {
    if (!l.organization_id) continue
    ;(locsByOrg[l.organization_id] ||= []).push(l.id)
  }
  return orgIds.map((orgId) => {
    const row = rowByOrg[orgId] || null
    return {
      organizationId: orgId,
      orgName: nameByOrg[orgId] || null,
      locationIds: locsByOrg[orgId] || [],
      status: gradeTenantEmail(row),
      sendingDomain: row?.sending_domain ?? null,
      fromEmail: row?.from_email ?? null,
      fromName: row?.from_name ?? null,
      dkimVerified: !!row?.dkim_verified,
      returnPathVerified: !!row?.return_path_verified,
      lastError: row?.last_error ?? null,
      href: emailDomainHref(orgId),
    }
  })
}

/**
 * Assemble the full hub payload for a set of locations. Master-only
 * callers (the /settings/integrations-hub page + GET /api/integrations/hub)
 * — the caller has already authorised; this only reads.
 *
 * @param {object} db  createServerClient() — service role
 * @param {Array<object>} locations  full location rows (id, name, organization_id,
 *   settings, sensibo_api_key, sensibo_pod_id, thinq_pat, thinq_client_id,
 *   thinq_country_code, twilio_alpha_sender_id, bca_config, features)
 * @param {{ now?: Date }} [opts]
 */
export async function assembleIntegrationsHub(db, locations, { now = new Date() } = {}) {
  const locs = Array.isArray(locations) ? locations : []
  const ids = locs.map((l) => l.id)
  const nameById = Object.fromEntries(locs.map((l) => [l.id, l.name]))

  // One batched query per table (never per location).
  const [regRes, xeroRes, waRes, adsRes, shellyConnRes, shellyDevRes] = await Promise.all([
    db.from('channel_connections')
      .select(REGISTRY_HUB_COLUMNS)
      .in('location_id', ids)
      .eq('is_active', true)
      .in('platform', REGISTRY_PLATFORMS),
    db.from('xero_connections')
      .select('location_id, tenant_id, tenant_name, tenant_type, connected_at, last_refreshed_at, scopes, accounts_last_synced_at, contacts_last_synced_at, tax_rates_last_synced_at, accounts_sync_error, contacts_sync_error, tax_rates_sync_error')
      .in('location_id', ids),
    db.from('whatsapp_numbers')
      .select('id, location_id, label, display_phone, source, token_type, connected_via, is_default, is_active, quality_rating, messaging_limit_tier, token_invalid_at')
      .in('location_id', ids)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true }),
    db.from('ad_accounts')
      .select('id, location_id, provider, external_account_id, display_name, is_active, access_token')
      .in('location_id', ids),
    // ── Shelly (SHELLY-UI.7) — see the card block below for the shape ──
    // NEVER auth_key, and never auth_key_fingerprint either: the fingerprint
    // is a sha256 OF the key, so publishing it turns "which account is this?"
    // into an offline check anyone holding a candidate key can run (the same
    // allowlist argument as NON_SECRET in src/lib/shelly/connections.js).
    // key_hint is the last ≤4 characters and IS non-secret — publicConnectionView
    // returns it, and the card renders it as ••••abcd.
    // updated_at is the LAST ATTEMPT: markConnectionStatus stamps it on every
    // reconcile tick that touches the status, success or failure, where
    // last_ok_at only advances on success. Next to each other they separate
    // "the cron is still retrying" from "nothing has touched this in days",
    // which is the whole question an operator has about a red badge.
    // location_id is UNIQUE on this table, so ids.length rows is the ceiling;
    // asking for one MORE makes a truncated read distinguishable from a full one.
    db.from('shelly_connections')
      .select('location_id, host, status, last_error, last_ok_at, updated_at, key_hint')
      .in('location_id', ids)
      .limit(ids.length + 1),
    db.from('shelly_devices')
      .select('location_id, enabled, last_state')
      .in('location_id', ids)
      .limit(SHELLY_DEVICE_ROW_CAP),
  ])

  const regRows = regRes.data || []
  const xeroRows = xeroRes.data || []
  const waRows = waRes.data || []
  // Map token presence to a boolean immediately — the raw value goes no
  // further than this line (maskAccountRow posture, without the echo).
  const adRows = (adsRes.data || []).map(({ access_token, ...rest }) => ({
    ...rest,
    has_access_token: Boolean(access_token),
  }))

  const attentionInputs = []

  // ── Glofox — per-location rows (registry first, legacy fallback) ──
  const glofox = locs.map((loc) => {
    const reg = pickRegistry(regRows, loc.id, 'glofox')
    const legacy = registryRowFromLegacy('glofox', loc) // presence only — secrets stay here
    const status = reg ? reg.status : (legacy ? 'connected' : 'not_connected')
    // Presence booleans + non-secret prefill for the Phase-2 Manage drawer.
    // Read off the LEGACY slice (authoritative during the dual-write phase);
    // each secret maps straight to a boolean — the value never leaves here.
    const g = plainSlice(loc.settings?.glofox)
    const row = {
      locationId: loc.id,
      status,
      branchId: reg ? reg.external_account_id : (legacy?.external_account_id ?? null),
      namespace: g.namespace ?? null,
      hasApiKey: !!g.api_key,
      hasApiToken: !!g.api_token,
      hasWebhookSecret: !!g.webhook_secret,
      lastOkAt: reg?.last_ok_at ?? null,
      lastError: reg?.last_error ?? null,
      source: reg ? 'registry' : 'legacy',
      href: locationTabHref(loc.id, 'glofox'),
    }
    attentionInputs.push({
      cardKey: 'glofox', locationId: loc.id, locationName: nameById[loc.id],
      status, message: row.lastError, tokenExpiresAt: reg?.token_expires_at ?? null,
      partialSetup: !!reg && status === 'not_connected', href: row.href,
    })
    return row
  })

  // ── WhatsApp — per-location numbers + optional tier budget meter ──
  const whatsapp = await Promise.all(locs.map(async (loc) => {
    const numbers = waRows.filter((n) => n.location_id === loc.id).map((n) => {
      const grade = gradeWhatsappNumber(n)
      return {
        id: n.id,
        label: n.label,
        displayPhone: n.display_phone,
        source: n.source,
        connectedVia: n.connected_via,
        isDefault: n.is_default,
        isActive: n.is_active,
        qualityRating: n.quality_rating || null,
        tier: n.messaging_limit_tier || null,
        status: grade.status,
        message: grade.message,
      }
    })
    const status = worstStatus(numbers.map((n) => n.status))
    const href = locationTabHref(loc.id, 'whatsapp')

    // Daily tier budget (WA-BUDGET) — only when a default active number
    // carries a gated tier; UNLIMITED/unknown tiers have no meter.
    let budget = null
    const gated = numbers.find((n) => n.isActive && n.tier && tierDailyLimit(n.tier) != null)
    if (gated) {
      try {
        budget = await getSendBudget(db, { locationId: loc.id, tier: gated.tier })
      } catch {
        budget = null // meter is decorative — never fail the hub for it
      }
    }

    const errNumber = numbers.find((n) => n.status === 'error')
    attentionInputs.push({
      cardKey: 'whatsapp', locationId: loc.id, locationName: nameById[loc.id],
      status, message: errNumber?.message || numbers.find((n) => n.message)?.message || null,
      partialSetup: numbers.length > 0 && status === 'not_connected', href,
    })
    return { locationId: loc.id, status, numbers, budget, href }
  }))

  // ── Instagram — registry rows (health cron maintains status) ──
  const instagram = locs.flatMap((loc) => {
    const reg = pickRegistry(regRows, loc.id, 'instagram')
    if (!reg) return []
    const href = locationTabHref(loc.id, 'instagram')
    attentionInputs.push({
      cardKey: 'instagram', locationId: loc.id, locationName: nameById[loc.id],
      status: reg.status, message: reg.last_error,
      tokenExpiresAt: reg.token_expires_at, partialSetup: reg.status === 'not_connected', href,
    })
    return [{
      locationId: loc.id,
      status: reg.status,
      displayName: reg.display_name || reg.label || null,
      externalAccountId: reg.external_account_id || null,
      tokenExpiresAt: reg.token_expires_at || null,
      tokenDaysLeft: daysUntil(reg.token_expires_at, now),
      lastOkAt: reg.last_ok_at || null,
      lastError: reg.last_error || null,
      href,
    }]
  })

  // ── Xero — per-location OAuth binding (mirrors XeroIntegrationTab) ──
  const xero = locs.flatMap((loc) => {
    const row = xeroRows.find((x) => x.location_id === loc.id) || null
    const grade = gradeXeroConnection(row)
    const href = locationTabHref(loc.id, 'xero')
    if (!row && grade.status === 'not_connected') return [] // never connected — no card row
    attentionInputs.push({
      cardKey: 'xero', locationId: loc.id, locationName: nameById[loc.id],
      status: grade.status, message: grade.message, partialSetup: false, href,
    })
    return [{
      locationId: loc.id,
      status: grade.status,
      message: grade.message,
      tenantName: row.tenant_name || row.tenant_id,
      tenantType: row.tenant_type || null,
      connectedAt: row.connected_at || null,
      lastRefreshedAt: row.last_refreshed_at || null,
      scopes: Array.isArray(row.scopes) ? row.scopes : (typeof row.scopes === 'string' ? row.scopes.split(' ').filter(Boolean) : []),
      href,
    }]
  })

  // ── Ad accounts — presence only (per /api/settings/ads semantics) ──
  const ads = locs.flatMap((loc) => {
    return adRows.filter((a) => a.location_id === loc.id && a.provider === 'meta').map((a) => {
      const status = a.is_active && a.has_access_token ? 'connected' : 'not_connected'
      const href = locationTabHref(loc.id, 'ads')
      attentionInputs.push({
        cardKey: 'ads', locationId: loc.id, locationName: nameById[loc.id],
        status, message: null, partialSetup: status === 'not_connected', href,
      })
      return {
        locationId: loc.id,
        status,
        externalAccountId: a.external_account_id || null,
        displayName: a.display_name || null,
        href,
      }
    })
  })

  // ── Shelly plugs — per-location connection grade + device counts ──
  //
  // ONE ROW PER IN-SCOPE LOCATION, including locations that never
  // connected (status 'not_connected', zero counts — the card renders
  // "Not connected"). That differs from Xero/Instagram, which omit the
  // absent case, and it is deliberate: the counts are what make a
  // never-connected studio worth showing at all — a location that
  // disconnected with plugs still adopted is a real, quiet half-state
  // (the relays hold wherever they were left and nothing schedules
  // them), and it can only be surfaced by a row that carries both the
  // absent connection and the surviving device count. That is the one
  // not_connected case that nags: partialSetup below.
  //
  // AN UNREADABLE CARD IS 'error', NEVER 'not_connected'. Both reads
  // destructure `error`, and a failure on EITHER grades every in-scope
  // location as unreadable rather than reporting an absence: "not
  // connected" for a live studio is the same lie as "0 plugs" for a
  // studio with twelve, and it is the lie an operator acts on. The
  // devices read counts toward this too — a status read alone would
  // paint a connected card with a device count of zero.
  const shellyReadError = shellyConnRes.error || shellyDevRes.error
  if (shellyReadError) {
    logWarn('integrations-hub', 'shelly read failed — card graded unreadable', {
      error: shellyReadError.message,
      locations: ids.length,
    })
  }
  const shellyConnRows = shellyConnRes.data || []
  const shellyDevRows = shellyDevRes.data || []
  if (shellyDevRows.length >= SHELLY_DEVICE_ROW_CAP) {
    // A full page means there may be devices we cannot see, so the counts
    // below are a floor, not a total. Decorative here (the status does not
    // rest on them), which is why this logs instead of failing the card.
    logWarn('integrations-hub', 'shelly device read hit the row cap — counts may undercount', {
      cap: SHELLY_DEVICE_ROW_CAP,
      locations: ids.length,
    })
  }

  const shelly = locs.map((loc) => {
    const row = shellyConnRows.find((c) => c.location_id === loc.id) || null
    const grade = shellyReadError
      ? { status: 'error', message: 'Could not read Shelly state' }
      : gradeShellyConnection(row)
    const devices = shellyReadError ? [] : shellyDevRows.filter((d) => d.location_id === loc.id)
    const deviceCount = devices.length
    const enabledCount = devices.filter((d) => d.enabled === true).length
    // last_state.online is written as a real boolean by stateFromReading;
    // `=== true` keeps a null/absent state (a device adopted but never
    // read) out of the online tally rather than counting it as up.
    const onlineCount = devices.filter((d) => d.last_state?.online === true).length
    const status = grade.status
    attentionInputs.push({
      cardKey: 'shelly', locationId: loc.id, locationName: nameById[loc.id],
      status, message: grade.message,
      // A disconnect that left plugs behind is worth one quiet nag; a
      // location that simply never had Shelly is not (buildAttention only
      // reads partialSetup on not_connected rows).
      partialSetup: status === 'not_connected' && deviceCount > 0,
      href: SHELLY_HREF,
    })
    return {
      cardKey: 'shelly',
      locationId: loc.id,
      locationName: nameById[loc.id] ?? null,
      status,
      message: grade.message,
      host: row?.host ?? null,
      // Presence derived from the hint, the same argument as
      // publicConnectionView.has_auth_key: the hint is the only evidence of
      // a key this projection HAS, so deriving it from anything else would
      // make the field mean different things per caller.
      hasAuthKey: !!row?.key_hint,
      keyHint: row?.key_hint ?? null,
      lastOkAt: row?.last_ok_at ?? null,
      lastAttemptAt: row?.updated_at ?? null,
      lastError: row?.last_error ?? null,
      deviceCount,
      enabledCount,
      onlineCount,
      href: SHELLY_HREF,
    }
  })

  // ── SMS sender (platform-managed card's live signal) ──
  const sms = locs.map((loc) => {
    const reg = pickRegistry(regRows, loc.id, 'twilio_sender')
    const senderId = reg?.config?.sender_id ?? loc.twilio_alpha_sender_id ?? null
    return {
      locationId: loc.id,
      senderId,
      source: reg ? 'registry' : 'legacy',
      href: locationTabHref(loc.id, 'twilio'),
    }
  })

  // ── AI agent live signal (locations.settings.customer_agent) ──
  const agent = locs.map((loc) => ({
    locationId: loc.id,
    mode: agentSignal(loc.settings?.customer_agent),
    agentName: loc.settings?.customer_agent?.agent_name || null,
  }))

  // ── Hidden tier: UniFi / Climate / BCA from the registry ──
  const unifi = locs.flatMap((loc) => {
    const reg = pickRegistry(regRows, loc.id, 'unifi')
    const legacy = registryRowFromLegacy('unifi', loc)
    if (!reg && !legacy) return []
    const status = reg ? reg.status : 'connected'
    const href = locationTabHref(loc.id, 'unifi')
    const u = plainSlice(loc.settings?.unifi) // non-secret prefill + token presence
    attentionInputs.push({
      cardKey: 'unifi', locationId: loc.id, locationName: nameById[loc.id],
      status, message: reg?.last_error ?? null, partialSetup: false, href,
    })
    return [{
      locationId: loc.id,
      status,
      host: u.host ?? null,
      hasToken: !!u.api_token,
      staffPolicyId: u.staff_policy_id ?? null,
      managerPolicyId: u.manager_policy_id ?? null,
      allowSelfSigned: u.allow_self_signed === true,
      lastOkAt: reg?.last_ok_at ?? null,
      lastError: reg?.last_error ?? null,
      href,
    }]
  })

  const climate = locs.flatMap((loc) => {
    const vendors = []
    const sensiboReg = pickRegistry(regRows, loc.id, 'sensibo')
    const sensiboLegacy = registryRowFromLegacy('sensibo', loc)
    if (sensiboReg || sensiboLegacy) {
      vendors.push({ vendor: 'sensibo', status: sensiboReg ? sensiboReg.status : 'connected', lastError: sensiboReg?.last_error ?? null })
    }
    const thinqReg = pickRegistry(regRows, loc.id, 'thinq')
    const thinqLegacy = registryRowFromLegacy('thinq', loc)
    if (thinqReg || thinqLegacy) {
      vendors.push({ vendor: 'thinq', status: thinqReg ? thinqReg.status : 'connected', lastError: thinqReg?.last_error ?? null })
    }
    if (!vendors.length) return []
    const status = worstStatus(vendors.map((v) => v.status))
    const href = locationTabHref(loc.id, 'ac-devices')
    attentionInputs.push({
      cardKey: 'climate', locationId: loc.id, locationName: nameById[loc.id],
      status, message: vendors.find((v) => v.lastError)?.lastError ?? null, partialSetup: false, href,
    })
    // Non-secret prefill + secret presence for the Phase-2 AC creds drawer
    // (the ac_devices device TABLE stays on the deep-link, not the drawer).
    return [{
      locationId: loc.id,
      status,
      vendors,
      sensibo: { hasKey: !!loc.sensibo_api_key },
      thinq: {
        hasPat: !!loc.thinq_pat,
        clientId: loc.thinq_client_id ?? null,
        countryCode: loc.thinq_country_code ?? null,
      },
      href,
    }]
  })

  const bca = locs.flatMap((loc) => {
    const reg = pickRegistry(regRows, loc.id, 'bca')
    const legacy = registryRowFromLegacy('bca', loc)
    if (!reg && !legacy) return []
    const status = reg ? reg.status : 'connected'
    const href = locationTabHref(loc.id, 'bca')
    const c = plainSlice(loc.bca_config) // bca_config has NO secrets (email + templates)
    attentionInputs.push({
      cardKey: 'bca', locationId: loc.id, locationName: nameById[loc.id],
      status, message: reg?.last_error ?? null, partialSetup: false, href,
    })
    return [{
      locationId: loc.id,
      status,
      sendFrom: c.send_from ?? null,
      sendTo: c.send_to ?? null,
      cc: c.cc ?? null,
      subjectTemplate: c.subject_template ?? null,
      bodyTemplate: c.body_template ?? null,
      documentCount: Array.isArray(c.documents) ? c.documents.length : 0,
      href,
    }]
  })

  // ── Email delivery — per-ORG tenant sending domain (INTEG-B3, mig 427) ──
  // One lookup per distinct org (deduped), not per location. Never selects
  // the Postmark server token. Org set derives from the already-scoped locs.
  const orgIds = [...new Set(locs.map((l) => l.organization_id).filter(Boolean))]
  const email = await assembleEmailDelivery(db, locs, orgIds)

  // ── Plan & wallet strip (INTEG-C4) — pinning-gated, zero writes ──
  const billing = await assembleBillingStrip(db, locs, dublinDayStr(now))

  return {
    generatedAt: now.toISOString(),
    expirySoonDays: EXPIRY_SOON_DAYS,
    locations: locs.map((l) => ({ id: l.id, name: l.name })),
    glofox,
    whatsapp,
    instagram,
    xero,
    ads,
    shelly,
    sms,
    agent,
    email,
    unifi,
    climate,
    bca,
    billing,
    attention: buildAttention(attentionInputs, { now }),
  }
}
