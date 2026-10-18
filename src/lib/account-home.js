// REPSET-ACCOUNT.1 — Account Home (org portfolio) roll-up assembler.
//
// The Repset platform has three tiers:
//   Platform (master, cross-tenant) / Account (a gym company = an
//   `organization`) / Studio (a `location`).
// This module powers the ACCOUNT tier: an org-level home that rolls
// up headline KPIs across that org's studios, then drills into one.
//
// READ-ONLY. No writes, no migration — this aggregates data that
// already exists. Every studio metric is a COUNT / aggregate query
// (or a single-row snapshot read), NEVER a row fetch, so the 1,000-
// row select cap (CLAUDE.md invariant) is never in play.
//
// KPI provenance (real data used, and why):
//   - members      → contacts head-count where glofox_membership_status
//                    ∈ (member, credit_member). Same cohort the
//                    membership snapshot + business dashboard count as
//                    "members". Head-only exact count (no rows moved).
//   - bookings7d   → bookings head-count in the trailing 7-day window of
//                    the STUDIO's calendar, excluding cancelled. booking_date
//                    is the studio's wall clock (CLAUDE.md), so each studio's
//                    window is its own (TZ.11a: locations.timezone), never
//                    one shared day for the whole org.
//   - atRiskHigh   → latest churn_radar_snapshots.high_risk per location
//                    (mig 198). Cheap (LIMIT 1) — the live radar recompute
//                    is a heavy per-member scan, so the weekly snapshot is
//                    the closest cheaply-available at-risk metric.
//   - wallet       → OMITTED. There is no org-level wallet/balance table
//                    in this repo (the only `wallet` token in the codebase
//                    is a Glofox transaction-type filter), so there is no
//                    cheap real metric to surface. Left out rather than
//                    faked; wire it in a later phase if an org wallet lands.
//
// Per-studio attention signal:
//   - openApprovals → a cheap, per-location head-count of the two
//                     location-scoped approval queues (pending time-off +
//                     pre-terminal invoices_queue). The full approvals
//                     REGISTRY (src/lib/approvals/registry.js) is bound to
//                     the viewer's ACTIVE location and resolves per-location
//                     permissions against it, so it can't be cheaply or
//                     correctly re-run per studio — hence a direct
//                     representative head-count here instead.
//   - membershipSource → the studio's membership-source STATE from the seam
//                     (src/lib/membership/source.js, W1.M2): none |
//                     configured | unconfigured | unknown. It replaced
//                     `Boolean(settings.glofox)`, which read CCF Autos'
//                     empty slice as "connected". A failed read is
//                     'unknown' on the card, never "no integration".

import { resolveAdminOrgId } from '@/lib/org-admin'
import { todayStrIn, addDaysISO, zoneOfLocation, DEFAULT_TZ } from '@/lib/location-time'
import { membershipSourceState } from '@/lib/membership/source'
import { READS_BY_SOURCE } from '@/lib/membership/reads/registry'
import { logWarn } from '@/lib/log'

// Glofox statuses that count as an active member (same cohort as
// membership-snapshot.js).
export const MEMBER_STATUSES = Object.freeze(['member', 'credit_member'])

// invoices_queue rows still awaiting a human (mirrors the
// invoices-queue approvals provider's pre-terminal set).
const PENDING_INVOICE_STATUSES = Object.freeze([
  'received', 'quality_approved', 'extracted', 'data_approved',
])

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested — no DB, no clock beyond an injectable `now`).
// ---------------------------------------------------------------------------

/**
 * Trailing 7-day window (inclusive) as calendar dates in `zone` (the
 * studio's). `bookings.booking_date` is the studio's wall-clock DATE, so
 * the window bounds are its calendar days — derived from the zone so a
 * US-timezone server (or a DST edge) can't shift them.
 *
 * @param {Date|number} [now=Date.now()]
 * @param {string} [zone] canonical IANA zone (DEFAULT_TZ when omitted)
 * @returns {{ start: string, end: string }} YYYY-MM-DD bounds, inclusive.
 */
export function studioWeekWindow(now = Date.now(), zone = DEFAULT_TZ) {
  const end = todayStrIn(zone, now instanceof Date ? now.getTime() : now) // today, local
  const start = addDaysISO(end, -6)      // 6 days earlier → 7-day inclusive span
  return { start, end }
}

/**
 * Sum the per-studio headline numbers into org-level KPIs. Pure.
 *
 * @param {Array<{members?:number, bookings7d?:number, atRiskHigh?:number}>} studios
 * @returns {{ members:number, bookings7d:number, atRiskHigh:number, studioCount:number }}
 */
export function aggregateOrgKpis(studios) {
  const list = Array.isArray(studios) ? studios : []
  return {
    members: list.reduce((s, x) => s + (x?.members || 0), 0),
    bookings7d: list.reduce((s, x) => s + (x?.bookings7d || 0), 0),
    atRiskHigh: list.reduce((s, x) => s + (x?.atRiskHigh || 0), 0),
    studioCount: list.length,
  }
}

/**
 * Reduce a studio's raw signals into a single attention pill.
 * Priority: pending approvals (an action the operator owns) outrank
 * an at-risk count (a watch item). "All clear" when neither fires.
 * Pure — the tone maps to a chip class in the component, not here.
 *
 * @param {{ openApprovals?:number, atRiskHigh?:number }} signals
 * @returns {{ tone:'purple'|'amber'|'teal', label:string, needsAttention:boolean }}
 */
export function rollupAttention({ openApprovals = 0, atRiskHigh = 0 } = {}) {
  if (openApprovals > 0) {
    return {
      tone: 'purple',
      label: `${openApprovals} to review`,
      needsAttention: true,
    }
  }
  if (atRiskHigh > 0) {
    return {
      tone: 'amber',
      label: `${atRiskHigh} at risk`,
      needsAttention: true,
    }
  }
  return { tone: 'teal', label: 'All clear', needsAttention: false }
}

/**
 * Resolve which organization the caller may view the Account Home for,
 * replicating the org-membership RLS model in app code (service-role
 * routes bypass RLS — CLAUDE.md). Pure: no DB.
 *
 * C141 ORGROLE.2 (C18's rule, Richard 1 Oct): the Account Home is an
 * organisation-level surface, so it is for ORGANISATION ADMINS only — a
 * master or an org_admin grant (resolveAdminOrgId, src/lib/org-admin.js).
 * An owner at one studio (or at every studio) is not an organisation admin.
 *
 * Behaviour:
 *   - no user                         → { ok:false, status:401 }
 *   - master                          → any org (requested, else active);
 *                                       nothing to target → 404
 *   - requests an org they are not an
 *     admin of (or unknown)            → { ok:false, status:404 }   (not 403 —
 *                                       don't reveal another org exists)
 *   - org admin, requests/defaults to
 *     an org they administer           → { ok:true, orgId }
 *   - not an admin of the org they are
 *     working in (owner / manager /
 *     head_coach / staff)              → { ok:false, status:403 }
 *
 * @param {object|null} user            getCurrentUser() result
 * @param {string|null|undefined} requestedOrgId  ?organization_id
 * @returns {{ ok:true, orgId:string, isMaster:boolean } | { ok:false, status:number }}
 */
export function resolveAccountScope(user, requestedOrgId) {
  if (!user) return { ok: false, status: 401 }

  // profileRole is the account-home's historical third spelling of master;
  // resolveAdminOrgId keys a master off isMaster/role, so a master is
  // answered here first (same rule: requested org, else the active one).
  const isMaster = Boolean(user.isMaster || user.profileRole === 'master' || user.role === 'master')
  if (isMaster) {
    const orgId = requestedOrgId || user.activeOrganization?.id || null
    if (!orgId) return { ok: false, status: 404 }
    return { ok: true, orgId, isMaster: true }
  }
  const resolved = resolveAdminOrgId(user, requestedOrgId || null)
  if (resolved.notFound) return { ok: false, status: 404 }
  if (!resolved.orgId) return { ok: false, status: 403 }
  return { ok: true, orgId: resolved.orgId, isMaster: false }
}

// ---------------------------------------------------------------------------
// DB-touching assembler. Every query is head-only count or a single-row
// snapshot read; per-studio work is isolated in its own try/catch so one
// bad studio can't blank the whole portfolio.
// ---------------------------------------------------------------------------

// UN1TRADAR.3 — Glofox keeps the contacts head-count (Stillorgan's number
// does not move); any other source whose read seam counts members reports its
// total_members (a failed read is 0, as a failed count is). A narrowing of
// spec B §5's "one line": the head-count would read Hatch's Stillorgan-shaped
// glofox_* columns.
async function countMembers(db, locationId, source) {
  const counts = source && source !== 'glofox' ? READS_BY_SOURCE[source]?.membershipCounts : null
  if (typeof counts === 'function') {
    try {
      return Number((await counts(db, locationId))?.total_members) || 0
    } catch (err) {
      logWarn('account-home', 'member count read failed', { locationId, source, code: err?.code ?? null })
      return 0
    }
  }
  const { count } = await db
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .in('glofox_membership_status', MEMBER_STATUSES)
  return count || 0
}

async function countBookings7d(db, locationId, window) {
  const { count } = await db
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .gte('booking_date', window.start)
    .lte('booking_date', window.end)
    .neq('status', 'cancelled')
  return count || 0
}

async function latestAtRiskHigh(db, locationId) {
  const { data } = await db
    .from('churn_radar_snapshots')
    .select('high_risk, captured_at')
    .eq('location_id', locationId)
    .order('captured_at', { ascending: false })
    .limit(1)
  return data?.[0]?.high_risk || 0
}

async function countOpenApprovals(db, locationId, todayStr) {
  const [timeOff, invoices] = await Promise.all([
    db.from('time_off_requests')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('status', 'pending')
      // LEAVE.2 — a pending request past its end_date has expired (derived).
      .gte('end_date', todayStr),
    db.from('invoices_queue')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .in('status', PENDING_INVOICE_STATUSES),
  ])
  return (timeOff.count || 0) + (invoices.count || 0)
}

/**
 * Compute the per-studio breakdown for one location. All-counts, all
 * failure-isolated: any query error degrades that studio's numbers to
 * zero rather than failing the portfolio.
 */
async function assembleStudio(db, location, now) {
  // TZ.11a — the studio's own calendar: its 7-day window and its today.
  const zone = zoneOfLocation(location)
  const window = studioWeekWindow(now, zone)
  const base = {
    id: location.id,
    name: location.name,
    slug: location.slug || null,
  }
  // W1.M2 — resolved by the seam (never throws: a failed read is state
  // 'unknown'), outside the counts' try so a failing count cannot blank it.
  const membershipSource = await membershipSourceState(db, location.id)
  try {
    const [members, bookings7d, atRiskHigh, openApprovals] = await Promise.all([
      countMembers(db, location.id, membershipSource?.source),
      countBookings7d(db, location.id, window),
      latestAtRiskHigh(db, location.id),
      countOpenApprovals(db, location.id, window.end),
    ])
    return {
      ...base,
      membershipSource,
      members,
      bookings7d,
      atRiskHigh,
      openApprovals,
      attention: rollupAttention({ openApprovals, atRiskHigh }),
    }
  } catch {
    return {
      ...base,
      membershipSource,
      members: 0,
      bookings7d: 0,
      atRiskHigh: 0,
      openApprovals: 0,
      attention: rollupAttention({ openApprovals: 0, atRiskHigh: 0 }),
    }
  }
}

/**
 * Fetch the active studios belonging to an organization. The caller is
 * responsible for having already authorised `orgId` via
 * resolveAccountScope — this only ever reads within the given org, so
 * it cannot leak another tenant's locations.
 *
 * @returns {Promise<Array<{id,name,slug,organization_id,membership_source,timezone}>>}
 */
export async function fetchOrgLocations(db, orgId) {
  const { data } = await db
    .from('locations')
    .select('id, name, slug, organization_id, membership_source, timezone')
    .eq('organization_id', orgId)
    .eq('active', true)
    .order('name', { ascending: true })
  return data || []
}

/**
 * Assemble the full Account Home payload for one org.
 *
 * @param {object} db                       service-role Supabase client
 * @param {object} args
 * @param {{id:string,name:string,slug?:string}} args.organization
 * @param {Array<{id,name,slug}>} args.locations  the org's studios
 * @param {Date|number} [args.now]          injectable clock (tests)
 * @returns {Promise<{organization, kpis, studios}>}
 */
export async function assembleAccountHome(db, { organization, locations, now = Date.now() }) {
  const studios = await Promise.all(
    (locations || []).map((loc) => assembleStudio(db, loc, now))
  )
  // The org-level label: the first studio's window (an organisation's
  // studios normally share a zone; each studio counted its own).
  const window = studioWeekWindow(now, zoneOfLocation((locations || [])[0]))
  const kpis = { ...aggregateOrgKpis(studios), weekWindow: window }
  return {
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug || null,
    },
    kpis,
    studios,
  }
}
