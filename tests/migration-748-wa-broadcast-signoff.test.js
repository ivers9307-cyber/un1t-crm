// WAORGNUMBER.4 — behavioural test for migration 748: whatsapp_broadcasts gains
// signed_off_by (-> profiles) and signed_off_at, both nullable (design R7).
// Loads the REAL 748 file into PGlite over the columns of the tables it touches,
// with mig 661/673's grants (authenticated: table SELECT only; anon: nothing).
// Fictional ids only: the repo is public.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_748 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/748_wa_broadcast_signoff.sql'), 'utf8')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const ADMIN = 'b0000000-0000-0000-0000-000000000001'
const NOBODY = 'b0000000-0000-0000-0000-0000000000ff'
const B1 = 'c0000000-0000-0000-0000-000000000001'

const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY);
  CREATE TABLE public.whatsapp_broadcasts (id uuid PRIMARY KEY, location_id uuid REFERENCES public.locations(id),
    name text, status text NOT NULL DEFAULT 'draft');
  GRANT SELECT ON public.whatsapp_broadcasts TO authenticated;
  GRANT ALL ON public.whatsapp_broadcasts TO service_role;
  INSERT INTO public.locations VALUES ('${LOC}');
  INSERT INTO public.profiles VALUES ('${ADMIN}');
  INSERT INTO public.whatsapp_broadcasts (id, location_id, name) VALUES ('${B1}', '${LOC}', 'Existing');
`
async function boot(extra = '') {
  const db = new PGlite()
  await db.exec(SCHEMA)
  if (extra) await db.exec(extra)
  await db.exec(MIG_748)
  return db
}
const rows = async (db, sql) => (await db.query(sql)).rows

describe('748 whatsapp_broadcasts sign-off columns', () => {
  it('adds two nullable columns and leaves existing rows unsigned', async () => {
    const db = await boot()
    expect(await rows(db, `SELECT signed_off_by, signed_off_at FROM whatsapp_broadcasts`))
      .toEqual([{ signed_off_by: null, signed_off_at: null }])
    const cols = await rows(db, `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'whatsapp_broadcasts' AND column_name LIKE 'signed_off_%' ORDER BY column_name`)
    expect(cols).toEqual([
      { column_name: 'signed_off_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'signed_off_by', data_type: 'uuid', is_nullable: 'YES' },
    ])
  })

  it('stamps a real profile and refuses an unknown one', async () => {
    const db = await boot()
    await db.exec(`UPDATE whatsapp_broadcasts SET signed_off_by = '${ADMIN}', signed_off_at = now() WHERE id = '${B1}'`)
    expect((await rows(db, `SELECT signed_off_by FROM whatsapp_broadcasts`))[0].signed_off_by).toBe(ADMIN)
    await expect(db.exec(`UPDATE whatsapp_broadcasts SET signed_off_by = '${NOBODY}' WHERE id = '${B1}'`))
      .rejects.toThrow(/foreign key/)
  })

  it('authenticated reads the new columns through its table SELECT and still writes nothing', async () => {
    const db = await boot()
    expect(await rows(db, `SELECT has_column_privilege('authenticated', 'public.whatsapp_broadcasts', 'signed_off_by', 'SELECT') AS r,
      has_column_privilege('authenticated', 'public.whatsapp_broadcasts', 'signed_off_by', 'UPDATE') AS w,
      has_column_privilege('anon', 'public.whatsapp_broadcasts', 'signed_off_at', 'SELECT') AS a`))
      .toEqual([{ r: true, w: false, a: false }])
  })

  it('refuses to apply over a client write grant', async () => {
    const db = new PGlite()
    await db.exec(SCHEMA)
    await db.exec(`GRANT UPDATE ON public.whatsapp_broadcasts TO authenticated`)
    await expect(db.exec(MIG_748)).rejects.toThrow(/mig 748: authenticated holds a write privilege/)
  })

  it('is re-runnable', async () => {
    const db = await boot()
    await db.exec(MIG_748)
    expect((await rows(db, `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'whatsapp_broadcasts' AND column_name LIKE 'signed_off_%'`))[0].n).toBe(2)
  })
})
