import { describe, it, expect, vi } from 'vitest'
import { FUNNEL_STAGE_SLUGS, OFF_FUNNEL_STAGE_SLUGS } from '../../shared/pipeline-classifier.js'
import { defaultPipelineStages, seedLocationDefaults } from './location-seed.js'

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
  function stubDb() {
    const calls = []
    const upsert = vi.fn(async (rows, opts) => {
      calls.push({ rows, opts })
      return { error: null }
    })
    return { db: { from: vi.fn(() => ({ upsert })) }, calls, upsert }
  }

  it('upserts every default stage stamped with the location id', async () => {
    const { db, calls } = stubDb()
    await seedLocationDefaults(db, { id: 'loc-1' })
    expect(db.from).toHaveBeenCalledWith('pipeline_stages')
    expect(calls).toHaveLength(1)
    const { rows } = calls[0]
    expect(rows).toHaveLength(FUNNEL_STAGE_SLUGS.length + OFF_FUNNEL_STAGE_SLUGS.length)
    for (const row of rows) expect(row.location_id).toBe('loc-1')
  })

  it('is idempotent — ignores duplicates on the (location_id, slug) unique key', async () => {
    // Re-running the seed (wizard retry, resumed provisioning) must not
    // error against uq (location_id, slug) from mig 150.
    const { db, calls } = stubDb()
    await seedLocationDefaults(db, { id: 'loc-1' })
    expect(calls[0].opts).toMatchObject({
      onConflict: 'location_id,slug',
      ignoreDuplicates: true,
    })
  })

  it('throws when the upsert reports an error (supabase-js resolves, never rejects)', async () => {
    const db = {
      from: () => ({ upsert: async () => ({ error: { message: 'permission denied' } }) }),
    }
    await expect(seedLocationDefaults(db, { id: 'loc-1' })).rejects.toThrow(/permission denied/)
  })

  it('rejects a location without an id rather than seeding orphan rows', async () => {
    const { db } = stubDb()
    await expect(seedLocationDefaults(db, {})).rejects.toThrow(/location/i)
  })
})
