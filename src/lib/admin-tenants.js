// INTEG-D2 — /admin/tenants master console assembly (roster + drill-in).
//
// READ-ONLY composition over machinery that already exists — this
// module builds nothing new at the data layer:
//   plans / plan_versions / location_plans  (mig 413, via the same
//     embed shape as src/lib/plans.js)      → pinned plan + MRR
//   wallets / wallet_transactions           (mig 420)   → balances,
//     top-ups MTD, per-location ledger (reads only; the ONE write in
//     the whole surface is the wallet-adjust route, which goes through
//     applyWalletEntry → the wallet_apply RPC like everything else)
//   usage_rollups_daily / usage_events      (migs 411/421) → MTD meters.
//     ai_message is DERIVED: COUNT of usage_events rows with
//     meter='anthropic_tokens' and source != 'assistant_chat' — the
//     staff assistant is metered but allowance-EXEMPT (Richard
//     2026-07-19) and is surfaced as its own separate line.
//   tenant_cron_health                      (mig 412)   → stale heartbeats
//   assembleIntegrationsHub                 (INTEG-B1/B2) → attention /
//     per-location connection status. REUSED, never re-derived — see
//     summariseHubForLocation below.
//
// Month boundaries are Dublin calendar months (the wallet/usage-caps
// convention). timestamptz MTD filters OVER-FETCH by one day
// (addDaysISO(monthStart, -1)) and are then filtered precisely in JS
// via dublinDayStr() — a plain `gte(col, monthStart)` compares against
// UTC midnight, which is an hour AFTER Dublin midnight under IST and
// would drop the first hour of the month.
//
// Pure helpers up top (unit-tested in admin-tenants.test.js); the two
// async assemblers at the bottom take an injected service client so
// route handlers / RSC pages stay the only places that construct one.
// Ledger and MTD reads .range()-paginate (1k-row cap invariant) even
// though today's N is tiny.

import { dublinTodayStr, dublinDayStr, addDaysISO } from '@/lib/dublin-time'
import { dublinMonthStartStr } from '@/lib/usage-caps'
import { resolveAllowances, pickActiveVersion } from '@/lib/plans'
import { assembleIntegrationsHub } from '@/lib/integrations-hub'
import { METER_KEYS } from '@shared/plans'

// ─────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────

/** Is this location_plans embed row an ACTIVE pinned tier? Pure. */
function isActiveTierPin(row) {
  return Boolean(row?.active && row?.version?.plan?.kind === 'tier')
}

/**
 * Platform MRR in EUR cents: the sum of every ACTIVE pinned tier
 * version's price across all locations. Pinning is to a SPECIFIC
 * version (explicit grandfathering, mig 413), so the pinned version's
 * price — not the latest — is what each location pays. Add-on pins are
 * deliberately excluded from the headline (tier MRR is the roster
 * number; add-ons surface on the drill-in). Pure.
 *
 * @param {Array<{ active?: boolean, version?: { price_cents?: number, plan?: { kind?: string } } }>} pinRows
 * @returns {number} cents
 */
export function sumMrrCents(pinRows) {
  let total = 0
  for (const row of pinRows || []) {
    if (!isActiveTierPin(row)) continue
    const cents = Number(row.version.price_cents)
    if (Number.isFinite(cents) && cents > 0) total += cents
  }
  return total
}

/**
 * Compact plan summary for one org's pin rows: "Growth ×2", or
 * "Growth ×1 · Scale ×1" when locations sit on different tiers, or
 * null when nothing is pinned (today's normal state — render "—").
 * Counts ACTIVE tier pins only. Pure.
 */
export function planSummary(pinRows) {
  const counts = new Map()
  for (const row of pinRows || []) {
    if (!isActiveTierPin(row)) continue
    const name = row.version.plan.name || row.version.plan.slug || 'Plan'
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  if (counts.size === 0) return null
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} ×${n}`)
    .join(' · ')
}

/**
 * Past-due locations: wallets whose balance is below zero (inside the
 * EUR 10 grace floor — mig 420's CHECK keeps it >= -1000 cents). Pure.
 *
 * @param {Array<{ balance_cents?: number }>} wallets
 * @returns {number}
 */
export function pastDueCount(wallets) {
  let n = 0
  for (const w of wallets || []) {
    if (Number(w?.balance_cents) < 0) n += 1
  }
  return n
}

/**
 * Sum of top-up ledger entries posted this Dublin month, in cents.
 * Rows arrive over-fetched by a day (see module header); the precise
 * month test happens here via dublinDayStr(created_at). Pure.
 *
 * @param {Array<{ kind?: string, amount_cents?: number, created_at?: string }>} txRows
 * @param {string} monthStart - 'YYYY-MM-01'
 * @returns {number} cents
 */
export function sumTopupsCents(txRows, monthStart) {
  let total = 0
  for (const t of txRows || []) {
    if (t?.kind !== 'topup' || !t.created_at) continue
    if (dublinDayStr(new Date(t.created_at).getTime()) < monthStart) continue
    const cents = Number(t.amount_cents)
    if (Number.isFinite(cents)) total += cents
  }
  return total
}

function emptyUsage() {
  return { wa_template_send: 0, email_send: 0, ai_message: 0, assistant_chat: 0 }
}

/**
 * Fold MTD usage into per-location and per-org meter totals.
 *
 * - rollupRows (usage_rollups_daily): wa_template_send / email_send
 *   quantities are summed as-is; other meters are ignored.
 * - aiEventRows (usage_events, meter='anthropic_tokens', already
 *   month-filtered by the caller): each row counts 1 ai_message when
 *   its source is allowance-ELIGIBLE, or 1 assistant_chat when
 *   source='assistant_chat' (metered but exempt — shown separately).
 * - locationOrgMap resolves org for rows that carry only a location
 *   (anthropicMessages writes the caller's location; organization_id
 *   can be null on raw events).
 *
 * Pure.
 *
 * @param {{ rollupRows?: Array, aiEventRows?: Array, locationOrgMap?: Record<string,string> }} input
 * @returns {{ byLocation: Record<string, object>, byOrg: Record<string, object> }}
 */
export function aggregateUsage({ rollupRows, aiEventRows, locationOrgMap = {} } = {}) {
  const byLocation = {}
  const byOrg = {}
  const locBucket = (id) => (byLocation[id] ||= emptyUsage())
  const orgBucket = (id) => (byOrg[id] ||= emptyUsage())
  const add = (row, key, qty) => {
    if (row.location_id) locBucket(row.location_id)[key] += qty
    const orgId = row.organization_id || locationOrgMap[row.location_id] || null
    if (orgId) orgBucket(orgId)[key] += qty
  }

  for (const r of rollupRows || []) {
    if (r?.meter !== 'wa_template_send' && r?.meter !== 'email_send') continue
    const qty = Number(r.quantity)
    if (!Number.isFinite(qty) || qty <= 0) continue
    add(r, r.meter, qty)
  }
  for (const e of aiEventRows || []) {
    if (!e) continue
    add(e, e.source === 'assistant_chat' ? 'assistant_chat' : 'ai_message', 1)
  }
  return { byLocation, byOrg }
}

/**
 * Group STALE tenant heartbeats by location. tenant_cron_health (mig
 * 412) already computes is_stale (muted or cadence-less rows never
 * flag); this just filters + groups — muted rows are excluded even if
 * a stale flag ever leaked through alongside muted. Pure.
 *
 * @param {Array<{ name, location_id, is_stale, muted, stale_seconds }>} rows
 * @returns {Record<string, Array<{ name: string, stale_seconds: number|null }>>}
 */
export function staleHeartbeatsByLocation(rows) {
  const out = {}
  for (const r of rows || []) {
    if (!r?.is_stale || r.muted || !r.location_id) continue
    ;(out[r.location_id] ||= []).push({
      name: r.name,
      stale_seconds: r.stale_seconds ?? null,
    })
  }
  return out
}

// The hub payload sections that carry per-location {locationId, status}
// rows, in the order the drill-in lists them.
const HUB_STATUS_SECTIONS = [
  ['glofox', 'Glofox'],
  ['whatsapp', 'WhatsApp'],
  ['instagram', 'Instagram'],
  ['xero', 'Xero'],
  ['ads', 'Meta Ads'],
  ['unifi', 'UniFi'],
  ['climate', 'Climate'],
  ['bca', 'BCA'],
]

/**
 * One location's integrations summary, DERIVED from the assembled hub
 * payload (assembleIntegrationsHub) — never re-graded here. Sections
 * with no row for the location (never configured) are omitted, so a
 * bare location renders an empty list rather than a wall of
 * not_connected. Pure.
 *
 * @param {object|null} hub - assembleIntegrationsHub payload (or null
 *   when hub assembly was skipped/failed — degrades to empty)
 * @param {string} locationId
 * @returns {{ connections: Array<{ key, label, status }>, attention: Array }}
 */
export function summariseHubForLocation(hub, locationId) {
  if (!hub) return { connections: [], attention: [] }
  const connections = []
  for (const [key, label] of HUB_STATUS_SECTIONS) {
    const row = (hub[key] || []).find((r) => r.locationId === locationId)
    if (!row) continue
    connections.push({ key, label, status: row.status })
  }
  return {
    connections,
    attention: (hub.attention || []).filter((a) => a.locationId === locationId),
  }
}

/**
 * The assignable plan catalogue for the tenant drill-in: each ACTIVE
 * plan (tier or add-on) paired with its version active on `today` (its
 * current price). Plans with no effective version yet are dropped — you
 * can't pin a plan that has no price. Tiers and add-ons are split and
 * ordered by the plan `sort` column so the Assign modal renders them in
 * catalogue order. Pure.
 *
 * @param {Array<{ id, slug, name, kind, active, sort, versions?: Array }>} plans
 *   plans rows with an embedded `versions` array (plan_versions)
 * @param {string} today - 'YYYY-MM-DD' Dublin business date
 * @returns {{ tiers: Array, addons: Array }}
 */
export function buildPlanCatalogue(plans, today) {
  const tiers = []
  const addons = []
  for (const plan of plans || []) {
    if (plan?.active === false) continue
    const v = pickActiveVersion(plan.versions || [], today)
    if (!v) continue
    const entry = {
      planId: plan.id,
      slug: plan.slug,
      name: plan.name,
      kind: plan.kind,
      sort: plan.sort ?? 0,
      version: {
        id: v.id,
        priceCents: v.price_cents,
        effectiveFrom: v.effective_from,
        features: v.features || {},
      },
    }
    if (plan.kind === 'tier') tiers.push(entry)
    else if (plan.kind === 'addon') addons.push(entry)
  }
  const bySort = (a, b) => a.sort - b.sort || a.name.localeCompare(b.name)
  tiers.sort(bySort)
  addons.sort(bySort)
  return { tiers, addons }
}

/** Attention-item count per org, via a location→org map. Pure. */
export function attentionCountByOrg(attention, locationOrgMap) {
  const out = {}
  for (const a of attention || []) {
    const orgId = locationOrgMap?.[a.locationId]
    if (!orgId) continue
    out[orgId] = (out[orgId] || 0) + 1
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// Async assemblers — injected service client, batched reads
// ─────────────────────────────────────────────────────────────

// .range()-paginate with an explicit order (the pipeline-reclassify
// pattern) — every unbounded MTD read goes through here.
async function fetchAllPages(makeQuery, label) {
  const PAGE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1)
    if (error) throw new Error(`admin-tenants ${label}: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

const PIN_EMBED =
  'location_id, active, assigned_at, ' +
  'version:plan_versions!plan_version_id(id, price_cents, effective_from, allowances, ' +
  'plan:plans!plan_id(id, name, slug, kind))'

// Full location columns the hub assembler reads (mirrors the
// /api/integrations/hub select — presence-only legacy fields; secrets
// never leave integrations-hub.js).
const LOCATION_COLUMNS =
  'id, name, organization_id, active, created_at, settings, features, ' +
  'sensibo_api_key, sensibo_pod_id, thinq_pat, thinq_client_id, ' +
  'thinq_country_code, twilio_alpha_sender_id, bca_config'

// Hub assembly is decorative on this surface — a hub failure must not
// take down the tenants console (same posture as the WA budget meter
// inside the hub itself).
async function tryAssembleHub(db, locations) {
  try {
    return await assembleIntegrationsHub(db, locations)
  } catch {
    return null
  }
}

/**
 * Roster payload for /admin/tenants: platform stat tiles + one row per
 * organization. Master-only callers — this only reads.
 *
 * @param {object} db - createServerClient()
 * @param {{ today?: string }} [opts] - 'YYYY-MM-DD' Dublin business
 *   today, injectable for tests
 */
export async function getTenantsRoster(db, { today = dublinTodayStr() } = {}) {
  const monthStart = dublinMonthStartStr(today)
  const overFetchFrom = addDaysISO(monthStart, -1)

  const [orgsRes, locsRes, pinsRes, walletsRes] = await Promise.all([
    db.from('organizations').select('id, name, slug, active, created_at').order('name'),
    db.from('locations').select(LOCATION_COLUMNS).eq('is_host_anchor', false).order('created_at'),
    db.from('location_plans').select(PIN_EMBED).eq('active', true),
    db.from('wallets').select('location_id, balance_cents, period_start'),
  ])
  for (const [res, label] of [[orgsRes, 'organizations'], [locsRes, 'locations'], [pinsRes, 'location_plans'], [walletsRes, 'wallets']]) {
    if (res.error) throw new Error(`admin-tenants ${label}: ${res.error.message}`)
  }
  const orgs = orgsRes.data || []
  const locations = locsRes.data || []
  const pins = pinsRes.data || []
  const wallets = walletsRes.data || []

  const locationOrgMap = Object.fromEntries(locations.map((l) => [l.id, l.organization_id]))

  const [topups, rollups, aiEvents, heartbeatsRes, hub] = await Promise.all([
    fetchAllPages(
      () => db.from('wallet_transactions')
        .select('location_id, kind, amount_cents, created_at')
        .eq('kind', 'topup')
        .gte('created_at', overFetchFrom)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true }),
      'wallet_transactions'
    ),
    fetchAllPages(
      () => db.from('usage_rollups_daily')
        .select('organization_id, location_id, meter, quantity')
        .in('meter', ['wa_template_send', 'email_send'])
        .gte('day', monthStart)
        .order('day', { ascending: true })
        .order('location_id', { ascending: true })
        .order('meter', { ascending: true }),
      'usage_rollups_daily'
    ),
    fetchAllPages(
      () => db.from('usage_events')
        .select('id, organization_id, location_id, source, occurred_at')
        .eq('meter', 'anthropic_tokens')
        .gte('occurred_at', overFetchFrom)
        .order('occurred_at', { ascending: true })
        .order('id', { ascending: true }),
      'usage_events'
    ),
    db.from('tenant_cron_health').select('name, location_id, is_stale, stale_seconds, muted'),
    tryAssembleHub(db, locations),
  ])

  const usage = aggregateUsage({
    rollupRows: rollups,
    aiEventRows: aiEvents.filter((e) =>
      e.occurred_at && dublinDayStr(new Date(e.occurred_at).getTime()) >= monthStart
    ),
    locationOrgMap,
  })
  const stale = staleHeartbeatsByLocation(heartbeatsRes.data || [])
  const attentionByOrg = attentionCountByOrg(hub?.attention, locationOrgMap)

  const walletByLocation = Object.fromEntries(wallets.map((w) => [w.location_id, w]))

  const orgRows = orgs.map((org) => {
    const orgLocs = locations.filter((l) => l.organization_id === org.id)
    const orgPins = pins.filter((p) => locationOrgMap[p.location_id] === org.id)
    const orgWallets = orgLocs
      .map((l) => walletByLocation[l.id])
      .filter(Boolean)
    const staleCount = orgLocs.reduce((n, l) => n + (stale[l.id]?.length || 0), 0)
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      active: org.active,
      createdAt: org.created_at,
      locationsCount: orgLocs.length,
      planSummary: planSummary(orgPins),
      // null (render "—") when no location in the org has a wallet row
      // yet — the normal state while everything is unpinned.
      walletBalanceCents: orgWallets.length
        ? orgWallets.reduce((n, w) => n + (Number(w.balance_cents) || 0), 0)
        : null,
      usage: usage.byOrg[org.id] || emptyUsage(),
      health: {
        attentionCount: attentionByOrg[org.id] || 0,
        staleHeartbeatCount: staleCount,
      },
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    monthStart,
    stats: {
      mrrCents: sumMrrCents(pins),
      // Trial machinery is not built yet — the tile renders 0 with a
      // muted "not live" hint until it exists.
      trials: { count: 0, live: false },
      pastDueCount: pastDueCount(wallets),
      topupsMtdCents: sumTopupsCents(topups, monthStart),
    },
    orgs: orgRows,
  }
}

const LEDGER_LIMIT = 50

/**
 * Drill-in payload for /admin/tenants/[orgId]: org header + one block
 * per location (pinned plan, wallet + last-50 ledger, MTD meters vs
 * allowance + exempt assistant line, integrations summary, stale
 * heartbeats). Returns null when the org doesn't exist (callers 404).
 *
 * @param {object} db - createServerClient()
 * @param {string} orgId
 * @param {{ today?: string }} [opts]
 */
export async function getTenantDetail(db, orgId, { today = dublinTodayStr() } = {}) {
  const { data: org, error: orgErr } = await db
    .from('organizations')
    .select('id, name, slug, active, created_at')
    .eq('id', orgId)
    .maybeSingle()
  if (orgErr) throw new Error(`admin-tenants organization: ${orgErr.message}`)
  if (!org) return null

  const monthStart = dublinMonthStartStr(today)
  const overFetchFrom = addDaysISO(monthStart, -1)

  const { data: locsData, error: locsErr } = await db
    .from('locations')
    .select(LOCATION_COLUMNS)
    .eq('organization_id', orgId)
    .eq('is_host_anchor', false)
    .order('created_at')
  if (locsErr) throw new Error(`admin-tenants locations: ${locsErr.message}`)
  const locations = locsData || []
  const locIds = locations.map((l) => l.id)
  const locationOrgMap = Object.fromEntries(locations.map((l) => [l.id, l.organization_id]))

  const [pinsRes, walletsRes, heartbeatsRes, rollups, aiEvents, hub, ledgers, catalogueRes] = await Promise.all([
    db.from('location_plans').select(PIN_EMBED).eq('active', true).in('location_id', locIds),
    db.from('wallets').select('location_id, balance_cents, period_start, updated_at').in('location_id', locIds),
    db.from('tenant_cron_health').select('name, location_id, is_stale, stale_seconds, muted').in('location_id', locIds),
    fetchAllPages(
      () => db.from('usage_rollups_daily')
        .select('organization_id, location_id, meter, quantity')
        .in('meter', ['wa_template_send', 'email_send'])
        .in('location_id', locIds)
        .gte('day', monthStart)
        .order('day', { ascending: true })
        .order('location_id', { ascending: true })
        .order('meter', { ascending: true }),
      'usage_rollups_daily'
    ),
    fetchAllPages(
      () => db.from('usage_events')
        .select('id, organization_id, location_id, source, occurred_at')
        .eq('meter', 'anthropic_tokens')
        .in('location_id', locIds)
        .gte('occurred_at', overFetchFrom)
        .order('occurred_at', { ascending: true })
        .order('id', { ascending: true }),
      'usage_events'
    ),
    tryAssembleHub(db, locations),
    // Last N ledger entries PER LOCATION — one bounded query each
    // (locations per org are few; a single .in() query can't cap
    // per-location without a lateral join).
    Promise.all(locIds.map(async (id) => {
      const { data, error } = await db
        .from('wallet_transactions')
        .select('id, kind, amount_cents, meter, qty, unit_rate_cents, balance_after_cents, invoice_ref, note, created_at, created_by, period')
        .eq('location_id', id)
        .order('created_at', { ascending: false })
        .limit(LEDGER_LIMIT)
      if (error) throw new Error(`admin-tenants ledger: ${error.message}`)
      return [id, data || []]
    })),
    // Assignable catalogue — active plans with their version history so
    // the drill-in's Assign/Change control can offer tiers + add-ons at
    // their current price. Master-read table; the plan catalogue is tiny.
    db.from('plans')
      .select('id, slug, name, kind, active, sort, versions:plan_versions!plan_id(id, price_cents, effective_from, features)')
      .eq('active', true)
      .order('sort', { ascending: true }),
  ])
  if (pinsRes.error) throw new Error(`admin-tenants location_plans: ${pinsRes.error.message}`)
  if (walletsRes.error) throw new Error(`admin-tenants wallets: ${walletsRes.error.message}`)
  if (heartbeatsRes.error) throw new Error(`admin-tenants tenant_cron_health: ${heartbeatsRes.error.message}`)
  if (catalogueRes.error) throw new Error(`admin-tenants plans catalogue: ${catalogueRes.error.message}`)

  const pins = pinsRes.data || []
  const walletByLocation = Object.fromEntries((walletsRes.data || []).map((w) => [w.location_id, w]))
  const ledgerByLocation = Object.fromEntries(ledgers)
  const usage = aggregateUsage({
    rollupRows: rollups,
    aiEventRows: aiEvents.filter((e) =>
      e.occurred_at && dublinDayStr(new Date(e.occurred_at).getTime()) >= monthStart
    ),
    locationOrgMap,
  })
  const stale = staleHeartbeatsByLocation(heartbeatsRes.data || [])

  const locationBlocks = locations.map((loc) => {
    const locPins = pins.filter((p) => p.location_id === loc.id && p.active && p.version?.plan)
    const tierPin = locPins.find((p) => p.version.plan.kind === 'tier') || null
    const addonPins = locPins.filter((p) => p.version.plan.kind === 'addon')
    const resolved = tierPin
      ? resolveAllowances(tierPin.version, addonPins.map((p) => p.version))
      : null
    const wallet = walletByLocation[loc.id] || null
    return {
      id: loc.id,
      name: loc.name,
      active: loc.active,
      createdAt: loc.created_at,
      plan: tierPin
        ? {
            planId: tierPin.version.plan.id,
            planVersionId: tierPin.version.id,
            name: tierPin.version.plan.name,
            slug: tierPin.version.plan.slug,
            priceCents: tierPin.version.price_cents,
            effectiveFrom: tierPin.version.effective_from,
            assignedAt: tierPin.assigned_at,
            addons: addonPins.map((p) => ({
              planId: p.version.plan.id,
              planVersionId: p.version.id,
              name: p.version.plan.name,
              slug: p.version.plan.slug,
              priceCents: p.version.price_cents,
            })),
          }
        : null,
      // Active add-on pins independent of the tier — the UI's add-on
      // toggles reflect these even when the location is dormant (no tier).
      addons: addonPins.map((p) => ({
        planId: p.version.plan.id,
        planVersionId: p.version.id,
        name: p.version.plan.name,
        slug: p.version.plan.slug,
        priceCents: p.version.price_cents,
      })),
      allowances: resolved ? resolved.allowances : null,
      wallet: wallet
        ? {
            balanceCents: wallet.balance_cents,
            periodStart: wallet.period_start,
            updatedAt: wallet.updated_at,
          }
        : null,
      ledger: ledgerByLocation[loc.id] || [],
      usage: usage.byLocation[loc.id] || emptyUsage(),
      integrations: summariseHubForLocation(hub, loc.id),
      staleHeartbeats: stale[loc.id] || [],
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    monthStart,
    meterKeys: [...METER_KEYS],
    org: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      active: org.active,
      createdAt: org.created_at,
      locationsCount: locations.length,
    },
    catalogue: buildPlanCatalogue(catalogueRes.data || [], today),
    locations: locationBlocks,
  }
}
