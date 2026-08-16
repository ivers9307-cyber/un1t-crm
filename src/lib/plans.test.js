import { describe, it, expect, vi } from 'vitest'
import { pickActiveVersion, resolveAllowances, mirrorBundleFeatures, applyPlanBundlesToLocation } from './plans.js'
import { BUNDLE_KEYS } from '@shared/permission-bundles'

const v = (effective_from, extra = {}) => ({ effective_from, ...extra })

describe('pickActiveVersion', () => {
  it('picks the latest version effective on or before the date', () => {
    const versions = [
      v('2026-01-01', { price_cents: 9900 }),
      v('2026-06-01', { price_cents: 10900 }),
      v('2026-09-01', { price_cents: 11900 }),
    ]
    expect(pickActiveVersion(versions, '2026-07-19').price_cents).toBe(10900)
  })

  it('includes a version whose effective_from is exactly the date', () => {
    const versions = [v('2026-01-01'), v('2026-07-19', { price_cents: 5 })]
    expect(pickActiveVersion(versions, '2026-07-19').price_cents).toBe(5)
  })

  it('ignores scheduled (future) versions', () => {
    const versions = [v('2026-09-01'), v('2027-01-01')]
    expect(pickActiveVersion(versions, '2026-07-19')).toBeNull()
  })

  it('is order-independent', () => {
    const versions = [
      v('2026-06-01', { price_cents: 2 }),
      v('2026-01-01', { price_cents: 1 }),
    ]
    expect(pickActiveVersion(versions, '2026-12-01').price_cents).toBe(2)
    expect(pickActiveVersion([...versions].reverse(), '2026-12-01').price_cents).toBe(2)
  })

  it('returns null for empty / missing input', () => {
    expect(pickActiveVersion([], '2026-07-19')).toBeNull()
    expect(pickActiveVersion(null, '2026-07-19')).toBeNull()
  })
})

describe('resolveAllowances', () => {
  const tier = {
    allowances: { wa_template_send: 500, email_send: 2500, ai_message: 0 },
    unit_rates_cents: { wa_marketing: 9, wa_utility: 4, email_per_1k: 400, ai_message: 5 },
    features: { ai_agent: false, custom_email_domain: false },
  }

  it('returns null for an unpinned location (no tier version)', () => {
    expect(resolveAllowances(null)).toBeNull()
    expect(resolveAllowances(undefined, [])).toBeNull()
  })

  it('passes tier allowances, rates and features through with no add-ons', () => {
    const r = resolveAllowances(tier, [])
    expect(r.allowances).toEqual({ wa_template_send: 500, email_send: 2500, ai_message: 0 })
    expect(r.unitRatesCents).toEqual(tier.unit_rates_cents)
    expect(r.features).toEqual({ ai_agent: false, custom_email_domain: false })
  })

  it('sums add-on allowances onto the tier per meter', () => {
    const addon = { allowances: { ai_message: 1000 }, features: {} }
    const r = resolveAllowances(tier, [addon])
    expect(r.allowances.ai_message).toBe(1000)
    expect(r.allowances.wa_template_send).toBe(500)
  })

  it('ORs features — an add-on grants but never revokes', () => {
    const addon = { allowances: {}, features: { custom_email_domain: true } }
    const r = resolveAllowances(tier, [addon])
    expect(r.features.custom_email_domain).toBe(true)
    // A second add-on with the flag false must not revoke the grant.
    const r2 = resolveAllowances(tier, [addon, { features: { custom_email_domain: false } }])
    expect(r2.features.custom_email_domain).toBe(true)
  })

  it('takes overage rates from the tier only, ignoring add-on rates', () => {
    const addon = { allowances: {}, unit_rates_cents: { wa_marketing: 999 }, features: {} }
    expect(resolveAllowances(tier, [addon]).unitRatesCents.wa_marketing).toBe(9)
  })

  it('treats missing / malformed allowance values as zero', () => {
    const r = resolveAllowances(
      { allowances: { email_send: 'not-a-number' }, features: {} },
      [{ allowances: { wa_template_send: null } }]
    )
    expect(r.allowances).toEqual({ wa_template_send: 0, email_send: 0, ai_message: 0 })
  })

  it('ignores unknown meter keys from DB jsonb (structure lives in code)', () => {
    const r = resolveAllowances(
      { allowances: { mystery_meter: 42, email_send: 10 }, features: {} },
      []
    )
    expect(r.allowances.mystery_meter).toBeUndefined()
    expect(r.allowances.email_send).toBe(10)
  })
})

// BUNDLES.5 Task 3 — the plan → locations.features bundle mirror.
describe('mirrorBundleFeatures', () => {
  it('a bundle the plan grants (=== true) is REMOVED from features — back to default-on', () => {
    const next = mirrorBundleFeatures({ bundle_sales: false }, { bundle_sales: true })
    expect('bundle_sales' in next).toBe(false)
  })

  it('a bundle absent from the plan features is set explicitly false', () => {
    const next = mirrorBundleFeatures({}, { bundle_sales: true })
    expect(next.bundle_money).toBe(false)
  })

  it('a bundle explicitly false in the plan features is set explicitly false (same as absent)', () => {
    const next = mirrorBundleFeatures({}, { bundle_money: false })
    expect(next.bundle_money).toBe(false)
  })

  it('covers every BUNDLE_KEYS entry, granting exactly the ones the plan lists true', () => {
    const planFeatures = { bundle_messaging: true, bundle_sales: true, bundle_members: true, ai_agent: true }
    const next = mirrorBundleFeatures({}, planFeatures)
    for (const key of BUNDLE_KEYS) {
      if (['bundle_messaging', 'bundle_sales', 'bundle_members'].includes(key)) {
        expect(key in next, key).toBe(false)
      } else {
        expect(next[key], key).toBe(false)
      }
    }
    // Non-bundle plan feature keys (ai_agent) are none of this
    // function's business — never copied onto locations.features.
    expect('ai_agent' in next).toBe(false)
  })

  it('planFeatures === null (unpinned) removes EVERY bundle override — restores plain back-compat', () => {
    const allOff = Object.fromEntries(BUNDLE_KEYS.map((k) => [k, false]))
    const next = mirrorBundleFeatures(allOff, null)
    for (const key of BUNDLE_KEYS) expect(key in next, key).toBe(false)
  })

  it('preserves non-bundle keys already on the location untouched', () => {
    const next = mirrorBundleFeatures({ pipeline: false, notify_lead: true }, { bundle_sales: true })
    expect(next.pipeline).toBe(false)
    expect(next.notify_lead).toBe(true)
  })

  it('null/undefined currentFeatures is treated as {}', () => {
    expect(() => mirrorBundleFeatures(null, {})).not.toThrow()
    expect(() => mirrorBundleFeatures(undefined, {})).not.toThrow()
  })
})

describe('applyPlanBundlesToLocation', () => {
  // Minimal stub covering exactly the two tables/chains this function
  // (via getLocationPlan) touches — not the full makeFakeDb double,
  // since getLocationPlan's embedded select
  // (version:plan_versions!plan_version_id(*, plan:plans!plan_id(*)))
  // needs pre-shaped fixture rows rather than real join logic.
  function stubDb({ locationPlanRows = [], location = { features: {} } } = {}) {
    const updates = []
    return {
      updates,
      db: {
        from(table) {
          if (table === 'location_plans') {
            return {
              select: () => ({
                eq: () => ({
                  eq: async () => ({ data: locationPlanRows, error: null }),
                }),
              }),
            }
          }
          if (table === 'locations') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: location, error: null }),
                }),
              }),
              update: (patch) => ({
                eq: async () => { updates.push(patch); return { error: null } },
              }),
            }
          }
          throw new Error(`stubDb: unexpected table ${table}`)
        },
      },
    }
  }

  const tierRow = (features) => ({
    plan_version_id: 'v-tier',
    active: true,
    version: {
      id: 'v-tier',
      plan_id: 'p-tier',
      allowances: {},
      unit_rates_cents: {},
      features,
      plan: { id: 'p-tier', kind: 'tier', slug: 'growth' },
    },
  })

  it('a pinned tier granting bundle_messaging/sales/members removes those keys and denies the rest', async () => {
    const { db, updates } = stubDb({
      locationPlanRows: [tierRow({ bundle_messaging: true, bundle_sales: true, bundle_members: true })],
      location: { features: {} },
    })
    const result = await applyPlanBundlesToLocation(db, 'loc-1')
    expect(updates).toHaveLength(1)
    expect(updates[0].features).toEqual(result)
    for (const key of ['bundle_messaging', 'bundle_sales', 'bundle_members']) {
      expect(key in result, key).toBe(false)
    }
    for (const key of BUNDLE_KEYS.filter((k) => !['bundle_messaging', 'bundle_sales', 'bundle_members'].includes(k))) {
      expect(result[key], key).toBe(false)
    }
  })

  it('an unpinned location (no active tier row) removes every bundle override — same as never pinned', async () => {
    const priorlyDenied = Object.fromEntries(BUNDLE_KEYS.map((k) => [k, false]))
    const { db, updates } = stubDb({ locationPlanRows: [], location: { features: priorlyDenied } })
    const result = await applyPlanBundlesToLocation(db, 'loc-1')
    expect(updates).toHaveLength(1)
    for (const key of BUNDLE_KEYS) expect(key in result, key).toBe(false)
  })

  it('preserves the location row id targeting and stamps updated_at', async () => {
    const { db } = stubDb({ locationPlanRows: [], location: { features: {} } })
    const eqSpy = vi.fn(async () => ({ error: null }))
    db.from = (table) => {
      if (table === 'location_plans') {
        return { select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }) }
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { features: {} }, error: null }) }) }),
        update: (patch) => { expect(patch.updated_at).toBeTruthy(); return { eq: eqSpy } },
      }
    }
    await applyPlanBundlesToLocation(db, 'loc-42')
    expect(eqSpy).toHaveBeenCalledWith('id', 'loc-42')
  })

  it('throws (does not swallow) a locations select error', async () => {
    const db = {
      from(table) {
        if (table === 'location_plans') return { select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }) }
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }) }) }
      },
    }
    await expect(applyPlanBundlesToLocation(db, 'loc-1')).rejects.toThrow(/boom/)
  })

  it('throws (does not swallow) a locations update error', async () => {
    const db = {
      from(table) {
        if (table === 'location_plans') return { select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }) }
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { features: {} }, error: null }) }) }),
          update: () => ({ eq: async () => ({ error: { message: 'update boom' } }) }),
        }
      },
    }
    await expect(applyPlanBundlesToLocation(db, 'loc-1')).rejects.toThrow(/update boom/)
  })
})
