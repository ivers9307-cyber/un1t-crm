// Plan assignment — POST/DELETE /api/admin/tenants/[orgId]/plans. The
// write path that turns billing ON for a location (pins a tier/add-on to
// location_plans, mig 413). Auth is mocked at getCurrentUser (the route's
// own master gate is under test); the DB is the filter-AWARE makeFakeDb
// double so the one-active-tier deactivate really mutates rows and a
// forgotten filter fails loudly. getActivePlanVersion runs for real
// against the fake catalogue.
//
// The load-bearing assertion: after assigning a SECOND tier, exactly one
// active tier pin remains (the new one) — the invariant getLocationPlan/
// MRR depend on.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

let tables
let db
let currentUser

vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => currentUser) }))

import { POST, DELETE } from './route.js'

const ORG_ID = 'a0000000-0000-0000-0000-0000000000a1'
const OTHER_ORG = 'a0000000-0000-0000-0000-0000000000a2'
const LOC_ID = 'b0000000-0000-0000-0000-0000000000b1'
const OTHER_LOC = 'b0000000-0000-0000-0000-0000000000b2'
const MISSING_LOC = 'b0000000-0000-0000-0000-0000000000bf'

const CORE = 'c0000000-0000-0000-0000-0000000000c1'
const GROWTH = 'c0000000-0000-0000-0000-0000000000c2'
const SCALE = 'c0000000-0000-0000-0000-0000000000c3'
const RETIRED = 'c0000000-0000-0000-0000-0000000000c4'
const ADDON = 'c0000000-0000-0000-0000-0000000000ca'
const LEGACY = 'c0000000-0000-0000-0000-0000000000c5'
const PARTIAL = 'c0000000-0000-0000-0000-0000000000c6'
const BOGUS_PLAN = 'c0000000-0000-0000-0000-0000000000cf'

const CORE_V = 'd0000000-0000-0000-0000-0000000000d1'
const GROWTH_V = 'd0000000-0000-0000-0000-0000000000d2'
const SCALE_V = 'd0000000-0000-0000-0000-0000000000d3'
const RETIRED_V = 'd0000000-0000-0000-0000-0000000000d4'
const ADDON_V = 'd0000000-0000-0000-0000-0000000000da'
const LEGACY_V = 'd0000000-0000-0000-0000-0000000000d5'
const PARTIAL_V = 'd0000000-0000-0000-0000-0000000000d6'

const TIER_VERSIONS = new Set([CORE_V, GROWTH_V, SCALE_V, RETIRED_V, LEGACY_V, PARTIAL_V])

// TENANT.6 review rider — 3 of the 8 bundle keys present, 5 absent. Guard
// passes (some bundle keys present, not the all-8-absent LEGACY shape);
// the 3 present ones are the ONLY ones the pinned plan grants. This exact
// 3-key combination is mirrored in src/lib/plans.test.js's
// applyPlanBundlesToLocation suite (the "PARTIAL bundle set" test) so the
// guard-passes half (here) and the mirror-writes-false-for-the-rest half
// (there — this fake db doesn't model getLocationPlan's embedded select)
// are provably about the same scenario.
const PARTIAL_FEATURES = Object.freeze({
  bundle_money: true,
  bundle_team: true,
  module_cars: true,
  // bundle_messaging / bundle_sales / bundle_members / bundle_marketing /
  // bundle_operations deliberately absent — withheld, same as explicit
  // false.
})

const MASTER = { id: 'u-master', profileRole: 'master' }
const OWNER = { id: 'u-owner', profileRole: 'owner' }

// TENANT.6 — every regular fixture version below is "backfilled" (mig
// 548: all 8 bundle_*/module_cars keys present) so the pre-existing
// tests in this file stay unaffected by the pin-route bundle guard.
// LEGACY_V deliberately has NO bundle keys — it's the pre-BUNDLES.5
// shape the guard exists to catch.
const BACKFILLED_FEATURES = Object.freeze({
  bundle_messaging: true,
  bundle_sales: true,
  bundle_members: true,
  bundle_money: true,
  bundle_marketing: true,
  bundle_team: true,
  bundle_operations: true,
  module_cars: true,
})

function fixture() {
  return {
    locations: [
      { id: LOC_ID, name: 'Stillorgan', organization_id: ORG_ID },
      { id: OTHER_LOC, name: 'Foreign', organization_id: OTHER_ORG },
    ],
    plans: [
      { id: CORE, slug: 'core', name: 'Core', kind: 'tier', active: true },
      { id: GROWTH, slug: 'growth', name: 'Growth', kind: 'tier', active: true },
      { id: SCALE, slug: 'scale', name: 'Scale', kind: 'tier', active: true },
      { id: RETIRED, slug: 'retired', name: 'Retired', kind: 'tier', active: false },
      { id: ADDON, slug: 'custom_email_domain', name: 'Custom email domain', kind: 'addon', active: true },
      { id: LEGACY, slug: 'legacy', name: 'Legacy (pre-bundle)', kind: 'tier', active: true },
      { id: PARTIAL, slug: 'partial', name: 'Partial (3-of-8 bundles)', kind: 'tier', active: true },
    ],
    plan_versions: [
      { id: CORE_V, plan_id: CORE, effective_from: '2026-07-01', price_cents: 9900, features: { ...BACKFILLED_FEATURES } },
      { id: GROWTH_V, plan_id: GROWTH, effective_from: '2026-07-01', price_cents: 17900, features: { ...BACKFILLED_FEATURES } },
      { id: SCALE_V, plan_id: SCALE, effective_from: '2026-07-01', price_cents: 29900, features: { ...BACKFILLED_FEATURES } },
      { id: RETIRED_V, plan_id: RETIRED, effective_from: '2026-07-01', price_cents: 4900, features: { ...BACKFILLED_FEATURES } },
      { id: ADDON_V, plan_id: ADDON, effective_from: '2026-07-01', price_cents: 1500, features: { ...BACKFILLED_FEATURES } },
      { id: LEGACY_V, plan_id: LEGACY, effective_from: '2026-01-01', price_cents: 5900, features: {} },
      { id: PARTIAL_V, plan_id: PARTIAL, effective_from: '2026-07-15', price_cents: 12900, features: { ...PARTIAL_FEATURES } },
    ],
    location_plans: [],
  }
}

const props = (orgId) => ({ params: Promise.resolve({ orgId }) })
const postReq = (body) =>
  new Request(`http://localhost/api/admin/tenants/x/plans`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
const delReq = (body) =>
  new Request(`http://localhost/api/admin/tenants/x/plans`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

const assign = (orgId, body) => POST(postReq(body), props(orgId))
const unassign = (orgId, body) => DELETE(delReq(body), props(orgId))

// The rows that matter to the invariant.
const activeTierPins = (locId) =>
  tables.location_plans.filter((r) => r.location_id === locId && r.active && TIER_VERSIONS.has(r.plan_version_id))
const activeAddonPins = (locId) =>
  tables.location_plans.filter((r) => r.location_id === locId && r.active && !TIER_VERSIONS.has(r.plan_version_id))

beforeEach(() => {
  tables = fixture()
  db = makeFakeDb(tables)
  currentUser = MASTER
})

describe('auth matrix (401 / 403)', () => {
  it.each([
    ['POST', () => assign(ORG_ID, { location_id: LOC_ID, plan_id: CORE, kind: 'tier' })],
    ['DELETE', () => unassign(ORG_ID, { location_id: LOC_ID, plan_version_id: CORE_V })],
  ])('%s → 401 with no session, 403 for a non-master', async (_n, call) => {
    currentUser = null
    expect((await call()).status).toBe(401)
    currentUser = OWNER
    expect((await call()).status).toBe(403)
    // Never wrote anything on a rejected call.
    expect(tables.location_plans).toHaveLength(0)
  })
})

describe('validation & scoping', () => {
  it('404s a malformed orgId', async () => {
    const res = await assign('not-a-uuid', { location_id: LOC_ID, plan_id: CORE, kind: 'tier' })
    expect(res.status).toBe(404)
  })

  it('404s a location in ANOTHER org (cross-org: 404 not 403, no enumeration)', async () => {
    const res = await assign(ORG_ID, { location_id: OTHER_LOC, plan_id: CORE, kind: 'tier' })
    expect(res.status).toBe(404)
    expect(activeTierPins(OTHER_LOC)).toHaveLength(0)
  })

  it('404s an unknown location', async () => {
    const res = await assign(ORG_ID, { location_id: MISSING_LOC, plan_id: CORE, kind: 'tier' })
    expect(res.status).toBe(404)
  })

  it('404s an unknown plan', async () => {
    const res = await assign(ORG_ID, { location_id: LOC_ID, plan_id: BOGUS_PLAN, kind: 'tier' })
    expect(res.status).toBe(404)
  })

  it('400s an INACTIVE plan (a retired plan cannot be assigned)', async () => {
    const res = await assign(ORG_ID, { location_id: LOC_ID, plan_id: RETIRED, kind: 'tier' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not active/i)
    expect(activeTierPins(LOC_ID)).toHaveLength(0)
  })

  it('400s a kind mismatch (tier plan requested as an add-on)', async () => {
    const res = await assign(ORG_ID, { location_id: LOC_ID, plan_id: CORE, kind: 'addon' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/is a tier, not a addon/i)
  })

  it('400s a version that belongs to a DIFFERENT plan', async () => {
    const res = await assign(ORG_ID, { location_id: LOC_ID, plan_id: CORE, plan_version_id: GROWTH_V, kind: 'tier' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/does not belong/i)
  })

  it('400s when neither plan_id nor plan_slug is provided', async () => {
    const res = await assign(ORG_ID, { location_id: LOC_ID, kind: 'tier' })
    expect(res.status).toBe(400)
  })
})

describe('tier assignment + the one-active-tier invariant', () => {
  it('defaults to the plan CURRENT active version when none is given', async () => {
    const res = await assign(ORG_ID, { location_id: LOC_ID, plan_slug: 'core', kind: 'tier' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.version.id).toBe(CORE_V)
    const pins = activeTierPins(LOC_ID)
    expect(pins).toHaveLength(1)
    expect(pins[0].plan_version_id).toBe(CORE_V)
    expect(pins[0].assigned_by).toBe(MASTER.id)
  })

  it('assigning a SECOND tier deactivates the first — EXACTLY ONE active tier remains', async () => {
    let res = await assign(ORG_ID, { location_id: LOC_ID, plan_id: CORE, kind: 'tier' })
    expect(res.status).toBe(200)
    expect(activeTierPins(LOC_ID).map((r) => r.plan_version_id)).toEqual([CORE_V])

    res = await assign(ORG_ID, { location_id: LOC_ID, plan_id: GROWTH, kind: 'tier' })
    expect(res.status).toBe(200)

    const active = activeTierPins(LOC_ID)
    expect(active).toHaveLength(1)              // ← the load-bearing assertion
    expect(active[0].plan_version_id).toBe(GROWTH_V)
    // The Core pin survives as history but is deactivated.
    const core = tables.location_plans.find((r) => r.plan_version_id === CORE_V)
    expect(core.active).toBe(false)
  })

  it('a THIRD tier still leaves exactly one active tier', async () => {
    await assign(ORG_ID, { location_id: LOC_ID, plan_id: CORE, kind: 'tier' })
    await assign(ORG_ID, { location_id: LOC_ID, plan_id: GROWTH, kind: 'tier' })
    await assign(ORG_ID, { location_id: LOC_ID, plan_id: SCALE, kind: 'tier' })
    const active = activeTierPins(LOC_ID)
    expect(active).toHaveLength(1)
    expect(active[0].plan_version_id).toBe(SCALE_V)
  })

  it('leaves OTHER locations completely unaffected', async () => {
    // Seed OTHER_LOC (its own org) with a Core tier directly.
    tables.location_plans.push({ location_id: OTHER_LOC, plan_version_id: CORE_V, active: true, assigned_by: 'seed' })
    await assign(ORG_ID, { location_id: LOC_ID, plan_id: GROWTH, kind: 'tier' })
    expect(activeTierPins(OTHER_LOC).map((r) => r.plan_version_id)).toEqual([CORE_V])
  })
})

describe('add-on additivity + idempotency', () => {
  it('an add-on is additive — it does NOT deactivate the tier', async () => {
    await assign(ORG_ID, { location_id: LOC_ID, plan_id: CORE, kind: 'tier' })
    const res = await assign(ORG_ID, { location_id: LOC_ID, plan_id: ADDON, kind: 'addon' })
    expect(res.status).toBe(200)
    expect(activeTierPins(LOC_ID)).toHaveLength(1)
    expect(activeAddonPins(LOC_ID)).toHaveLength(1)
  })

  it('assigning the same add-on twice is idempotent (one active add-on row)', async () => {
    await assign(ORG_ID, { location_id: LOC_ID, plan_id: ADDON, kind: 'addon' })
    await assign(ORG_ID, { location_id: LOC_ID, plan_id: ADDON, kind: 'addon' })
    const rows = tables.location_plans.filter((r) => r.plan_version_id === ADDON_V)
    expect(rows).toHaveLength(1)
    expect(activeAddonPins(LOC_ID)).toHaveLength(1)
  })
})

describe('unassign → dormant', () => {
  it('unassigning the tier deactivates it — no active tier remains (dormant)', async () => {
    await assign(ORG_ID, { location_id: LOC_ID, plan_id: CORE, kind: 'tier' })
    const res = await unassign(ORG_ID, { location_id: LOC_ID, plan_version_id: CORE_V })
    expect(res.status).toBe(200)
    expect((await res.json()).data.active).toBe(false)
    expect(activeTierPins(LOC_ID)).toHaveLength(0)
  })

  it('unassigning an add-on leaves the tier active', async () => {
    await assign(ORG_ID, { location_id: LOC_ID, plan_id: CORE, kind: 'tier' })
    await assign(ORG_ID, { location_id: LOC_ID, plan_id: ADDON, kind: 'addon' })
    await unassign(ORG_ID, { location_id: LOC_ID, plan_version_id: ADDON_V })
    expect(activeTierPins(LOC_ID)).toHaveLength(1)
    expect(activeAddonPins(LOC_ID)).toHaveLength(0)
  })

  it('404s unassigning a pin the location never had', async () => {
    const res = await unassign(ORG_ID, { location_id: LOC_ID, plan_version_id: SCALE_V })
    expect(res.status).toBe(404)
  })

  it('404s unassigning against a cross-org location', async () => {
    const res = await unassign(ORG_ID, { location_id: OTHER_LOC, plan_version_id: CORE_V })
    expect(res.status).toBe(404)
  })
})

// TENANT.6 — a plan version with ZERO of the 8 bundle_*/module_cars keys
// predates BUNDLES.5. Pinning it would silently deny every bundle at the
// location (applyPlanBundlesToLocation treats "absent" as "withheld") even
// though the plan was sold as everything-on — mig 548 backfills the keys,
// but this guard makes the footgun unreachable even if that migration
// hasn't run yet.
describe('pre-bundle plan version guard', () => {
  it('refuses to pin a version with none of the 8 bundle keys', async () => {
    const res = await assign(ORG_ID, { location_id: LOC_ID, plan_id: LEGACY, kind: 'tier' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/predates bundle/i)
    expect(body.error).toMatch(/548_plan_versions_bundle_backfill/)
    // Refused — nothing written.
    expect(activeTierPins(LOC_ID)).toHaveLength(0)
  })

  it('force: true overrides the refusal and pins anyway', async () => {
    const res = await assign(ORG_ID, { location_id: LOC_ID, plan_id: LEGACY, kind: 'tier', force: true })
    expect(res.status).toBe(200)
    const active = activeTierPins(LOC_ID)
    expect(active).toHaveLength(1)
    expect(active[0].plan_version_id).toBe(LEGACY_V)
  })

  it('a backfilled version (has all 8 bundle keys) pins normally, no force needed', async () => {
    const res = await assign(ORG_ID, { location_id: LOC_ID, plan_id: CORE, kind: 'tier' })
    expect(res.status).toBe(200)
    expect(activeTierPins(LOC_ID).map((r) => r.plan_version_id)).toEqual([CORE_V])
  })

  // Review rider: the guard only catches ALL-8-absent (LEGACY). A PARTIAL
  // version (some bundle keys present, others not) has "any" bundle key
  // and so sails through the guard untouched, no force needed — that's
  // correct polarity, not a hole: mirrorBundleFeatures grants a bundle
  // only on an explicit `true`, so the 5 omitted keys mean "deliberately
  // withheld", identical to the plan author typing `false` by hand. The
  // mirror's OWN write behaviour for this exact "3 of 8" shape (which 5
  // keys land `false`) is proven against a real applyPlanBundlesToLocation
  // call in plans.test.js — this makeFakeDb double doesn't model
  // getLocationPlan's embedded select (see plans.test.js's stubDb header
  // comment), so it can only prove the guard/pin half here.
  it('a PARTIAL version (3 of 8 bundle keys) pins with no force needed (guard only fires on ALL 8 absent)', async () => {
    const res = await assign(ORG_ID, { location_id: LOC_ID, plan_id: PARTIAL, kind: 'tier' })
    expect(res.status).toBe(200)
    expect(activeTierPins(LOC_ID).map((r) => r.plan_version_id)).toEqual([PARTIAL_V])
  })
})
