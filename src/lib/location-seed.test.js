import { describe, it, expect, vi } from 'vitest'
import { FUNNEL_STAGE_SLUGS, OFF_FUNNEL_STAGE_SLUGS } from '../../shared/pipeline-classifier.js'
import { BUNDLE_KEYS } from '../../shared/permission-bundles.js'
import { defaultPipelineStages, seedLocationDefaults, seedBundleFeatures, STARTER_BUNDLES } from './location-seed.js'

describe('defaultPipelineStages', () => {
  it('matches the classifier taxonomy exactly — funnel then off-funnel, in order', () => {
    // THE drift-pin. The classifier writes these slugs; a location whose
    // pipeline_stages rows don't cover them breaks classification (the
    // mig 150 incident class: 899/1000 contacts erroring on a missing
    // slug). LocationForm previously seeded a stale 9-stage taxonomy —
    // this test makes the seed and the classifier fail together or not
    // at all.
    const slugs = defaultPipelineStages().map((s) => s.slug)
    expect(slugs).toEqual([...FUNNEL_STAGE_SLUGS, ...OFF_FUNNEL_STAGE_SLUGS])
  })

  it('flags off-funnel stages is_dormant and funnel stages not', () => {
    for (const stage of defaultPipelineStages()) {
      const expected = OFF_FUNNEL_STAGE_SLUGS.includes(stage.slug)
      expect(stage.is_dormant, stage.slug).toBe(expected)
    }
  })

  it('gives every stage a name, a hex color, and a unique display_order', () => {
    // NOTE: array order follows the classifier taxonomy (cold_lead before
    // dormant), while display_order follows prod (dormant 309, cold 310 —
    // mig 391 appended Cold last). The board sorts by display_order, so
    // rows need not be array-ordered — only unique and prod-accurate.
    const stages = defaultPipelineStages()
    const orders = stages.map((s) => s.display_order)
    expect(new Set(orders).size).toBe(stages.length)
    for (const stage of stages) {
      expect(stage.name, stage.slug).toBeTruthy()
      expect(stage.color, stage.slug).toMatch(/^#[0-9A-F]{6}$/i)
      expect(stage.archived, stage.slug).toBe(false)
    }
  })

  it('mirrors the live prod rows seeded by migs 350/356/391 (orders 301–310)', () => {
    const bySlug = Object.fromEntries(defaultPipelineStages().map((s) => [s.slug, s]))
    expect(bySlug.new_lead).toMatchObject({ name: 'New Leads', display_order: 301 })
    expect(bySlug.converted).toMatchObject({ display_order: 305 })
    expect(bySlug.pack_member).toMatchObject({ name: 'Class Pack', display_order: 307 })
    expect(bySlug.cold_lead).toMatchObject({ name: 'Cold', display_order: 310 })
  })

  it('returns fresh objects each call (no shared mutable rows)', () => {
    const a = defaultPipelineStages()
    a[0].slug = 'mutated'
    expect(defaultPipelineStages()[0].slug).toBe('new_lead')
  })
})

describe('seedLocationDefaults', () => {
  // Routes by table name so both the pipeline_stages upsert and the
  // BUNDLES.5 locations.features bundle-seed write can be exercised
  // (and asserted on) independently.
  function stubDb() {
    const upsertCalls = []
    const updateCalls = []
    const upsert = vi.fn(async (rows, opts) => {
      upsertCalls.push({ rows, opts })
      return { error: null }
    })
    const from = vi.fn((table) => {
      if (table === 'pipeline_stages') return { upsert }
      if (table === 'locations') {
        return {
          update: vi.fn((patch) => {
            updateCalls.push(patch)
            return { eq: vi.fn(async () => ({ error: null })) }
          }),
        }
      }
      throw new Error(`stubDb: unexpected table ${table}`)
    })
    return { db: { from }, upsertCalls, updateCalls, upsert }
  }

  it('upserts every default stage stamped with the location id', async () => {
    const { db, upsertCalls } = stubDb()
    await seedLocationDefaults(db, { id: 'loc-1' })
    expect(db.from).toHaveBeenCalledWith('pipeline_stages')
    expect(upsertCalls).toHaveLength(1)
    const { rows } = upsertCalls[0]
    expect(rows).toHaveLength(FUNNEL_STAGE_SLUGS.length + OFF_FUNNEL_STAGE_SLUGS.length)
    for (const row of rows) expect(row.location_id).toBe('loc-1')
  })

  it('is idempotent — ignores duplicates on the (location_id, slug) unique key', async () => {
    // Re-running the seed (wizard retry, resumed provisioning) must not
    // error against uq (location_id, slug) from mig 150.
    const { db, upsertCalls } = stubDb()
    await seedLocationDefaults(db, { id: 'loc-1' })
    expect(upsertCalls[0].opts).toMatchObject({
      onConflict: 'location_id,slug',
      ignoreDuplicates: true,
    })
  })

  it('throws when the upsert reports an error (supabase-js resolves, never rejects)', async () => {
    const db = {
      from: (table) => (table === 'pipeline_stages'
        ? { upsert: async () => ({ error: { message: 'permission denied' } }) }
        : { update: () => ({ eq: async () => ({ error: null }) }) }),
    }
    await expect(seedLocationDefaults(db, { id: 'loc-1' })).rejects.toThrow(/permission denied/)
  })

  it('rejects a location without an id rather than seeding orphan rows', async () => {
    const { db } = stubDb()
    await expect(seedLocationDefaults(db, {})).rejects.toThrow(/location/i)
  })

  it('also writes the starter bundle defaults onto locations.features', async () => {
    const { db, updateCalls } = stubDb()
    await seedLocationDefaults(db, { id: 'loc-1', features: {} })
    expect(db.from).toHaveBeenCalledWith('locations')
    expect(updateCalls).toHaveLength(1)
    const written = updateCalls[0].features
    for (const key of STARTER_BUNDLES) expect(key in written, key).toBe(false)
    for (const key of BUNDLE_KEYS.filter((k) => !STARTER_BUNDLES.includes(k))) {
      expect(written[key], key).toBe(false)
    }
  })

  it('throws when the locations.features write reports an error', async () => {
    const db = {
      from: (table) => (table === 'pipeline_stages'
        ? { upsert: async () => ({ error: null }) }
        : { update: () => ({ eq: async () => ({ error: { message: 'features write denied' } }) }) }),
    }
    await expect(seedLocationDefaults(db, { id: 'loc-1' })).rejects.toThrow(/features write denied/)
  })
})

// BUNDLES.5 Task 3 — new-location bundle defaults (pure adapter).
describe('seedBundleFeatures', () => {
  it('leaves STARTER_BUNDLES (messaging, sales, members) unset — default-on', () => {
    expect(STARTER_BUNDLES).toEqual(['bundle_messaging', 'bundle_sales', 'bundle_members'])
    const result = seedBundleFeatures({})
    for (const key of STARTER_BUNDLES) expect(key in result, key).toBe(false)
  })

  it('sets every other bundle (money, marketing, team, operations, module_cars) explicitly false', () => {
    const result = seedBundleFeatures({})
    for (const key of BUNDLE_KEYS.filter((k) => !STARTER_BUNDLES.includes(k))) {
      expect(result[key], key).toBe(false)
    }
  })

  it('is a MERGE, not a replace — an already-set key is never overwritten', () => {
    // Re-running against a partially-provisioned location (wizard retry)
    // must not stomp a bundle an operator already toggled by hand.
    const result = seedBundleFeatures({ bundle_money: true, bundle_sales: false })
    expect(result.bundle_money).toBe(true)
    expect(result.bundle_sales).toBe(false)
  })

  it('preserves unrelated fine-grained feature keys untouched', () => {
    const result = seedBundleFeatures({ pipeline: false })
    expect(result.pipeline).toBe(false)
  })

  it('null/undefined existingFeatures is treated as {}', () => {
    expect(() => seedBundleFeatures(null)).not.toThrow()
    expect(() => seedBundleFeatures(undefined)).not.toThrow()
  })
})
