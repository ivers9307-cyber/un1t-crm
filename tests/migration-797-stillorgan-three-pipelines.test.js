// PIPE3.4 — migrations 797 (seed, disabled) and 798 (enable): UN1T Stillorgan's
// €39 Trial and Programmes boards, the pipeline_board_claims table, the
// programme-rules setting, the claim backfill and the pack-stamp clear.
// Spec: docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md
//
// Static checks on the files, plus PGlite with the live constraints (migs 594,
// 597, 150) and a fixture shaped like 31 Oct 2026.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { sqlCode } from './helpers/sql-code.js'

const MIG_797 = path.resolve(import.meta.dirname, '../supabase/migrations/797_stillorgan_three_pipelines.sql')
const MIG_798 = path.resolve(import.meta.dirname, '../supabase/migrations/798_stillorgan_three_pipelines_enable.sql')
const mig797 = () => readFileSync(MIG_797, 'utf8')
const mig798 = () => readFileSync(MIG_798, 'utf8')

const STILL = 'a0000000-0000-0000-0000-000000000001'
const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'

const P = {
  stillAcq: 'e0000000-0000-0000-0000-000000000003',
  stillRet: 'e0000000-0000-0000-0000-000000000004',
  hatchAcq: 'e0000000-0000-0000-0000-000000000001',
  hatchWait: 'e0000000-0000-0000-0000-000000000002',
}
const C = {
  fiftyPlus: 'c0000000-0000-0000-0000-000000000001',   // /50plus lead, last_lead_source meta_50plus
  elites: 'c0000000-0000-0000-0000-000000000002',      // staff-granted Elites Trial, joined 2025
  eliteMember: 'c0000000-0000-0000-0000-000000000003', // "Elite Membership" (a real plan) — never a claim
  buyer: 'c0000000-0000-0000-0000-000000000004',       // granted €39 buyer, stamped as a pack customer after paying
  packer: 'c0000000-0000-0000-0000-000000000005',      // a real pack customer, no purchase row
  hatchLead: 'c0000000-0000-0000-0000-000000000006',   // Hatch-home meta_50plus (never backfilled)
  lateBuyer: 'c0000000-0000-0000-0000-000000000007',   // €39 buyer in September who bought a REAL pack after the trial ended
}

let db
const runSql = (text) => db['exec'](text)
const q = async (text, params) => (await db.query(text, params)).rows

const SCHEMA = `
  -- The two client roles the REVOKE names (Supabase has them; a bare PGlite does not).
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE TABLE public.locations (id uuid PRIMARY KEY, settings jsonb);
  INSERT INTO public.locations VALUES ('${STILL}', '{"glofox": {"branch_id": "x"}}'::jsonb), ('${HATCH}', NULL);

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
    color text DEFAULT '#6B7280',
    is_dormant boolean NOT NULL DEFAULT false,
    archived boolean NOT NULL DEFAULT false,
    CONSTRAINT pipeline_stages_location_slug_unique UNIQUE (location_id, slug),
    CONSTRAINT pipeline_stages_pipeline_name_unique UNIQUE (pipeline_id, name)
  );
  CREATE TABLE public.contacts (
    id uuid PRIMARY KEY, location_id uuid REFERENCES public.locations(id),
    last_lead_source text, last_lead_source_at timestamptz, glofox_membership_plan text,
    joined_at timestamptz, created_at timestamptz NOT NULL DEFAULT '2026-10-01T00:00:00Z',
    pack_customer_at timestamptz, pipeline_stage_slug text
  );
  CREATE TABLE public.trial_purchases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id uuid REFERENCES public.contacts(id), location_id uuid NOT NULL,
    status text NOT NULL, paid_at timestamptz, granted_at timestamptz,
    duration_days integer NOT NULL DEFAULT 14
  );
  CREATE TABLE public.deals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, location_id uuid,
    pipeline_id uuid REFERENCES public.pipelines(id), stage_id uuid REFERENCES public.pipeline_stages(id),
    status text NOT NULL DEFAULT 'open', updated_at timestamptz NOT NULL DEFAULT '2026-10-01T00:00:00Z'
  );

  INSERT INTO public.pipelines (id, location_id, key, name, module, mode, is_primary, display_order, enabled) VALUES
    ('${P.stillAcq}',  '${STILL}', 'acquisition', 'Acquisition', 'acquisition',      'derived', true,  0, true),
    ('${P.stillRet}',  '${STILL}', 'returning',   'Returning',   'returning',        'derived', false, 1, false),
    ('${P.hatchAcq}',  '${HATCH}', 'acquisition', 'Acquisition', 'acquisition_un1t', 'derived', false, 0, true),
    ('${P.hatchWait}', '${HATCH}', 'waitlist',    'Waitlist',    null,               'manual',  true,  1, true);
  INSERT INTO public.pipeline_stages (id, location_id, pipeline_id, name, slug, display_order) VALUES
    ('f0000000-0000-0000-0000-000000000001', '${STILL}', '${P.stillAcq}', 'New Leads', 'new_lead', 301),
    ('f0000000-0000-0000-0000-000000000002', '${STILL}', '${P.stillAcq}', 'Converted', 'converted', 305),
    ('f0000000-0000-0000-0000-000000000003', '${HATCH}', '${P.hatchAcq}', 'New Leads', 'new_lead', 301);

  INSERT INTO public.contacts (id, location_id, last_lead_source, last_lead_source_at, glofox_membership_plan, joined_at, pack_customer_at) VALUES
    ('${C.fiftyPlus}',   '${STILL}', 'meta_50plus', '2026-10-31T22:28:37Z', 'The Elites Trial', '2026-10-31T22:30:38Z', NULL),
    ('${C.elites}',      '${STILL}', NULL,          NULL,                   'The Elites Trial', '2025-09-05T22:09:11Z', NULL),
    ('${C.eliteMember}', '${STILL}', NULL,          NULL,                   'Elite Membership', '2025-10-14T07:27:31Z', NULL),
    ('${C.buyer}',       '${STILL}', 'meta_trial',  '2026-10-30T19:43:52Z', 'The UN1T 14 Day Reset Trial', '2026-10-30T19:44:01Z', '2026-10-30T19:48:20Z'),
    ('${C.packer}',      '${STILL}', NULL,          NULL,                   NULL, '2025-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
    ('${C.hatchLead}',   '${HATCH}', 'meta_50plus', '2026-10-31T10:00:00Z', NULL, NULL, NULL),
    ('${C.lateBuyer}',   '${STILL}', 'meta_trial',  '2026-09-01T10:00:00Z', NULL, '2026-09-01T10:05:00Z', '2026-10-20T12:00:00Z');
  INSERT INTO public.trial_purchases (contact_id, location_id, status, paid_at, granted_at) VALUES
    ('${C.buyer}',  '${STILL}', 'granted',        '2026-10-30T19:43:52Z', '2026-10-30T19:44:05Z'),
    ('${C.packer}', '${STILL}', 'payment_failed', NULL, NULL),
    ('${C.lateBuyer}', '${STILL}', 'granted', '2026-09-01T10:00:00Z', '2026-09-01T10:05:00Z');
  INSERT INTO public.deals (id, contact_id, location_id, pipeline_id, stage_id) VALUES
    ('d0000000-0000-0000-0000-000000000001', '${C.buyer}', '${STILL}', '${P.stillAcq}', 'f0000000-0000-0000-0000-000000000001');
`

async function fresh() {
  db = new PGlite()
  await runSql(SCHEMA)
}
afterEach(async () => { await db?.close(); db = null })

const board = async (key, loc = STILL) => (await q(`SELECT * FROM public.pipelines WHERE location_id = $1 AND key = $2`, [loc, key]))[0]
const stagesOf = async (pipelineId) => q(`SELECT slug, name, display_order, color, is_dormant, archived FROM public.pipeline_stages WHERE pipeline_id = $1 ORDER BY display_order`, [pipelineId])
const claims = async () => q(`SELECT contact_id, board_key, claimed_at, source FROM public.pipeline_board_claims ORDER BY contact_id`)
const snapshotOthers = async () => ({
  hatch: await q(`SELECT * FROM public.pipelines WHERE location_id = $1 ORDER BY id`, [HATCH]),
  deals: await q(`SELECT * FROM public.deals ORDER BY id`),
  hatchContacts: await q(`SELECT * FROM public.contacts WHERE location_id = $1 ORDER BY id`, [HATCH]),
})

describe('mig 797 — static', () => {
  it('creates pipeline_board_claims closed to clients (REVOKE … FROM anon, authenticated; RLS on; no policy)', () => {
    const code = sqlCode(mig797())
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.pipeline_board_claims/i)
    expect(code).toMatch(/ALTER TABLE public\.pipeline_board_claims ENABLE ROW LEVEL SECURITY/i)
    expect(code).toMatch(/REVOKE ALL ON public\.pipeline_board_claims FROM anon, authenticated/i)
    expect(code).not.toMatch(/CREATE POLICY/i)
    expect(code).not.toMatch(/\bGRANT\b/i)
  })
  it('is one transaction with a guarded DO $$ self-check; never assigns is_primary', () => {
    const code = sqlCode(mig797())
    expect(code.match(/^\s*BEGIN;\s*$/gm)).toHaveLength(1)
    expect(code.match(/^\s*COMMIT;\s*$/gm)).toHaveLength(1)
    expect((code.match(/RAISE EXCEPTION/g) || []).length).toBeGreaterThanOrEqual(5)
    expect(code).not.toMatch(/is_primary\s*=\s*(true|false)/i)
    expect(code).toContain(STILL)
    expect(code).not.toContain(HATCH)
  })
  it('inserts the two boards DISABLED', () => {
    const code = sqlCode(mig797())
    const inserts = [...code.matchAll(/INSERT INTO public\.pipelines[\s\S]*?VALUES([\s\S]*?)ON CONFLICT/gi)]
    expect(inserts.length).toBeGreaterThanOrEqual(1)
    for (const [, values] of inserts) expect(values).toMatch(/false\s*\)/)
  })
})

describe('mig 797 — behaviour (PGlite)', () => {
  it('adds €39 Trial (display_order 1) and Programmes (2) at Stillorgan, disabled, derived, not primary', async () => {
    await fresh()
    await runSql(mig797())
    expect(await board('paid_trial')).toMatchObject({ name: '€39 Trial', module: 'paid_trial', mode: 'derived', is_primary: false, display_order: 1, enabled: false })
    expect(await board('programmes')).toMatchObject({ name: 'Programmes', module: 'programmes', mode: 'derived', is_primary: false, display_order: 2, enabled: false })
    expect(await board('acquisition')).toMatchObject({ is_primary: true, enabled: true, display_order: 0 })
  })

  it('seeds 5 + 3 stage rows with the module slugs and display orders 601–605 / 701–703, none dormant', async () => {
    await fresh()
    await runSql(mig797())
    const paid = await stagesOf((await board('paid_trial')).id)
    const prog = await stagesOf((await board('programmes')).id)
    expect(paid.map((s) => [s.slug, s.name, s.display_order])).toEqual([
      ['paid_trial_new_lead', 'New Leads', 601], ['paid_trial_first_class', '1st Class', 602], ['paid_trial_day_7', 'Day 7', 603],
      ['paid_trial_done', 'Trial Done', 604], ['paid_trial_converted', 'Converted', 605],
    ])
    expect(prog.map((s) => [s.slug, s.name, s.display_order])).toEqual([
      ['programme_lead', 'Lead', 701], ['programme_first_class', '1st Class Done', 702], ['programme_converted', 'Converted', 703],
    ])
    for (const s of [...paid, ...prog]) {
      expect(s.is_dormant).toBe(false)
      expect(s.archived).toBe(false)
      expect(s.color).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  it('seeds settings.pipelines.programmes once, keeps sibling keys, and leaves a hand-edited list alone on a re-run', async () => {
    await fresh()
    await runSql(mig797())
    const [{ settings }] = await q(`SELECT settings FROM public.locations WHERE id = $1`, [STILL])
    expect(settings.glofox).toEqual({ branch_id: 'x' })
    expect(settings.pipelines.programmes).toEqual({ lead_sources: ['meta_50plus'], glofox_plan_patterns: ['elites trial'] })
    await q(`UPDATE public.locations SET settings = jsonb_set(settings, '{pipelines,programmes,lead_sources}', '["meta_50plus","meta_postnatal"]'::jsonb) WHERE id = $1`, [STILL])
    await runSql(mig797())
    const [{ settings: after }] = await q(`SELECT settings FROM public.locations WHERE id = $1`, [STILL])
    expect(after.pipelines.programmes.lead_sources).toEqual(['meta_50plus', 'meta_postnatal'])
  })

  it('backfills programmes claims: the meta_50plus lead at last_lead_source_at, the Elites Trial holder at joined_at; never the Elite Membership member or a Hatch contact', async () => {
    await fresh()
    await runSql(mig797())
    const rows = await claims()
    expect(rows.map((r) => r.contact_id)).toEqual([C.fiftyPlus, C.elites])
    expect(rows[0]).toMatchObject({ board_key: 'programmes', source: 'lead_source' })
    expect(new Date(rows[0].claimed_at).toISOString()).toBe('2026-10-31T22:28:37.000Z')
    expect(rows[1]).toMatchObject({ board_key: 'programmes', source: 'glofox_plan' })
    expect(new Date(rows[1].claimed_at).toISOString()).toBe('2025-09-05T22:09:11.000Z')
  })

  it('clears pack_customer_at only when stamped inside the trial window: the fresh buyer yes, a real pack bought after the trial no', async () => {
    await fresh()
    await runSql(mig797())
    const [{ pack_customer_at: buyer }] = await q(`SELECT pack_customer_at FROM public.contacts WHERE id = $1`, [C.buyer])
    const [{ pack_customer_at: packer }] = await q(`SELECT pack_customer_at FROM public.contacts WHERE id = $1`, [C.packer])
    const [{ pack_customer_at: late }] = await q(`SELECT pack_customer_at FROM public.contacts WHERE id = $1`, [C.lateBuyer])
    expect(buyer).toBeNull()
    expect(packer).not.toBeNull()
    expect(late).not.toBeNull()
  })

  it('touches no Hatch row and no deals row', async () => {
    await fresh()
    const before = await snapshotOthers()
    await runSql(mig797())
    expect(await snapshotOthers()).toEqual(before)
  })

  it('is idempotent: a second run passes its self-check and changes nothing', async () => {
    await fresh()
    await runSql(mig797())
    const once = { boards: await q(`SELECT * FROM public.pipelines ORDER BY id`), stages: await q(`SELECT * FROM public.pipeline_stages ORDER BY id`), claims: await claims() }
    await runSql(mig797())
    expect({ boards: await q(`SELECT * FROM public.pipelines ORDER BY id`), stages: await q(`SELECT * FROM public.pipeline_stages ORDER BY id`), claims: await claims() }).toEqual(once)
  })

  it('a re-run never re-enables a board an operator switched off, and never touches is_primary', async () => {
    await fresh()
    await runSql(mig797())
    await runSql(mig798())
    await q(`UPDATE public.pipelines SET enabled = false WHERE location_id = $1 AND key = 'programmes'`, [STILL])
    await runSql(mig797())
    expect((await board('programmes')).enabled).toBe(false)
    expect((await board('paid_trial')).enabled).toBe(true)
    expect((await board('acquisition')).is_primary).toBe(true)
  })

  it('raises and rolls back when Stillorgan has no enabled primary acquisition board', async () => {
    await fresh()
    await q(`UPDATE public.pipelines SET enabled = false WHERE id = $1`, [P.stillAcq])
    await expect(runSql(mig797())).rejects.toThrow(/PIPE3/)
    await db.query('ROLLBACK').catch(() => {})
    expect(await board('paid_trial')).toBeUndefined()
    expect(await q(`SELECT to_regclass('public.pipeline_board_claims') AS t`)).toEqual([{ t: null }])
  })
})

describe('mig 798 — enable (PGlite)', () => {
  it('enables exactly the two boards; acquisition stays the one primary; nothing else changes', async () => {
    await fresh()
    await runSql(mig797())
    const before = await snapshotOthers()
    await runSql(mig798())
    expect((await board('paid_trial')).enabled).toBe(true)
    expect((await board('programmes')).enabled).toBe(true)
    expect(await board('acquisition')).toMatchObject({ is_primary: true, enabled: true })
    expect((await board('returning')).enabled).toBe(false)
    expect(await q(`SELECT count(*)::int AS n FROM public.pipelines WHERE location_id = $1 AND is_primary`, [STILL])).toEqual([{ n: 1 }])
    expect(await snapshotOthers()).toEqual(before)
  })
  it('clears a pack stamp a sync re-made on the buyer between 797 and the deploy', async () => {
    await fresh()
    await runSql(mig797())
    await q(`UPDATE public.contacts SET pack_customer_at = '2026-11-01T03:05:00Z' WHERE id = $1`, [C.buyer])
    await runSql(mig798())
    expect((await q(`SELECT pack_customer_at FROM public.contacts WHERE id = $1`, [C.buyer]))[0].pack_customer_at).toBeNull()
  })
  it('raises when a board is missing (797 not applied)', async () => {
    await fresh()
    await expect(runSql(mig798())).rejects.toThrow(/PIPE3/)
    await db.query('ROLLBACK').catch(() => {})
  })
  it('is idempotent', async () => {
    await fresh()
    await runSql(mig797())
    await runSql(mig798())
    const once = await q(`SELECT * FROM public.pipelines ORDER BY id`)
    await runSql(mig798())
    expect(await q(`SELECT * FROM public.pipelines ORDER BY id`)).toEqual(once)
  })
  it('static: never assigns is_primary, writes only pipelines.enabled and contacts.pack_customer_at', () => {
    const code = sqlCode(mig798())
    expect(code).not.toMatch(/is_primary\s*=\s*(true|false)/i)
    expect(code).not.toMatch(/\b(INSERT\s+INTO|DELETE\s+FROM)\b/i)
    expect(code).not.toMatch(/\bUPDATE\s+(public\.)?(deals|pipeline_stages)\b/i)
  })
})
