// HATCHPIPE.3 — migration 740 (A2): re-enable Hatch's acquisition board as
// `acquisition_un1t`. Static checks on the file, plus PGlite with `pipelines`,
// `pipeline_stages`, `deals` and `contacts` carrying the live constraints that
// matter (migs 594/597/598/150), a Hatch fixture shaped like the 18 Oct
// measurement (acquisition disabled, 11 module slugs + 7 legacy rows archived,
// waitlist the enabled primary), Stillorgan, and a disabled-board studio.
// The expected stage list is READ FROM shared/pipelines/acquisition.js, never
// hand-copied, so the migration's literal list cannot drift from the module.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { stages as MODULE_STAGES } from '../shared/pipelines/acquisition.js'
import { sqlCode } from './helpers/sql-code.js'

const MIG_PATH = path.resolve(import.meta.dirname, '../supabase/migrations/740_hatch_acquisition_board_enable.sql')
// Read per test, so a missing file fails each test on its own.
const mig = () => readFileSync(MIG_PATH, 'utf8')

const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4' // hard-coded in the migration, as in migs 597/598/736
const STILL = 'a0000000-0000-0000-0000-000000000001'
const CCF = 'c0000000-0000-0000-0000-0000000000c1'

const P = {
  hatchAcq: 'e0000000-0000-0000-0000-000000000001',
  hatchWait: 'e0000000-0000-0000-0000-000000000002',
  stillAcq: 'e0000000-0000-0000-0000-000000000003',
  ccfAcq: 'e0000000-0000-0000-0000-000000000004',
}
const MODULE_SLUGS = MODULE_STAGES.map((s) => s.slug)
// PIPELINE5's 200-block (mig 147) minus `dormant`, which the module reuses:
// Hatch's 7 legacy archived rows.
const LEGACY_SLUGS = ['active_trial', 'hot_conversion', 'active_member', 'at_risk_member', 'classpass_active', 'lapsed', 'dormant_classpass']
const WAITLIST_SLUGS = ['waitlist_new_enquiry', 'waitlist_no_answer', 'waitlist_interested', 'waitlist_not_interested', 'waitlist_converted']

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)
const q = async (text, params) => (await db.query(text, params)).rows

let n = 0
const uuid = (prefix = 'd') => `${prefix}0000000-0000-0000-0000-${String(++n).padStart(12, '0')}`

const SCHEMA = `
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  INSERT INTO public.locations VALUES ('${HATCH}'), ('${STILL}'), ('${CCF}');

  -- mig 594 (+ 597's waitlist row shape)
  CREATE TABLE public.pipelines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id),
    key text NOT NULL, name text NOT NULL, module text,
    mode text NOT NULL DEFAULT 'derived' CHECK (mode IN ('derived','manual')),
    is_primary boolean NOT NULL DEFAULT false,
    display_order int NOT NULL DEFAULT 0,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT '2026-09-08T00:00:00Z',
    CONSTRAINT pipelines_location_key_unique UNIQUE (location_id, key),
    CONSTRAINT pipelines_module_matches_mode CHECK (
      (mode = 'derived' AND module IS NOT NULL) OR (mode = 'manual' AND module IS NULL))
  );
  CREATE UNIQUE INDEX pipelines_one_primary_per_location ON public.pipelines (location_id) WHERE is_primary;

  -- migs 001/147/150/594/597/598
  CREATE TABLE public.pipeline_stages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id),
    pipeline_id uuid NOT NULL REFERENCES public.pipelines(id),
    name text NOT NULL, slug text NOT NULL,
    display_order int NOT NULL, color text DEFAULT '#6B7280',
    is_dormant boolean NOT NULL DEFAULT false,
    archived boolean NOT NULL DEFAULT false,
    created_at timestamptz DEFAULT '2026-05-01T00:00:00Z',
    CONSTRAINT pipeline_stages_location_slug_unique UNIQUE (location_id, slug),
    CONSTRAINT pipeline_stages_pipeline_name_unique UNIQUE (pipeline_id, name)
  );

  CREATE TABLE public.contacts (
    id uuid PRIMARY KEY, location_id uuid, pipeline_stage_slug text,
    updated_at timestamptz NOT NULL DEFAULT '2026-10-01T00:00:00Z'
  );
  CREATE TABLE public.deals (
    id uuid PRIMARY KEY, contact_id uuid, location_id uuid,
    pipeline_id uuid REFERENCES public.pipelines(id), stage_id uuid REFERENCES public.pipeline_stages(id),
    status text NOT NULL DEFAULT 'open',
    updated_at timestamptz NOT NULL DEFAULT '2026-10-01T00:00:00Z'
  );

  INSERT INTO public.pipelines (id, location_id, key, name, module, mode, is_primary, display_order, enabled) VALUES
    ('${P.hatchAcq}',  '${HATCH}', 'acquisition', 'Acquisition', 'acquisition', 'derived', false, 0, false),
    ('${P.hatchWait}', '${HATCH}', 'waitlist',    'Waitlist',    null,          'manual',  true,  0, true),
    ('${P.stillAcq}',  '${STILL}', 'acquisition', 'Acquisition', 'acquisition', 'derived', true,  0, true),
    ('${P.ccfAcq}',    '${CCF}',   'acquisition', 'Acquisition', 'acquisition', 'derived', true,  0, false);
`

// Hatch's archived module rows carry stale values (old order block, an older
// name and colour on one), so the test sees the upsert rewrite them.
const STALE = { pack_member: { name: 'Pack Member', color: '#000000' } }

async function fresh({ omitHatchSlugs = [], waitlistDeals = 3 } = {}) {
  db = new PGlite()
  await runSql(SCHEMA)
  const ins = (loc, pipeline, name, slug, order, color, dormant, archived) => db.query(
    `INSERT INTO public.pipeline_stages (id, location_id, pipeline_id, name, slug, display_order, color, is_dormant, archived)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [uuid('f'), loc, pipeline, name, slug, order, color, dormant, archived])

  for (const [i, s] of MODULE_STAGES.entries()) {
    if (omitHatchSlugs.includes(s.slug)) continue
    const stale = STALE[s.slug] || {}
    await ins(HATCH, P.hatchAcq, stale.name ?? s.name, s.slug, 100 + i, stale.color ?? s.color, false, true)
    await ins(STILL, P.stillAcq, s.name, s.slug, s.display_order, s.color, s.is_dormant, false)
    await ins(CCF, P.ccfAcq, s.name, s.slug, s.display_order, s.color, s.is_dormant, true)
  }
  for (const [i, slug] of LEGACY_SLUGS.entries()) {
    await ins(HATCH, P.hatchAcq, `Legacy ${slug}`, slug, 201 + i, '#111111', false, true)
  }
  for (const [i, slug] of WAITLIST_SLUGS.entries()) {
    await ins(HATCH, P.hatchWait, `Waitlist ${i}`, slug, 501 + i, '#3B82F6', false, false)
  }

  const stageId = async (loc, slug) => (await q(`SELECT id FROM public.pipeline_stages WHERE location_id = $1 AND slug = $2`, [loc, slug]))[0].id
  const addDeal = async (loc, pipeline, slug, status = 'open') => {
    const contact = uuid('c')
    await db.query(`INSERT INTO public.contacts (id, location_id, pipeline_stage_slug) VALUES ($1, $2, $3)`, [contact, loc, slug])
    await db.query(`INSERT INTO public.deals (id, contact_id, location_id, pipeline_id, stage_id, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuid('d'), contact, loc, pipeline, await stageId(loc, slug), status])
  }
  for (let i = 0; i < waitlistDeals; i++) await addDeal(HATCH, P.hatchWait, 'waitlist_new_enquiry')
  await addDeal(HATCH, P.hatchWait, 'waitlist_converted', 'won')
  // A closed deal still on an archived Hatch gym stage (mig 598 kept them).
  await addDeal(HATCH, P.hatchAcq, LEGACY_SLUGS[0], 'lost')
  await addDeal(STILL, P.stillAcq, 'new_lead')
  await addDeal(STILL, P.stillAcq, 'member')
  // A Hatch-owned linked client with no deal at all: the "later effect" population.
  await db.query(`INSERT INTO public.contacts (id, location_id, pipeline_stage_slug) VALUES ($1, $2, NULL)`, [uuid('c'), HATCH])
}

const snapshot = async () => ({
  pipelines: await q(`SELECT * FROM public.pipelines ORDER BY id`),
  stages: await q(`SELECT * FROM public.pipeline_stages ORDER BY id`),
  deals: await q(`SELECT * FROM public.deals ORDER BY id`),
  contacts: await q(`SELECT * FROM public.contacts ORDER BY id`),
})
const board = async (key, loc = HATCH) => (await q(`SELECT * FROM public.pipelines WHERE location_id = $1 AND key = $2`, [loc, key]))[0]
const hatchAcqStages = () => q(`SELECT * FROM public.pipeline_stages WHERE pipeline_id = $1 ORDER BY slug`, [P.hatchAcq])

afterEach(async () => { await db?.close(); db = null })

// The literal stage rows of the migration's module list.
function migrationStageRows(sql) {
  const block = sql.slice(sql.indexOf('INSERT INTO a2_module_stages'), sql.indexOf('-- ── Before'))
  return [...block.matchAll(/\('(\w+)',\s*'([^']+)',\s*(\d+),\s*'(#[0-9A-Fa-f]{6})',\s*(true|false)\)/g)]
    .map(([, slug, name, order, color, dormant]) => ({ slug, name, display_order: Number(order), color, is_dormant: dormant === 'true' }))
}

describe('mig 740 — static', () => {
  it('states -- grant: none (no new relation)', () => {
    expect(mig()).toMatch(/^-- grant: none \(no new relation\)$/m)
  })

  it('is one transaction with guarded DO $$ self-checks', () => {
    const code = sqlCode(mig())
    expect(code.match(/^\s*BEGIN;\s*$/gm)).toHaveLength(1)
    expect(code.match(/^\s*COMMIT;\s*$/gm)).toHaveLength(1)
    expect(code).toMatch(/DO \$\$/)
    expect((code.match(/RAISE EXCEPTION/g) || []).length).toBeGreaterThanOrEqual(6)
  })

  it('lists exactly the 11 stages of shared/pipelines/acquisition.js, values and all', () => {
    expect(MODULE_STAGES).toHaveLength(11)
    expect(migrationStageRows(mig())).toEqual(MODULE_STAGES.map(({ slug, name, display_order, color, is_dormant }) => ({ slug, name, display_order, color, is_dormant })))
  })

  it('upserts conflict-targeted on (location_id, slug), setting archived false', () => {
    const code = sqlCode(mig())
    expect(code).toMatch(/ON CONFLICT \(location_id, slug\) DO UPDATE[\s\S]*archived\s*=\s*false/)
    expect(code).not.toMatch(/ON CONFLICT\s+DO\s+NOTHING/i)
  })

  it('writes no deals and no contacts (no INSERT/UPDATE/DELETE on either)', () => {
    const code = sqlCode(mig())
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?(deals|contacts)\b/i)
  })

  it('records the measured constants: 159 open waitlist deals and the 62 later-effect contacts', () => {
    expect(mig()).toMatch(/Open waitlist deals at Hatch: 159/)
    expect(mig()).toMatch(/\b62\b[\s\S]{0,80}Hatch-owned contacts linked in un1t_clients/)
  })
})

describe('mig 740 — behaviour (PGlite)', () => {
  it('sets module acquisition_un1t, enabled, not primary, derived, display_order 1 on Hatch acquisition only', async () => {
    await fresh()
    const before = await snapshot()
    await runSql(mig())
    expect(await board('acquisition')).toMatchObject({
      id: P.hatchAcq, module: 'acquisition_un1t', enabled: true, is_primary: false, mode: 'derived', display_order: 1,
    })
    const after = await snapshot()
    expect(after.pipelines.filter((p) => p.id !== P.hatchAcq)).toEqual(before.pipelines.filter((p) => p.id !== P.hatchAcq))
    // No other location's stage row moved.
    expect(after.stages.filter((s) => s.location_id !== HATCH)).toEqual(before.stages.filter((s) => s.location_id !== HATCH))
  })

  it('upserts exactly the 11 stage slugs of shared/pipelines/acquisition.js with on conflict (location_id, slug), archived false', async () => {
    await fresh()
    const idsBefore = Object.fromEntries((await hatchAcqStages()).map((s) => [s.slug, s.id]))
    await runSql(mig())
    const rows = await hatchAcqStages()
    const live = rows.filter((s) => !s.archived)
    expect(live.map((s) => s.slug).sort()).toEqual([...MODULE_SLUGS].sort())
    for (const s of MODULE_STAGES) {
      expect(live.find((r) => r.slug === s.slug)).toMatchObject({
        location_id: HATCH, pipeline_id: P.hatchAcq, name: s.name, display_order: s.display_order, color: s.color, is_dormant: s.is_dormant,
        id: idsBefore[s.slug], // the existing row, updated in place
      })
    }
    // The 7 legacy rows stay archived, untouched.
    expect(rows.filter((s) => s.archived).map((s) => s.slug).sort()).toEqual([...LEGACY_SLUGS].sort())
    // The waitlist stages are untouched.
    expect((await q(`SELECT count(*)::int AS n FROM public.pipeline_stages WHERE pipeline_id = $1 AND NOT archived`, [P.hatchWait]))[0].n).toBe(5)
  })

  it('inserts a module stage Hatch never had', async () => {
    await fresh({ omitHatchSlugs: ['gympass'] })
    await runSql(mig())
    const gympass = (await hatchAcqStages()).find((s) => s.slug === 'gympass')
    expect(gympass).toMatchObject({ pipeline_id: P.hatchAcq, archived: false, name: 'Gympass', is_dormant: true })
  })

  it('waitlist stays Hatch\'s enabled primary; exactly one enabled primary at Hatch', async () => {
    await fresh()
    await runSql(mig())
    expect(await board('waitlist')).toMatchObject({ enabled: true, is_primary: true, display_order: 0, mode: 'manual', module: null })
    const primaries = await q(`SELECT key FROM public.pipelines WHERE location_id = $1 AND enabled AND is_primary`, [HATCH])
    expect(primaries).toEqual([{ key: 'waitlist' }])
  })

  it('creates no deals and writes no contacts', async () => {
    await fresh()
    const before = await snapshot()
    await runSql(mig())
    const after = await snapshot()
    expect(after.deals).toEqual(before.deals)
    expect(after.contacts).toEqual(before.contacts)
  })

  it('is idempotent: a second run passes its self-checks and changes nothing', async () => {
    await fresh()
    await runSql(mig())
    const once = await snapshot()
    await expect(runSql(mig())).resolves.toBeDefined()
    expect(await snapshot()).toEqual(once)
  })

  it('passes whatever the open waitlist count is (replay-safe: the check is "unchanged", not "= 159")', async () => {
    await fresh({ waitlistDeals: 0 })
    await expect(runSql(mig())).resolves.toBeDefined()
    await db.close()
    await fresh({ waitlistDeals: 7 })
    await expect(runSql(mig())).resolves.toBeDefined()
  })

  // Each "raises" test plants a trigger that misbehaves during the migration's
  // own writes, standing in for "the migration moved something it must not".
  // The self-check must catch it and the whole transaction must roll back.
  const expectRaisedAndRolledBack = async (pattern) => {
    const before = await snapshot()
    await expect(runSql(mig())).rejects.toThrow(pattern)
    await db.query('ROLLBACK').catch(() => {})
    const after = await snapshot()
    expect(after).toEqual(before)
    expect((await board('acquisition')).enabled).toBe(false)
  }

  it('self-check raises, and rolls back, when Hatch\'s open waitlist deal count moves (measured 159)', async () => {
    await fresh()
    const contact = uuid('c')
    const entry = (await q(`SELECT id FROM public.pipeline_stages WHERE slug = 'waitlist_new_enquiry'`))[0].id
    await runSql(`
      INSERT INTO public.contacts (id, location_id) VALUES ('${contact}', '${HATCH}');
      CREATE FUNCTION public.plant_waitlist_deal() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        INSERT INTO public.deals (id, contact_id, location_id, pipeline_id, stage_id, status)
        VALUES (gen_random_uuid(), '${contact}', '${HATCH}', '${P.hatchWait}', '${entry}', 'open');
        RETURN NEW;
      END $f$;
      CREATE TRIGGER plant_waitlist_deal AFTER UPDATE ON public.pipelines
        FOR EACH ROW EXECUTE FUNCTION public.plant_waitlist_deal();
    `)
    await expectRaisedAndRolledBack(/Hatch open waitlist deals moved from 3 to 4/)
  })

  it('self-check raises, and rolls back, when a contact is written', async () => {
    await fresh()
    await runSql(`
      CREATE FUNCTION public.touch_contact() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        UPDATE public.contacts SET pipeline_stage_slug = 'new_lead'
         WHERE id = (SELECT id FROM public.contacts WHERE location_id = '${HATCH}' AND pipeline_stage_slug IS NULL LIMIT 1);
        RETURN NEW;
      END $f$;
      CREATE TRIGGER touch_contact AFTER UPDATE ON public.pipelines
        FOR EACH ROW EXECUTE FUNCTION public.touch_contact();
    `)
    await expectRaisedAndRolledBack(/a contacts row changed/)
  })

  it('self-check raises, and rolls back, when a row outside Hatch acquisition\'s 11 stages changes', async () => {
    await fresh()
    await runSql(`
      CREATE FUNCTION public.touch_stillorgan() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        UPDATE public.pipeline_stages SET color = '#FFFFFF' WHERE location_id = '${STILL}' AND slug = 'new_lead';
        RETURN NEW;
      END $f$;
      CREATE TRIGGER touch_stillorgan AFTER UPDATE ON public.pipelines
        FOR EACH ROW EXECUTE FUNCTION public.touch_stillorgan();
    `)
    await expectRaisedAndRolledBack(/a pipelines or pipeline_stages row outside Hatch acquisition's 11 stages changed/)
  })

  it('self-check raises, and rolls back, when a legacy stage would end up live on the board', async () => {
    await fresh()
    await runSql(`
      CREATE FUNCTION public.unarchive_legacy() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        UPDATE public.pipeline_stages SET archived = false WHERE location_id = '${HATCH}' AND slug = 'lapsed';
        RETURN NEW;
      END $f$;
      CREATE TRIGGER unarchive_legacy AFTER UPDATE ON public.pipelines
        FOR EACH ROW EXECUTE FUNCTION public.unarchive_legacy();
    `)
    await expectRaisedAndRolledBack(/Hatch acquisition has 12 live stages, expected 11/)
  })

  it('raises, and rolls back, when Hatch has no acquisition row', async () => {
    await fresh()
    await runSql(`
      DELETE FROM public.deals WHERE pipeline_id = '${P.hatchAcq}';
      DELETE FROM public.pipeline_stages WHERE pipeline_id = '${P.hatchAcq}';
      DELETE FROM public.pipelines WHERE id = '${P.hatchAcq}';
    `)
    const before = await snapshot()
    await expect(runSql(mig())).rejects.toThrow(/Hatch has no acquisition pipelines row/)
    await db.query('ROLLBACK').catch(() => {})
    expect(await snapshot()).toEqual(before)
  })

  it('raises, and rolls back, when the waitlist is no longer Hatch\'s enabled primary', async () => {
    await fresh()
    await runSql(`UPDATE public.pipelines SET is_primary = false WHERE id = '${P.hatchWait}';`)
    const before = await snapshot()
    await expect(runSql(mig())).rejects.toThrow(/Hatch has 0 enabled primary boards, expected exactly 1/)
    await db.query('ROLLBACK').catch(() => {})
    expect(await snapshot()).toEqual(before)
  })
})
