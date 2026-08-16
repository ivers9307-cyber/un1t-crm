// POST   /api/admin/tenants/[orgId]/plans — pin a plan version to one
//                                            of the tenant's locations.
// DELETE /api/admin/tenants/[orgId]/plans — unpin (deactivate) a pin →
//                                            location returns to dormant.
//
// This is the billing ON-SWITCH (INTEG / Repset monetisation, mig 413).
// Nothing has ever written location_plans — every location is unpinned,
// so getLocationPlan() returns null and wallets/enforcement/monthly-reset/
// meters/MRR all sit dormant. Pinning an ACTIVE TIER to a location makes
// getLocationPlan() non-null → the whole billing machine engages for
// THAT location. Unpinned/other locations are completely unaffected.
//
// ── The one-active-tier invariant (load-bearing) ────────────────────
// A location must NEVER have two active tier pins at once — getLocationPlan()
// picks "the" tier with .find() and MRR sums active tier prices, so two
// active tiers double-bill and pick an arbitrary allowance set. Assigning
// a tier therefore DEACTIVATES every currently-active tier pin for the
// location BEFORE activating the new one (deactivate-first ordering). The
// deactivation is a single guarded UPDATE; because it commits before the
// new tier is activated, the only reachable states are "one tier" (success)
// or "zero tiers" (interrupted → dormant, which getLocationPlan treats as
// unpinned) — the two-active-tiers state is never reachable through this
// route. Add-ons are additive: assigning one leaves the tier and other
// add-ons untouched, and re-assigning the same add-on is idempotent.
//
// Master-only, mirroring the sibling /api/admin/tenants routes. Cross-org
// / unknown location → 404 (not 403): detail semantics, ids aren't
// enumerable (CLAUDE.md IDOR rule).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody, uuidLike } from '@/lib/validate'
import { getActivePlanVersion, applyPlanBundlesToLocation } from '@/lib/plans'
import { PLAN_KINDS } from '@shared/plans'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A plan is identified by id OR slug (the UI has ids; slug is handy for
// scripts). Exactly one is required. plan_version_id is optional — when
// absent we default to the plan's CURRENT active version (grandfathering
// happens explicitly by passing a specific version).
const AssignBody = z.object({
  location_id: uuidLike,
  plan_id: uuidLike.optional(),
  plan_slug: z.string().trim().min(1).max(100).optional(),
  plan_version_id: uuidLike.optional(),
  kind: z.enum(PLAN_KINDS),
}).refine((b) => b.plan_id || b.plan_slug, {
  message: 'Provide plan_id or plan_slug',
  path: ['plan_id'],
})

const UnassignBody = z.object({
  location_id: uuidLike,
  plan_version_id: uuidLike,
})

async function requireMaster() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (user.profileRole !== 'master') return { error: NextResponse.json({ success: false, error: 'Master only' }, { status: 403 }) }
  return { user }
}

// Cross-org / unknown location → 404 (not 403), so org and location ids
// can't be enumerated from this endpoint. Returns the location row or a
// NextResponse to return.
async function loadLocationInOrg(db, orgId, locationId) {
  const { data, error } = await db
    .from('locations')
    .select('id, name, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (error) return { error: NextResponse.json({ success: false, error: error.message }, { status: 500 }) }
  if (!data || data.organization_id !== orgId) {
    return { error: NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 }) }
  }
  return { location: data }
}

/**
 * Activate (or re-activate) exactly one pin row for (location, version).
 * Update-or-insert: an existing row (any active state) is flipped active
 * with a fresh assigned_at/by; a brand-new pin is inserted. Returns the
 * resulting row or throws.
 */
async function activatePin(db, { locationId, versionId, userId }) {
  const nowIso = new Date().toISOString()
  const { data: updated, error: updErr } = await db
    .from('location_plans')
    .update({ active: true, assigned_by: userId, assigned_at: nowIso })
    .eq('location_id', locationId)
    .eq('plan_version_id', versionId)
    .select()
  if (updErr) throw new Error(updErr.message)
  if (updated && updated.length > 0) return updated[0]

  const { data: inserted, error: insErr } = await db
    .from('location_plans')
    .insert({ location_id: locationId, plan_version_id: versionId, active: true, assigned_by: userId, assigned_at: nowIso })
    .select()
    .single()
  if (insErr) throw new Error(insErr.message)
  return inserted
}

/**
 * Deactivate every ACTIVE tier pin for a location. THE one-active-tier
 * enforcement — a single guarded UPDATE, run BEFORE the new tier is
 * activated. Tier version ids are resolved from the flat plans /
 * plan_versions catalogue (kind='tier'), so no join is needed on the
 * UPDATE itself.
 */
async function deactivateActiveTierPins(db, locationId) {
  const { data: tierPlans, error: tpErr } = await db.from('plans').select('id').eq('kind', 'tier')
  if (tpErr) throw new Error(tpErr.message)
  const tierPlanIds = (tierPlans || []).map((p) => p.id)
  if (tierPlanIds.length === 0) return

  const { data: tierVersions, error: tvErr } = await db
    .from('plan_versions').select('id').in('plan_id', tierPlanIds)
  if (tvErr) throw new Error(tvErr.message)
  const tierVersionIds = (tierVersions || []).map((v) => v.id)
  if (tierVersionIds.length === 0) return

  const { error: updErr } = await db
    .from('location_plans')
    .update({ active: false })
    .eq('location_id', locationId)
    .eq('active', true)
    .in('plan_version_id', tierVersionIds)
  if (updErr) throw new Error(updErr.message)
}

export async function POST(request, props) {
  const { orgId } = await props.params
  const gate = await requireMaster()
  if (gate.error) return gate.error
  const { user } = gate

  if (!uuidLike.safeParse(orgId).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const validation = await validateBody(request, AssignBody)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()

  // 1) Location must belong to this org (404 cross-org).
  const locRes = await loadLocationInOrg(db, orgId, body.location_id)
  if (locRes.error) return locRes.error

  // 2) Plan must exist, be active, and match the requested kind.
  let planQuery = db.from('plans').select('id, slug, name, kind, active')
  planQuery = body.plan_id ? planQuery.eq('id', body.plan_id) : planQuery.eq('slug', body.plan_slug)
  const { data: plan, error: planErr } = await planQuery.maybeSingle()
  if (planErr) return NextResponse.json({ success: false, error: planErr.message }, { status: 500 })
  if (!plan) return NextResponse.json({ success: false, error: 'Plan not found' }, { status: 404 })
  if (!plan.active) {
    return NextResponse.json({ success: false, error: `Plan "${plan.slug}" is not active and cannot be assigned.` }, { status: 400 })
  }
  if (plan.kind !== body.kind) {
    return NextResponse.json({ success: false, error: `Plan "${plan.slug}" is a ${plan.kind}, not a ${body.kind}.` }, { status: 400 })
  }

  // 3) Resolve the version: an explicit one must belong to the plan;
  //    otherwise default to the plan's current active version.
  let version
  if (body.plan_version_id) {
    const { data: v, error: vErr } = await db
      .from('plan_versions')
      .select('id, plan_id, price_cents, effective_from')
      .eq('id', body.plan_version_id)
      .maybeSingle()
    if (vErr) return NextResponse.json({ success: false, error: vErr.message }, { status: 500 })
    if (!v || v.plan_id !== plan.id) {
      return NextResponse.json({ success: false, error: 'Plan version does not belong to this plan.' }, { status: 400 })
    }
    version = v
  } else {
    version = await getActivePlanVersion(db, plan.id)
    if (!version) {
      return NextResponse.json({ success: false, error: `Plan "${plan.slug}" has no active version to assign.` }, { status: 400 })
    }
  }

  // 4) Write. TIER: deactivate-first (the one-active-tier invariant),
  //    then activate the new tier. ADDON: additive + idempotent.
  try {
    if (plan.kind === 'tier') {
      await deactivateActiveTierPins(db, body.location_id)
    }
    const pin = await activatePin(db, {
      locationId: body.location_id,
      versionId: version.id,
      userId: user.id,
    })
    // BUNDLES.5 Task 3 — re-derive + write the location's bundle
    // mirror from its now-current plan pin state (src/lib/plans.js).
    await applyPlanBundlesToLocation(db, body.location_id)
    return NextResponse.json({
      success: true,
      data: {
        mode: plan.kind,
        pin: {
          location_id: body.location_id,
          plan_version_id: version.id,
          active: pin?.active ?? true,
        },
        plan: { id: plan.id, slug: plan.slug, name: plan.name, kind: plan.kind },
        version: { id: version.id, price_cents: version.price_cents, effective_from: version.effective_from },
      },
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 400 })
  }
}

// Unassign: deactivate a specific pin. Deactivating the active TIER pin
// returns the location to dormant (getLocationPlan → null, no billing);
// deactivating an add-on just drops that add-on. Idempotent-ish: a pin
// that doesn't exist for the location → 404.
export async function DELETE(request, props) {
  const { orgId } = await props.params
  const gate = await requireMaster()
  if (gate.error) return gate.error

  if (!uuidLike.safeParse(orgId).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const validation = await validateBody(request, UnassignBody)
  if (!validation.ok) return validation.response
  const { location_id, plan_version_id } = validation.data

  const db = createServerClient()

  const locRes = await loadLocationInOrg(db, orgId, location_id)
  if (locRes.error) return locRes.error

  const { data: rows, error } = await db
    .from('location_plans')
    .update({ active: false })
    .eq('location_id', location_id)
    .eq('plan_version_id', plan_version_id)
    .select()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  if (!rows || rows.length === 0) {
    return NextResponse.json({ success: false, error: 'No such pin for this location.' }, { status: 404 })
  }

  // BUNDLES.5 Task 3 — re-derive + write the location's bundle mirror.
  // Unassigning the active tier leaves the location with no active tier
  // row, so getLocationPlan() returns null and applyPlanBundlesToLocation
  // removes every bundle_x override — "no plan constraints", same as a
  // location that was never pinned (see that function's header comment).
  try {
    await applyPlanBundlesToLocation(db, location_id)
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 400 })
  }

  return NextResponse.json({
    success: true,
    data: { location_id, plan_version_id, active: false },
  })
}
