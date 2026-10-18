// WAORGNUMBER.2 — behavioural test for migration 745: whatsapp_templates gains
// business_account_id (backfilled from the studio's link-default number), a unique
// (WABA, name, language) index and a unique meta_template_id index (design R5).
// Loads the REAL 745 file into PGlite over the columns of the tables it touches.
// The link table mirrors mig 743's shape. Fictional ids only: the repo is public.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_745 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/745_wa_templates_waba.sql'), 'utf8')

const STILL = 'a0000000-0000-0000-0000-000000000001'
const HATCH = 'a0000000-0000-0000-0000-000000000002'
const BARE = 'a0000000-0000-0000-0000-000000000003'
const N1 = 'f0000000-0000-0000-0000-000000000001'
const N2 = 'f0000000-0000-0000-0000-000000000002'
const N3 = 'f0000000-0000-0000-0000-000000000003'
const WABA_A = '100000000000001'
const WABA_B = '100000000000002'

const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.whatsapp_numbers (id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES public.locations(id),
    business_account_id text, is_active boolean NOT NULL DEFAULT true, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.location_whatsapp_numbers (
    location_id uuid NOT NULL REFERENCES public.locations(id), whatsapp_number_id uuid NOT NULL REFERENCES public.whatsapp_numbers(id),
    is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (location_id, whatsapp_number_id));
  CREATE TABLE public.whatsapp_templates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid REFERENCES public.locations(id), name text NOT NULL, meta_template_id text, language text DEFAULT 'en');
  GRANT SELECT ON public.whatsapp_templates TO authenticated;
  INSERT INTO public.locations VALUES ('${STILL}'), ('${HATCH}'), ('${BARE}');
`
async function boot(extra = '', { run = true } = {}) {
  const db = new PGlite()
  await db.exec(SCHEMA)
  if (extra) await db.exec(extra)
  if (run) await db.exec(MIG_745)
  return db
}
const rows = async (db, sql) => (await db.query(sql)).rows
const tpl = (loc, name, meta = 'NULL', lang = 'en') =>
  `INSERT INTO public.whatsapp_templates (location_id, name, meta_template_id, language) VALUES ('${loc}', '${name}', ${meta === 'NULL' ? 'NULL' : `'${meta}'`}, '${lang}');`

describe('745 whatsapp_templates WABA', () => {
  it('backfills the WABA from the link-default number', async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_numbers (id, location_id, business_account_id) VALUES ('${N1}', '${STILL}', '${WABA_A}'), ('${N2}', '${STILL}', '${WABA_B}');
      INSERT INTO public.location_whatsapp_numbers VALUES ('${STILL}', '${N1}', true, now() - interval '1 day'), ('${STILL}', '${N2}', false, now());
      ${tpl(STILL, 'welcome', 'm1')} ${tpl(BARE, 'orphan', 'm2')}`)
    expect(await rows(db, `SELECT name, business_account_id FROM whatsapp_templates ORDER BY name`))
      .toEqual([{ name: 'orphan', business_account_id: null }, { name: 'welcome', business_account_id: WABA_A }])
  })

  it('falls back to a switched-on number when the studio has no default link, skipping numbers with no WABA', async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_numbers (id, location_id, business_account_id) VALUES ('${N1}', '${HATCH}', NULL), ('${N2}', '${HATCH}', '${WABA_B}');
      INSERT INTO public.location_whatsapp_numbers VALUES ('${HATCH}', '${N1}', false, now()), ('${HATCH}', '${N2}', false, now() - interval '1 day');
      ${tpl(HATCH, 'hatch_offer', 'm3')}`)
    expect(await rows(db, `SELECT business_account_id FROM whatsapp_templates`)).toEqual([{ business_account_id: WABA_B }])
  })

  it("a deactivated number's WABA is not used by the fallback", async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_numbers (id, location_id, business_account_id, is_active) VALUES
        ('${N1}', '${HATCH}', '${WABA_A}', false), ('${N2}', '${HATCH}', '${WABA_B}', true),
        ('${N3}', '${STILL}', '${WABA_A}', false);
      INSERT INTO public.location_whatsapp_numbers VALUES
        ('${HATCH}', '${N1}', true, now()), ('${HATCH}', '${N2}', false, now() - interval '1 day'), ('${STILL}', '${N3}', true, now());
      ${tpl(HATCH, 'hatch_offer', 'm3')} ${tpl(STILL, 'welcome', 'm4')}`)
    // Hatch's default link is inactive: the active non-default number's WABA is used; Stillorgan has only an inactive one: NULL.
    expect(await rows(db, `SELECT name, business_account_id FROM whatsapp_templates ORDER BY name`))
      .toEqual([{ name: 'hatch_offer', business_account_id: WABA_B }, { name: 'welcome', business_account_id: null }])
  })

  it('refuses a duplicate name on one WABA across studios', async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_numbers (id, location_id, business_account_id) VALUES ('${N1}', '${STILL}', '${WABA_A}'), ('${N3}', '${HATCH}', '${WABA_A}');
      INSERT INTO public.location_whatsapp_numbers VALUES ('${STILL}', '${N1}', true, now()), ('${HATCH}', '${N3}', true, now());
      ${tpl(STILL, 'welcome', 'm1')}`)
    // a second studio inserts the same (WABA, name, language)
    await expect(db.exec(`INSERT INTO whatsapp_templates (location_id, name, language, business_account_id) VALUES ('${HATCH}', 'welcome', 'en', '${WABA_A}')`))
      .rejects.toThrow(/whatsapp_templates_waba_name_lang|duplicate key/)
    // another language, another WABA and an unattached row are all fine
    await db.exec(`INSERT INTO whatsapp_templates (location_id, name, language, business_account_id) VALUES ('${HATCH}', 'welcome', 'ga', '${WABA_A}')`)
    await db.exec(`INSERT INTO whatsapp_templates (location_id, name, language, business_account_id) VALUES ('${HATCH}', 'welcome', 'en', '${WABA_B}')`)
    await db.exec(`INSERT INTO whatsapp_templates (location_id, name, language) VALUES ('${HATCH}', 'welcome', 'en'), ('${HATCH}', 'welcome', 'en')`)
  })

  it('refuses a duplicate meta_template_id, but allows many NULLs', async () => {
    const db = await boot(`${tpl(STILL, 'a', 'm1')}`)
    await expect(db.exec(tpl(HATCH, 'b', 'm1'))).rejects.toThrow(/whatsapp_templates_meta_id|duplicate key/)
    await db.exec(`${tpl(STILL, 'c')} ${tpl(STILL, 'd')}`)
  })

  it('raises when duplicates pre-exist (name on one WABA after the backfill)', async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_numbers (id, location_id, business_account_id) VALUES ('${N1}', '${STILL}', '${WABA_A}'), ('${N3}', '${HATCH}', '${WABA_A}');
      INSERT INTO public.location_whatsapp_numbers VALUES ('${STILL}', '${N1}', true, now()), ('${HATCH}', '${N3}', true, now());
      ${tpl(STILL, 'welcome', 'm1')} ${tpl(HATCH, 'welcome', 'm2')}`, { run: false })
    await expect(db.exec(MIG_745)).rejects.toThrow(/mig 745: duplicate \(business_account_id, name, language\).*welcome/)
    // the file rolls back whole (its own BEGIN is left open by the error): no column
    await db.exec('ROLLBACK')
    expect(await rows(db, `SELECT 1 FROM information_schema.columns WHERE table_name = 'whatsapp_templates' AND column_name = 'business_account_id'`)).toEqual([])
  })

  it('raises when a meta_template_id is duplicated', async () => {
    const db = await boot(`${tpl(STILL, 'a', 'm1')} ${tpl(HATCH, 'b', 'm1')}`, { run: false })
    await expect(db.exec(MIG_745)).rejects.toThrow(/mig 745: duplicate meta_template_id.*m1/)
  })

  it('is re-runnable and leaves authenticated with read-only access', async () => {
    const db = await boot(`${tpl(STILL, 'a', 'm1')}`)
    await db.exec(MIG_745)
    for (const [priv, ok] of [['SELECT', true], ['INSERT', false], ['UPDATE', false], ['DELETE', false]]) {
      expect((await rows(db, `SELECT has_table_privilege('authenticated', 'public.whatsapp_templates', '${priv}') AS ok`))[0].ok, priv).toBe(ok)
    }
    expect((await rows(db, `SELECT has_table_privilege('anon', 'public.whatsapp_templates', 'SELECT') AS ok`))[0].ok).toBe(false)
  })
})
