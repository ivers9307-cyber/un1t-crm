import { describe, it, expect, vi } from 'vitest'
import { FUNNEL_STAGE_SLUGS, OFF_FUNNEL_STAGE_SLUGS } from '../../shared/pipeline-classifier.js'
import { BUNDLE_KEYS } from '../../shared/permission-bundles.js'
import { defaultPipelineStages, seedLocationDefaults, seedBundleFeatures, STARTER_BUNDLES } from './location-seed.js'
import { DEFAULT_NOTIFICATION_CONFIG } from './notification-config.js'

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
  // Routes by table name so the pipelines seed, the pipeline_stages upsert,
  // and the BUNDLES.5 locations.features bundle-seed write can each be
  // exercised (and asserted on) independently.
  //
  // pipelineConflict: when set, the pipelines insert reports a 23505 (the
  // acquisition pipeline already exists) so the re-run path is exercised;
  // pipelineExisting is what the fallback select then finds.
  //
  // W1.W1: locationRow is what the seed's `locations.notification_config`
  // read finds (null = "never seeded"); companySettingsUpserts records the
  // company_settings upsert so the settings seed can be asserted on.
  function stubDb({
    pipelineConflict = false,
    pipelineExisting = { id: 'existing-pipeline' },
    locationRow = { notification_config: null },
  } = {}) {
    const upsertCalls = []
    const updateCalls = []
    const pipelineInsertCalls = []
    const companySettingsUpserts = []
    const upsert = vi.fn(async (rows, opts) => {
      upsertCalls.push({ rows, opts })
      return { error: null }
    })
    const from = vi.fn((table) => {
      if (table === 'pipeline_stages') return { upsert }
      if (table === 'company_settings') {
        return {
          upsert: vi.fn(async (row, opts) => {
            companySettingsUpserts.push({ row, opts })
            return { error: null }
          }),
        }
      }
      if (table === 'pipelines') {
        return {
          insert: vi.fn((row) => {
            pipelineInsertCalls.push(row)
            return {
              select: vi.fn(() => ({
                single: vi.fn(async () => (pipelineConflict
                  ? {
                    data: null,
                    error: {
                      code: '23505',
                      message: 'duplicate key value violates unique constraint "pipelines_location_key_unique"',
                    },
                  }
                  : { data: { id: 'pipeline-1' }, error: null })),
              })),
            }
          }),
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: pipelineExisting, error: null })),
              })),
            })),
          })),
        }
      }
      if (table === 'locations') {
        return {
          update: vi.fn((patch) => {
            updateCalls.push(patch)
            return { eq: vi.fn(async () => ({ error: null })) }
          }),
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: locationRow, error: null })),
            })),
          })),
        }
      }
      throw new Error(`stubDb: unexpected table ${table}`)
    })
    return { db: { from }, upsertCalls, updateCalls, upsert, pipelineInsertCalls, companySettingsUpserts }
  }

  // A minimal pipelines-table stub for the manual `db` objects below, which
  // each exercise a different table's error path and don't need stubDb()'s
  // full call recording.
  function okPipelinesTable(id = 'pipeline-1') {
    return {
      insert: () => ({ select: () => ({ single: async () => ({ data: { id }, error: null }) }) }),
    }
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

  // PIPELINES.6b — a stage row with no board is a break waiting on the
  // migration that sets pipeline_stages.pipeline_id NOT NULL: the moment it
  // lands, a fresh location's stage insert fails outright. Every stage must
  // hang off a seeded pipeline.
  it('seeds an acquisition pipeline before the stages', async () => {
    const { db, pipelineInsertCalls } = stubDb()
    await seedLocationDefaults(db, { id: 'loc-1' })
    expect(db.from).toHaveBeenCalledWith('pipelines')
    expect(pipelineInsertCalls).toHaveLength(1)
    expect(pipelineInsertCalls[0]).toMatchObject({
      location_id: 'loc-1',
      key: 'acquisition',
      name: 'Acquisition',
      module: 'acquisition',
      mode: 'derived',
      is_primary: true,
      display_order: 0,
      enabled: true,
    })
  })

  it('stamps every seeded stage with the resolved pipeline_id', async () => {
    const { db, upsertCalls } = stubDb()
    await seedLocationDefaults(db, { id: 'loc-1' })
    const { rows } = upsertCalls[0]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.pipeline_id).toBe('pipeline-1')
  })

  it('is re-runnable — reads the existing pipeline id back on a (location_id, key) conflict instead of throwing', async () => {
    const { db, upsertCalls } = stubDb({ pipelineConflict: true, pipelineExisting: { id: 'existing-pipeline' } })
    await seedLocationDefaults(db, { id: 'loc-1' })
    const { rows } = upsertCalls[0]
    for (const row of rows) expect(row.pipeline_id).toBe('existing-pipeline')
  })

  it('throws when the pipeline id cannot be resolved after a conflict (no row to fall back to)', async () => {
    const db = {
      from: (table) => {
        if (table === 'pipelines') {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: null,
                  error: {
                    code: '23505',
                    message: 'duplicate key value violates unique constraint "pipelines_location_key_unique"',
                  },
                }),
              }),
            }),
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
          }
        }
        throw new Error(`stubDb: unexpected table ${table}`)
      },
    }
    await expect(seedLocationDefaults(db, { id: 'loc-1' })).rejects.toThrow(/pipeline/i)
  })

  it('throws when the pipelines insert fails for a reason other than a conflict', async () => {
    const db = {
      from: (table) => {
        if (table === 'pipelines') {
          return {
            insert: () => ({
              select: () => ({ single: async () => ({ data: null, error: { message: 'permission denied' } }) }),
            }),
          }
        }
        throw new Error(`stubDb: unexpected table ${table}`)
      },
    }
    await expect(seedLocationDefaults(db, { id: 'loc-1' })).rejects.toThrow(/permission denied/)
  })

  it('throws when the upsert reports an error (supabase-js resolves, never rejects)', async () => {
    const db = {
      from: (table) => {
        if (table === 'pipelines') return okPipelinesTable()
        if (table === 'pipeline_stages') return { upsert: async () => ({ error: { message: 'permission denied' } }) }
        return { update: () => ({ eq: async () => ({ error: null }) }) }
      },
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
    const featurePatches = updateCalls.filter((u) => 'features' in u)
    expect(featurePatches).toHaveLength(1)
    const written = featurePatches[0].features
    for (const key of STARTER_BUNDLES) expect(key in written, key).toBe(false)
    for (const key of BUNDLE_KEYS.filter((k) => !STARTER_BUNDLES.includes(k))) {
      expect(written[key], key).toBe(false)
    }
  })

  it('throws when the locations.features write reports an error', async () => {
    const db = {
      from: (table) => {
        if (table === 'pipelines') return okPipelinesTable()
        if (table === 'pipeline_stages') return { upsert: async () => ({ error: null }) }
        return { update: () => ({ eq: async () => ({ error: { message: 'features write denied' } }) }) }
      },
    }
    await expect(seedLocationDefaults(db, { id: 'loc-1' })).rejects.toThrow(/features write denied/)
  })

  // W1.W1 — settings rows a tenant location is born with (SaaS Wave 1,
  // decision 6). company_settings: name from the location, logo null, quiet
  // hours from mig 514's column defaults (so the INSERT carries none).
  // notification_config: the exact DEFAULT_NOTIFICATION_CONFIG shape
  // (validateConfig drops unknown categories), written only while NULL.
  it('W1.W1 — seeds company_settings with the location name, no logo, and the schema quiet-hours defaults', async () => {
    const { db, companySettingsUpserts } = stubDb()
    await seedLocationDefaults(db, { id: 'loc-1', name: 'Gym A North', features: {} })
    expect(companySettingsUpserts).toEqual([{
      row: { location_id: 'loc-1', company_name: 'Gym A North', logo_url: null, favicon_url: null },
      opts: { onConflict: 'location_id', ignoreDuplicates: true },
    }])
    // Quiet hours are NOT NULL DEFAULT columns (enabled true, 21 → 8): the
    // seed must not name them, or a later default change would be shadowed.
    for (const key of Object.keys(companySettingsUpserts[0].row)) {
      expect(key.startsWith('send_quiet_hours'), key).toBe(false)
    }
  })

  it('W1.W1 — seeds locations.notification_config with exactly DEFAULT_NOTIFICATION_CONFIG when it is null', async () => {
    const { db, updateCalls } = stubDb({ locationRow: { id: 'loc-1', notification_config: null } })
    await seedLocationDefaults(db, { id: 'loc-1', name: 'Gym A North', features: {} })
    const patch = updateCalls.find((u) => 'notification_config' in u)
    expect(patch).toBeDefined()
    expect(patch.notification_config).toEqual(DEFAULT_NOTIFICATION_CONFIG)
    expect(Object.keys(patch)).toEqual(['notification_config'])
  })

  it("W1.W1 — re-running never overwrites an operator's branding or notification config", async () => {
    const { db, updateCalls, companySettingsUpserts } = stubDb({
      locationRow: { id: 'loc-1', notification_config: { categories: {} } },
    })
    await seedLocationDefaults(db, { id: 'loc-1', name: 'Gym A North', features: {} })
    // The upsert ignores an existing row (an operator's renamed brand stays).
    expect(companySettingsUpserts).toHaveLength(1)
    expect(companySettingsUpserts[0].opts).toMatchObject({ ignoreDuplicates: true })
    // A non-null notification_config is left exactly as it is.
    expect(updateCalls.some((u) => 'notification_config' in u)).toBe(false)
  })

  it('W1.W1 — a host-anchor location is not seeded with settings', async () => {
    const { db, updateCalls, companySettingsUpserts } = stubDb()
    await seedLocationDefaults(db, { id: 'loc-h', name: 'PTC (host events)', is_host_anchor: true, features: {} })
    expect(companySettingsUpserts).toEqual([])
    expect(updateCalls.some((u) => 'notification_config' in u)).toBe(false)
  })

  it('W1.W1 — a blank location name seeds company_name null, not an empty string', async () => {
    const { db, companySettingsUpserts } = stubDb()
    await seedLocationDefaults(db, { id: 'loc-1', name: '   ', features: {} })
    expect(companySettingsUpserts[0].row.company_name).toBeNull()
  })

  it('W1.W1 — throws when the company_settings seed reports an error', async () => {
    const db = {
      from: (table) => {
        if (table === 'pipelines') return okPipelinesTable()
        if (table === 'pipeline_stages') return { upsert: async () => ({ error: null }) }
        if (table === 'company_settings') return { upsert: async () => ({ error: { message: 'company_settings denied' } }) }
        return { update: () => ({ eq: async () => ({ error: null }) }) }
      },
    }
    await expect(seedLocationDefaults(db, { id: 'loc-1', name: 'Gym A' })).rejects.toThrow(/company_settings denied/)
  })

  it('W1.W1 — throws when the notification_config read or write reports an error', async () => {
    const dbReadFails = {
      from: (table) => {
        if (table === 'pipelines') return okPipelinesTable()
        if (table === 'pipeline_stages') return { upsert: async () => ({ error: null }) }
        if (table === 'company_settings') return { upsert: async () => ({ error: null }) }
        return {
          update: () => ({ eq: async () => ({ error: null }) }),
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'config read denied' } }) }) }),
        }
      },
    }
    await expect(seedLocationDefaults(dbReadFails, { id: 'loc-1', name: 'Gym A' })).rejects.toThrow(/config read denied/)

    let patches = 0
    const dbWriteFails = {
      from: (table) => {
        if (table === 'pipelines') return okPipelinesTable()
        if (table === 'pipeline_stages') return { upsert: async () => ({ error: null }) }
        if (table === 'company_settings') return { upsert: async () => ({ error: null }) }
        return {
          update: (patch) => ({
            eq: async () => {
              patches += 1
              return 'notification_config' in patch ? { error: { message: 'config write denied' } } : { error: null }
            },
          }),
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { notification_config: null }, error: null }) }) }),
        }
      },
    }
    await expect(seedLocationDefaults(dbWriteFails, { id: 'loc-1', name: 'Gym A' })).rejects.toThrow(/config write denied/)
    expect(patches).toBe(2) // features, then notification_config
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
