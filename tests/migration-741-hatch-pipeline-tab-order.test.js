// HATCHPIPE.4 — migration 741: UN1T Hatch Street opens on its Acquisition board.
// The tabs and the default board come from `pipelines.display_order` (the web
// page takes the first enabled board when there is no ?pipeline=, the phone
// orders the same way), so this is a DATA-ONLY flip: acquisition 1 -> 0,
// waitlist 0 -> 1. `is_primary` must NOT move: the waitlist stays the primary,
// because the primary decides contacts.pipeline_stage_slug (mig 736) and the
// phone's default deal lookup.
//
// Static checks on the file, plus PGlite with the live `pipelines` constraints
// (mig 594) and a fixture shaped like 18 Oct 2026 after mig 740: Hatch
// acquisition enabled/non-primary at 1, Hatch waitlist the enabled primary at 0,
// Stillorgan, and a disabled-board studio.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { sqlCode } from './helpers/sql-code.js'

const MIG_PATH = path.resolve(import.meta.dirname, '../supabase/migrations/741_hatch_pipeline_tab_order.sql')
// Read per test, so a missing file fails each test on its own.
const mig = () => readFileSync(MIG_PATH, 'utf8')

const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4' // hard-coded in the migration, as in migs 597/598/736/740
const STILL = 'a0000000-0000-0000-0000-000000000001'
const CCF = 'c0000000-0000-0000-0000-0000000000c1'

const P = {
  hatchAcq: 'e0000000-0000-0000-0000-000000000001',
  hatchWait: 'e0000000-0000-0000-0000-000000000002',
  stillAcq: 'e0000000-0000-0000-0000-000000000003',
  stillRet: 'e0000000-0000-0000-0000-000000000004',
  ccfAcq: 'e0000000-0000-0000-0000-000000000005',
}

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)
const q = async (text, params) => (await db.query(text, params)).rows

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

  CREATE TABLE public.pipeline_stages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id),
    pipeline_id uuid NOT NULL REFERENCES public.pipelines(id),
    name text NOT NULL, slug text NOT NULL, display_order int NOT NULL,
    archived boolean NOT NULL DEFAULT false
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
    ('${P.hatchAcq}',  '${HATCH}', 'acquisition', 'Acquisition', 'acquisition_un1t', 'derived', false, 1, true),
    ('${P.hatchWait}', '${HATCH}', 'waitlist',    'Waitlist',    null,               'manual',  true,  0, true),
    ('${P.stillAcq}',  '${STILL}', 'acquisition', 'Acquisition', 'acquisition',      'derived', true,  0, true),
    ('${P.stillRet}',  '${STILL}', 'returning',   'Returning',   'returning',        'derived', false, 1, false),
    ('${P.ccfAcq}',    '${CCF}',   'acquisition', 'Acquisition', 'acquisition',      'derived', true,  0, false);

  INSERT INTO public.pipeline_stages (id, location_id, pipeline_id, name, slug, display_order) VALUES
    ('f0000000-0000-0000-0000-000000000001', '${HATCH}', '${P.hatchWait}', 'New', 'waitlist_new_enquiry', 501),
    ('f0000000-0000-0000-0000-000000000002', '${HATCH}', '${P.hatchAcq}',  'New Leads', 'new_lead', 301);
  INSERT INTO public.contacts (id, location_id, pipeline_stage_slug) VALUES
    ('c0000000-0000-0000-0000-000000000001', '${HATCH}', 'waitlist_new_enquiry');
  INSERT INTO public.deals (id, contact_id, location_id, pipeline_id, stage_id) VALUES
    ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', '${HATCH}', '${P.hatchWait}', 'f0000000-0000-0000-0000-000000000001');
`

async function fresh() {
  db = new PGlite()
  await runSql(SCHEMA)
}

const snapshot = async () => ({
  pipelines: await q(`SELECT * FROM public.pipelines ORDER BY id`),
  stages: await q(`SELECT * FROM public.pipeline_stages ORDER BY id`),
  deals: await q(`SELECT * FROM public.deals ORDER BY id`),
  contacts: await q(`SELECT * FROM public.contacts ORDER BY id`),
})
const board = async (key, loc = HATCH) => (await q(`SELECT * FROM public.pipelines WHERE location_id = $1 AND key = $2`, [loc, key]))[0]

afterEach(async () => { await db?.close(); db = null })

describe('mig 741 — static', () => {
  it('states -- grant: none (no new relation)', () => {
    expect(mig()).toMatch(/^-- grant: none \(no new relation\)$/m)
  })

  it('is one transaction with a guarded DO $$ post-state self-check', () => {
    const code = sqlCode(mig())
    expect(code.match(/^\s*BEGIN;\s*$/gm)).toHaveLength(1)
    expect(code.match(/^\s*COMMIT;\s*$/gm)).toHaveLength(1)
    expect(code).toMatch(/DO \$\$/)
    expect((code.match(/RAISE EXCEPTION/g) || []).length).toBeGreaterThanOrEqual(4)
  })

  it('is scoped to Hatch Street by id and writes only pipelines.display_order', () => {
    const code = sqlCode(mig())
    expect(code).toContain(HATCH)
    expect(code).not.toContain(STILL)
    expect(code).not.toMatch(/\b(INSERT\s+INTO|DELETE\s+FROM)\b/i)
    expect(code).not.toMatch(/\bUPDATE\s+(public\.)?(deals|contacts|pipeline_stages)\b/i)
    // The one write: UPDATE public.pipelines SET display_order ... and nothing else in SET.
    const updates = [...code.matchAll(/UPDATE\s+public\.pipelines\s+SET([\s\S]*?)WHERE/gi)]
    expect(updates.length).toBeGreaterThanOrEqual(1)
    for (const [, set] of updates) expect(set).not.toMatch(/is_primary|enabled|mode|module|\bkey\b/i)
  })

  it('never assigns is_primary', () => {
    expect(sqlCode(mig())).not.toMatch(/is_primary\s*=/i)
  })
})

describe('mig 741 — behaviour (PGlite)', () => {
  it('flips Hatch: acquisition display_order 0, waitlist display_order 1', async () => {
    await fresh()
    await runSql(mig())
    expect((await board('acquisition')).display_order).toBe(0)
    expect((await board('waitlist')).display_order).toBe(1)
    // The page and the phone order by display_order: acquisition is the first tab.
    const order = await q(`SELECT key FROM public.pipelines WHERE location_id = $1 AND enabled ORDER BY display_order`, [HATCH])
    expect(order.map((r) => r.key)).toEqual(['acquisition', 'waitlist'])
  })

  it('leaves is_primary (and every other column) unchanged: the waitlist stays the primary', async () => {
    await fresh()
    const before = await snapshot()
    await runSql(mig())
    expect(await board('waitlist')).toMatchObject({ is_primary: true, enabled: true, mode: 'manual', module: null })
    expect(await board('acquisition')).toMatchObject({ is_primary: false, enabled: true, mode: 'derived', module: 'acquisition_un1t' })
    const strip = (rows) => rows.map(({ display_order: _order, ...rest }) => rest)
    const after = await snapshot()
    expect(strip(after.pipelines)).toEqual(strip(before.pipelines))
    const primaries = await q(`SELECT key FROM public.pipelines WHERE location_id = $1 AND enabled AND is_primary`, [HATCH])
    expect(primaries).toEqual([{ key: 'waitlist' }])
  })

  it('touches no other location: Stillorgan and CCF pipelines are identical', async () => {
    await fresh()
    const before = await snapshot()
    await runSql(mig())
    const after = await snapshot()
    const others = (s) => s.pipelines.filter((p) => p.location_id !== HATCH)
    expect(others(after)).toEqual(others(before))
    // And nothing outside pipelines.display_order moved.
    expect(after.stages).toEqual(before.stages)
    expect(after.deals).toEqual(before.deals)
    expect(after.contacts).toEqual(before.contacts)
  })

  it('is idempotent: a second run passes its self-check and changes nothing', async () => {
    await fresh()
    await runSql(mig())
    const once = await snapshot()
    await expect(runSql(mig())).resolves.toBeDefined()
    expect(await snapshot()).toEqual(once)
  })

  it('raises, and rolls back, when Hatch has no waitlist row', async () => {
    await fresh()
    await runSql(`DELETE FROM public.deals; DELETE FROM public.pipeline_stages WHERE pipeline_id = '${P.hatchWait}'; DELETE FROM public.pipelines WHERE id = '${P.hatchWait}';`)
    const before = await snapshot()
    await expect(runSql(mig())).rejects.toThrow(/Hatch has no waitlist pipelines row/)
    await db.query('ROLLBACK').catch(() => {})
    expect(await snapshot()).toEqual(before)
  })

  it('raises, and rolls back, when Hatch has no acquisition row', async () => {
    await fresh()
    await runSql(`DELETE FROM public.pipeline_stages WHERE pipeline_id = '${P.hatchAcq}'; DELETE FROM public.pipelines WHERE id = '${P.hatchAcq}';`)
    const before = await snapshot()
    await expect(runSql(mig())).rejects.toThrow(/Hatch has no acquisition pipelines row/)
    await db.query('ROLLBACK').catch(() => {})
    expect(await snapshot()).toEqual(before)
  })

  it('raises, and rolls back, when Hatch has no enabled primary at all', async () => {
    await fresh()
    await runSql(`UPDATE public.pipelines SET is_primary = false WHERE id = '${P.hatchWait}';`)
    const before = await snapshot()
    await expect(runSql(mig())).rejects.toThrow(/Hatch has 0 enabled primary boards, expected exactly 1/)
    await db.query('ROLLBACK').catch(() => {})
    expect(await snapshot()).toEqual(before)
  })

  it('raises, and rolls back, when the one enabled primary is not the waitlist', async () => {
    await fresh()
    await runSql(`
      UPDATE public.pipelines SET is_primary = false WHERE id = '${P.hatchWait}';
      UPDATE public.pipelines SET is_primary = true WHERE id = '${P.hatchAcq}';
    `)
    const before = await snapshot()
    await expect(runSql(mig())).rejects.toThrow(/the waitlist board is not Hatch's enabled primary/)
    await db.query('ROLLBACK').catch(() => {})
    expect(await snapshot()).toEqual(before)
  })

  // A trigger that misbehaves during the migration's own write stands in for
  // "the migration moved something it must not"; the self-check must catch it.
  it('self-check raises, and rolls back, when a row outside the two Hatch boards changes', async () => {
    await fresh()
    await runSql(`
      CREATE FUNCTION public.touch_stillorgan() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        UPDATE public.pipelines SET display_order = 9 WHERE id = '${P.stillRet}';
        RETURN NEW;
      END $f$;
      CREATE TRIGGER touch_stillorgan AFTER UPDATE ON public.pipelines
        FOR EACH ROW WHEN (NEW.id = '${P.hatchAcq}') EXECUTE FUNCTION public.touch_stillorgan();
    `)
    const before = await snapshot()
    await expect(runSql(mig())).rejects.toThrow(/a pipelines row outside Hatch's acquisition and waitlist changed/)
    await db.query('ROLLBACK').catch(() => {})
    expect(await snapshot()).toEqual(before)
  })

  it('self-check raises, and rolls back, when a trigger moves is_primary on the waitlist', async () => {
    await fresh()
    await runSql(`
      CREATE FUNCTION public.steal_primary() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        UPDATE public.pipelines SET is_primary = false WHERE id = '${P.hatchWait}' AND is_primary;
        RETURN NEW;
      END $f$;
      CREATE TRIGGER steal_primary AFTER UPDATE ON public.pipelines
        FOR EACH ROW WHEN (NEW.id = '${P.hatchAcq}') EXECUTE FUNCTION public.steal_primary();
    `)
    const before = await snapshot()
    await expect(runSql(mig())).rejects.toThrow(/enabled primary/)
    await db.query('ROLLBACK').catch(() => {})
    expect(await snapshot()).toEqual(before)
  })
})
