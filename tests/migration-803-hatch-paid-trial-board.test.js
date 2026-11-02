// HATCH39 — migrations 803 (the Hatch cutover: Waitlist retired, Acquisition
// primary, €39 board seeded DISABLED, the paid-trial product setting, the
// pack-stamp clear) and 804 (enable the €39 board after the dry run).
// Spec: docs/superpowers/specs/2026-11-01-hatch-paid-trial-board-design.md
//
// PGlite with the live constraints (migs 594, 597, 150) and a fixture shaped
// like 1 Nov 2026: five Waitlist cards of every kind the cutover must handle.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { sqlCode } from './helpers/sql-code.js'

const MIG_803 = path.resolve(import.meta.dirname, '../supabase/migrations/803_hatch_paid_trial_board_waitlist_retired.sql')
const MIG_804 = path.resolve(import.meta.dirname, '../supabase/migrations/804_hatch_paid_trial_board_enable.sql')
const mig803 = () => readFileSync(MIG_803, 'utf8')
const mig804 = () => readFileSync(MIG_804, 'utf8')

const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
const STILL = 'a0000000-0000-0000-0000-000000000001'
const PAID = '674d62bf-4d4b-4231-b1ba-d53543657bea'

const P = {
  hAcq: 'e0000000-0000-0000-0000-000000000001',
  hWait: 'e0000000-0000-0000-0000-000000000002',
  sAcq: 'e0000000-0000-0000-0000-000000000003',
  sPaid: 'e0000000-0000-0000-0000-000000000004',
}
const S = {
  hNew: 'f0000000-0000-0000-0000-000000000001',
  hFirst: 'f0000000-0000-0000-0000-000000000002',
  hWaitNew: 'f0000000-0000-0000-0000-000000000003',
  sNew: 'f0000000-0000-0000-0000-000000000004',
}
const C = {
  onAcq: 'c0000000-0000-0000-0000-000000000001',    // Waitlist + Acquisition card → waitlist closes
  form: 'c0000000-0000-0000-0000-000000000002',     // Waitlist only, form touch, no account → moves
  account: 'c0000000-0000-0000-0000-000000000003',  // Waitlist only, account, no Acquisition card → moves (the pass re-places)
  race: 'c0000000-0000-0000-0000-000000000004',     // Waitlist only, no touch, no account (a race signup) → closes
  packTrial: 'c0000000-0000-0000-0000-000000000005', // pack_customer_at from the €39 trial alone → cleared
  packReal: 'c0000000-0000-0000-0000-000000000006',  // pack_customer_at with a real pack too → kept
  still: 'c0000000-0000-0000-0000-000000000007',
  stillTouch: 'c0000000-0000-0000-0000-000000000008', // Stillorgan-home, a Stillorgan form touch, no Hatch account, a Hatch Waitlist card → closes (no pass would ever touch an Acquisition card of theirs)
}
const D = {
  onAcqAcq: 'd0000000-0000-0000-0000-000000000001',
  onAcqWait: 'd0000000-0000-0000-0000-000000000002',
  formWait: 'd0000000-0000-0000-0000-000000000003',
  accountWait: 'd0000000-0000-0000-0000-000000000004',
  raceWait: 'd0000000-0000-0000-0000-000000000005',
  still: 'd0000000-0000-0000-0000-000000000006',
  stillTouchWait: 'd0000000-0000-0000-0000-000000000007',
  orphanA: 'd0000000-0000-0000-0000-000000000008',  // two open Hatch Acquisition deals with NO contact: the one-open-deal self-check must ignore them
  orphanB: 'd0000000-0000-0000-0000-000000000009',
}

let db
const runSql = (text) => db['exec'](text)
const q = async (text, params) => (await db.query(text, params)).rows

const SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE TABLE public.locations (id uuid PRIMARY KEY, settings jsonb);
  INSERT INTO public.locations VALUES ('${HATCH}', '{"un1t_online": {"writes_enabled": true}}'::jsonb), ('${STILL}', '{}'::jsonb);

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
    last_lead_source_at timestamptz, created_at timestamptz NOT NULL DEFAULT '2026-10-01T00:00:00Z',
    pack_customer_at timestamptz, pipeline_stage_slug text
  );
  CREATE TABLE public.un1t_clients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, contact_id uuid, un1t_user_id text);
  CREATE TABLE public.un1t_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, contact_id uuid, un1t_user_id text,
    product_id text, product_type text, amount_cents integer, refunded boolean NOT NULL DEFAULT false, remote_created_at timestamptz
  );
  CREATE TABLE public.deals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, location_id uuid,
    pipeline_id uuid REFERENCES public.pipelines(id), stage_id uuid REFERENCES public.pipeline_stages(id),
    status text NOT NULL DEFAULT 'open', updated_at timestamptz NOT NULL DEFAULT '2026-10-01T00:00:00Z',
    created_at timestamptz NOT NULL DEFAULT '2026-10-01T00:00:00Z'
  );
  -- mig 598: one open deal per person per board
  CREATE UNIQUE INDEX deals_one_open_per_contact_pipeline ON public.deals (contact_id, pipeline_id) WHERE status = 'open';
  -- mig 736: contacts.pipeline_stage_slug follows the enabled primary, then any enabled board, else stays
  CREATE OR REPLACE FUNCTION public.sync_contacts_pipeline_stage_slug() RETURNS trigger LANGUAGE plpgsql AS $fn$
  DECLARE v_contact_id uuid; v_loc uuid; v_slug text;
  BEGIN
    v_contact_id := COALESCE(NEW.contact_id, OLD.contact_id);
    IF v_contact_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
    v_loc := (SELECT location_id FROM contacts WHERE id = v_contact_id);
    SELECT ps.slug INTO v_slug FROM deals d JOIN pipeline_stages ps ON ps.id = d.stage_id JOIN pipelines p ON p.id = ps.pipeline_id
     WHERE d.contact_id = v_contact_id AND d.status = 'open' AND p.location_id = v_loc AND p.enabled AND p.is_primary
     ORDER BY d.created_at DESC, d.id DESC LIMIT 1;
    IF v_slug IS NULL THEN
      SELECT ps.slug INTO v_slug FROM deals d JOIN pipeline_stages ps ON ps.id = d.stage_id JOIN pipelines p ON p.id = ps.pipeline_id
       WHERE d.contact_id = v_contact_id AND d.status = 'open' AND p.location_id = v_loc AND p.enabled
       ORDER BY d.created_at DESC, d.id DESC LIMIT 1;
    END IF;
    IF v_slug IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
    UPDATE contacts SET pipeline_stage_slug = v_slug WHERE id = v_contact_id AND pipeline_stage_slug IS DISTINCT FROM v_slug;
    RETURN COALESCE(NEW, OLD);
  END $fn$;
  CREATE TRIGGER deals_sync_pipeline_stage_slug AFTER INSERT OR UPDATE OR DELETE ON public.deals FOR EACH ROW EXECUTE FUNCTION public.sync_contacts_pipeline_stage_slug();

  INSERT INTO public.pipelines (id, location_id, key, name, module, mode, is_primary, display_order, enabled) VALUES
    ('${P.hAcq}',  '${HATCH}', 'acquisition', 'Acquisition', 'acquisition_un1t', 'derived', false, 0, true),
    ('${P.hWait}', '${HATCH}', 'waitlist',    'Waitlist',    null,               'manual',  true,  1, true),
    ('${P.sAcq}',  '${STILL}', 'acquisition', 'Acquisition', 'acquisition',      'derived', true,  0, true),
    ('${P.sPaid}', '${STILL}', 'paid_trial',  '€39 Trial',   'paid_trial',       'derived', false, 1, true);
  INSERT INTO public.pipeline_stages (id, location_id, pipeline_id, name, slug, display_order) VALUES
    ('${S.hNew}',     '${HATCH}', '${P.hAcq}',  'New Leads',   'new_lead',             301),
    ('${S.hFirst}',   '${HATCH}', '${P.hAcq}',  '1st Class',   'first_class',          302),
    ('${S.hWaitNew}', '${HATCH}', '${P.hWait}', 'New Enquiry', 'waitlist_new_enquiry', 501),
    ('${S.sNew}',     '${STILL}', '${P.sAcq}',  'New Leads',   'new_lead',             301);

  INSERT INTO public.contacts (id, location_id, last_lead_source_at, pack_customer_at, pipeline_stage_slug) VALUES
    ('${C.onAcq}',     '${HATCH}', '2026-10-20T10:00:00Z', NULL, 'first_class'),
    ('${C.form}',      '${HATCH}', '2026-10-25T10:00:00Z', NULL, 'waitlist_new_enquiry'),
    ('${C.account}',   '${HATCH}', NULL,                   NULL, 'waitlist_new_enquiry'),
    ('${C.race}',      '${HATCH}', NULL,                   NULL, 'waitlist_new_enquiry'),
    ('${C.packTrial}', '${HATCH}', NULL, '2026-10-20T10:05:00Z', NULL),
    ('${C.packReal}',  '${HATCH}', NULL, '2026-09-01T10:05:00Z', NULL),
    ('${C.still}',     '${STILL}', NULL,                   NULL, 'new_lead'),
    ('${C.stillTouch}','${STILL}', '2026-10-26T10:00:00Z', NULL, 'new_lead');
  INSERT INTO public.un1t_clients (location_id, contact_id, un1t_user_id) VALUES
    ('${HATCH}', '${C.account}', 'u-account'), ('${HATCH}', '${C.packTrial}', 'u-pt'), ('${HATCH}', '${C.packReal}', 'u-pr');
  INSERT INTO public.un1t_transactions (location_id, contact_id, un1t_user_id, product_id, product_type, amount_cents, remote_created_at) VALUES
    ('${HATCH}', '${C.packTrial}', 'u-pt', '${PAID}', 'pack', 3900, '2026-10-20T10:00:00Z'),
    ('${HATCH}', '${C.packReal}',  'u-pr', '${PAID}', 'pack', 3900, '2026-10-20T10:00:00Z'),
    ('${HATCH}', '${C.packReal}',  'u-pr', 'real-5-pack', 'pack', 6000, '2026-09-01T10:00:00Z');
  INSERT INTO public.deals (id, contact_id, location_id, pipeline_id, stage_id) VALUES
    ('${D.onAcqAcq}',   '${C.onAcq}',   '${HATCH}', '${P.hAcq}',  '${S.hFirst}'),
    ('${D.onAcqWait}',  '${C.onAcq}',   '${HATCH}', '${P.hWait}', '${S.hWaitNew}'),
    ('${D.formWait}',   '${C.form}',    '${HATCH}', '${P.hWait}', '${S.hWaitNew}'),
    ('${D.accountWait}','${C.account}', '${HATCH}', '${P.hWait}', '${S.hWaitNew}'),
    ('${D.raceWait}',   '${C.race}',    '${HATCH}', '${P.hWait}', '${S.hWaitNew}'),
    ('${D.still}',      '${C.still}',   '${STILL}', '${P.sAcq}',  '${S.sNew}'),
    ('${D.stillTouchWait}', '${C.stillTouch}', '${HATCH}', '${P.hWait}', '${S.hWaitNew}'),
    ('${D.orphanA}',    NULL,           '${HATCH}', '${P.hAcq}',  '${S.hNew}'),
    ('${D.orphanB}',    NULL,           '${HATCH}', '${P.hAcq}',  '${S.hNew}');
`

async function fresh() { db = new PGlite(); await runSql(SCHEMA) }
afterEach(async () => { await db?.close(); db = null })

const board = async (key, loc = HATCH) => (await q(`SELECT * FROM public.pipelines WHERE location_id = $1 AND key = $2`, [loc, key]))[0]
const deal = async (id) => (await q(`SELECT * FROM public.deals WHERE id = $1`, [id]))[0]
const stillSnapshot = async () => ({
  pipelines: await q(`SELECT * FROM public.pipelines WHERE location_id = $1 ORDER BY id`, [STILL]),
  deals: await q(`SELECT * FROM public.deals WHERE location_id = $1 ORDER BY id`, [STILL]),
  contacts: await q(`SELECT * FROM public.contacts WHERE location_id = $1 ORDER BY id`, [STILL]),
})

describe('mig 803 — static', () => {
  it('is one transaction with a guarded DO $$ self-check, scoped to Hatch, never naming Stillorgan', () => {
    const code = sqlCode(mig803())
    expect(code.match(/^\s*BEGIN;\s*$/gm)).toHaveLength(1)
    expect(code.match(/^\s*COMMIT;\s*$/gm)).toHaveLength(1)
    expect((code.match(/RAISE EXCEPTION/g) || []).length).toBeGreaterThanOrEqual(5)
    expect(code).toContain(HATCH)
    expect(code).not.toContain(STILL)
  })
  it('assigns is_primary only as acquisition true and waitlist false, and inserts the €39 board disabled', () => {
    const code = sqlCode(mig803())
    const assigns = [...code.matchAll(/is_primary\s*=\s*(true|false)/gi)].map((m) => m[1].toLowerCase())
    expect(assigns.sort()).toEqual(['false', 'true'])
    const inserts = [...code.matchAll(/INSERT INTO public\.pipelines[\s\S]*?VALUES([\s\S]*?)ON CONFLICT/gi)]
    expect(inserts.length).toBe(1)
    expect(inserts[0][1]).toMatch(/false\s*\)/)
  })
  it('creates no relation: grant: none', () => {
    expect(mig803()).toMatch(/^-- grant: none/m)
    expect(sqlCode(mig803())).not.toMatch(/CREATE TABLE/i)
  })
})

describe('mig 803 — behaviour (PGlite)', () => {
  it('seeds the €39 Trial board DISABLED at display_order 1 with 5 stages (601–605); the Waitlist goes to 2', async () => {
    await fresh(); await runSql(mig803())
    expect(await board('paid_trial')).toMatchObject({ name: '€39 Trial', module: 'paid_trial_un1t', mode: 'derived', is_primary: false, display_order: 1, enabled: false })
    const stages = await q(`SELECT slug, display_order, is_dormant FROM public.pipeline_stages WHERE pipeline_id = $1 ORDER BY display_order`, [(await board('paid_trial')).id])
    expect(stages.map((s) => [s.slug, s.display_order])).toEqual([
      ['paid_trial_new_lead', 601], ['paid_trial_first_class', 602], ['paid_trial_day_7', 603], ['paid_trial_done', 604], ['paid_trial_converted', 605],
    ])
    expect(stages.every((s) => s.is_dormant === false)).toBe(true)
    expect(await board('waitlist')).toMatchObject({ display_order: 2 })
  })
  it('retires the Waitlist (disabled, not primary) and makes Acquisition the one enabled primary', async () => {
    await fresh(); await runSql(mig803())
    expect(await board('waitlist')).toMatchObject({ enabled: false, is_primary: false, mode: 'manual' })
    expect(await board('acquisition')).toMatchObject({ enabled: true, is_primary: true, display_order: 0 })
    expect(await q(`SELECT count(*)::int AS n FROM public.pipelines WHERE location_id = $1 AND is_primary`, [HATCH])).toEqual([{ n: 1 }])
  })
  it('Waitlist cards: closes the one whose person is on Acquisition, moves the form enquiry and the account holder to Acquisition New Leads, closes the race signup; none stays open', async () => {
    await fresh(); await runSql(mig803())
    expect(await deal(D.onAcqWait)).toMatchObject({ status: 'lost', pipeline_id: P.hWait })
    expect(await deal(D.onAcqAcq)).toMatchObject({ status: 'open', pipeline_id: P.hAcq, stage_id: S.hFirst })
    expect(await deal(D.formWait)).toMatchObject({ status: 'open', pipeline_id: P.hAcq, stage_id: S.hNew })
    expect(await deal(D.accountWait)).toMatchObject({ status: 'open', pipeline_id: P.hAcq, stage_id: S.hNew })
    expect(await deal(D.raceWait)).toMatchObject({ status: 'lost', pipeline_id: P.hWait })
    // a Stillorgan-home person with only a Stillorgan form touch gets no Hatch card: the Hatch pass never loads them
    expect(await deal(D.stillTouchWait)).toMatchObject({ status: 'lost', pipeline_id: P.hWait })
    expect(await q(`SELECT count(*)::int AS n FROM public.deals WHERE pipeline_id = $1 AND status = 'open'`, [P.hWait])).toEqual([{ n: 0 }])
    // the two contact-less Acquisition deals are not a "two open deals per person" failure
    expect(await deal(D.orphanA)).toMatchObject({ status: 'open' })
    // one open deal per person at Hatch
    const dup = await q(`SELECT contact_id FROM public.deals WHERE location_id = $1 AND status = 'open' GROUP BY contact_id HAVING count(*) > 1`, [HATCH])
    expect(dup.filter((r) => r.contact_id !== null)).toEqual([])
  })
  it('contacts.pipeline_stage_slug re-derives off the acquisition deal (mig 736), and a person left with no card loses the retired board\'s slug', async () => {
    await fresh(); await runSql(mig803())
    const slug = async (id) => (await q(`SELECT pipeline_stage_slug FROM public.contacts WHERE id = $1`, [id]))[0].pipeline_stage_slug
    expect(await slug(C.onAcq)).toBe('first_class')
    expect(await slug(C.form)).toBe('new_lead')
    expect(await slug(C.account)).toBe('new_lead')
    expect(await slug(C.race)).toBeNull()
    expect(await slug(C.stillTouch)).toBe('new_lead')   // their own studio's slug, untouched
    expect(await slug(C.still)).toBe('new_lead')
  })
  it('seeds settings.pipelines.paid_trial.un1t_product_ids once, keeping sibling keys and a hand-edited list', async () => {
    await fresh(); await runSql(mig803())
    const [{ settings }] = await q(`SELECT settings FROM public.locations WHERE id = $1`, [HATCH])
    expect(settings.un1t_online).toEqual({ writes_enabled: true })
    expect(settings.pipelines.paid_trial.un1t_product_ids).toEqual([PAID])
    await q(`UPDATE public.locations SET settings = jsonb_set(settings, '{pipelines,paid_trial,un1t_product_ids}', '["x","y"]'::jsonb) WHERE id = $1`, [HATCH])
    await runSql(mig803())
    expect((await q(`SELECT settings FROM public.locations WHERE id = $1`, [HATCH]))[0].settings.pipelines.paid_trial.un1t_product_ids).toEqual(['x', 'y'])
  })
  it('clears pack_customer_at only where every paid pack transaction is the paid trial', async () => {
    await fresh(); await runSql(mig803())
    expect((await q(`SELECT pack_customer_at FROM public.contacts WHERE id = $1`, [C.packTrial]))[0].pack_customer_at).toBeNull()
    expect((await q(`SELECT pack_customer_at FROM public.contacts WHERE id = $1`, [C.packReal]))[0].pack_customer_at).not.toBeNull()
  })
  it('touches nothing at Stillorgan', async () => {
    await fresh(); const before = await stillSnapshot(); await runSql(mig803())
    expect(await stillSnapshot()).toEqual(before)
  })
  it('is idempotent', async () => {
    await fresh(); await runSql(mig803())
    const once = { p: await q(`SELECT * FROM public.pipelines ORDER BY id`), d: await q(`SELECT * FROM public.deals ORDER BY id`), s: await q(`SELECT * FROM public.pipeline_stages ORDER BY id`) }
    await runSql(mig803())
    expect({ p: await q(`SELECT * FROM public.pipelines ORDER BY id`), d: await q(`SELECT * FROM public.deals ORDER BY id`), s: await q(`SELECT * FROM public.pipeline_stages ORDER BY id`) }).toEqual(once)
  })
  it('raises and rolls back when Acquisition has no live New Leads column to move the cards to', async () => {
    await fresh()
    await q(`UPDATE public.pipeline_stages SET archived = true WHERE id = $1`, [S.hNew])
    await expect(runSql(mig803())).rejects.toThrow(/HATCH39/)
    await db.query('ROLLBACK').catch(() => {})
    expect(await board('waitlist')).toMatchObject({ enabled: true, is_primary: true })
    expect(await deal(D.formWait)).toMatchObject({ status: 'open', pipeline_id: P.hWait })
  })
  it('raises and rolls back when Hatch has no acquisition board', async () => {
    await fresh()
    await q(`DELETE FROM public.deals WHERE pipeline_id = $1`, [P.hAcq])
    await q(`DELETE FROM public.pipeline_stages WHERE pipeline_id = $1`, [P.hAcq])
    await q(`DELETE FROM public.pipelines WHERE id = $1`, [P.hAcq])
    await expect(runSql(mig803())).rejects.toThrow(/HATCH39/)
    await db.query('ROLLBACK').catch(() => {})
  })
})

describe('mig 804 — enable (PGlite)', () => {
  it('enables the €39 board; Acquisition stays the one primary; the Waitlist stays off; nothing else changes', async () => {
    await fresh(); await runSql(mig803()); const before = await stillSnapshot()
    await runSql(mig804())
    expect(await board('paid_trial')).toMatchObject({ enabled: true, is_primary: false })
    expect(await board('acquisition')).toMatchObject({ enabled: true, is_primary: true })
    expect(await board('waitlist')).toMatchObject({ enabled: false })
    expect(await q(`SELECT count(*)::int AS n FROM public.pipelines WHERE location_id = $1 AND enabled`, [HATCH])).toEqual([{ n: 2 }])
    expect(await stillSnapshot()).toEqual(before)
  })
  it('raises without 803; is idempotent', async () => {
    await fresh()
    await expect(runSql(mig804())).rejects.toThrow(/HATCH39/)
    await db.query('ROLLBACK').catch(() => {})
    await runSql(mig803()); await runSql(mig804())
    const once = await q(`SELECT * FROM public.pipelines ORDER BY id`)
    await runSql(mig804())
    expect(await q(`SELECT * FROM public.pipelines ORDER BY id`)).toEqual(once)
  })
  it('static: never assigns is_primary; grant: none', () => {
    expect(sqlCode(mig804())).not.toMatch(/is_primary\s*=\s*(true|false)/i)
    expect(mig804()).toMatch(/^-- grant: none/m)
  })
})
