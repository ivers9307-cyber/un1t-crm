// WAREPLYNUMBER.1 (C86) — behavioural test for migration 696.
//
// Models whatsapp_numbers and whatsapp_conversations with the live ACL
// (postgres + service_role; authenticated SELECT only, mig 661/673; anon
// nothing) and the live SELECT policy, runs the REAL 696 file and proves:
//   * before 696 a select naming whatsapp_number_id fails (42703); after it
//     the column exists, nullable, every existing row NULL (= the default);
//   * a stamp to an existing number lands; one to no number is refused (FK);
//     deleting the number clears the stamp (ON DELETE SET NULL), never the
//     conversation;
//   * the ACL and policy are unchanged; authenticated can read the column and
//     write nothing;
//   * a second run passes; the rollback record restores the before-state;
//     696 aborts before anything when a table is missing, or when a client
//     already holds a write.
// Fictional ids only: the repo is public.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_696 = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/696_whatsapp_conversations_reply_number.sql'), 'utf8')
const ROLLBACK_696 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP INDEX IF EXISTS public.idx_wa_conversations_number;
ALTER TABLE public.whatsapp_conversations DROP COLUMN IF EXISTS whatsapp_number_id;
COMMIT;
`
const LOC = 'a0000000-0000-0000-0000-000000000001'
const N1 = 'f0000000-0000-0000-0000-000000000001'
const N2 = 'f0000000-0000-0000-0000-000000000002'
const C1 = 'c0000000-0000-0000-0000-000000000001'
const C2 = 'c0000000-0000-0000-0000-000000000002'

const SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.whatsapp_numbers (id uuid PRIMARY KEY, location_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true);
  CREATE TABLE public.whatsapp_conversations (
    id uuid PRIMARY KEY, location_id uuid NOT NULL, wa_phone text, status text DEFAULT 'active',
    updated_at timestamptz DEFAULT now(), UNIQUE (location_id, wa_phone)
  );
  ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.whatsapp_conversations FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON public.whatsapp_conversations TO authenticated;
  GRANT ALL ON public.whatsapp_conversations TO service_role;
  CREATE POLICY wa_conv_select ON public.whatsapp_conversations FOR SELECT TO authenticated USING (true);
  INSERT INTO public.whatsapp_numbers VALUES ('${N1}', '${LOC}', true), ('${N2}', '${LOC}', true);
  INSERT INTO public.whatsapp_conversations (id, location_id, wa_phone) VALUES ('${C1}', '${LOC}', '15555550100'), ('${C2}', '${LOC}', '15555550101');
`
const run = (db, sql) => db['exec'](sql)
async function boot(extra = '', schema = SCHEMA) {
  const db = new PGlite()
  await run(db, schema)
  if (extra) await run(db, extra)
  return db
}
async function abortMessage(db, sql) {
  try {
    await run(db, sql)
    return null
  } catch (e) {
    await run(db, 'ROLLBACK;')
    return String(e.message || e)
  }
}
const stamps = async (db) => (await db.query(
  'SELECT id, whatsapp_number_id FROM public.whatsapp_conversations ORDER BY id')).rows
const aclAndPolicies = async (db) => ({
  acl: (await db.query(`SELECT relacl::text AS a FROM pg_class WHERE oid = 'public.whatsapp_conversations'::regclass`)).rows[0].a,
  policies: (await db.query(`SELECT polname::text AS n, polcmd::text AS c FROM pg_policy WHERE polrelid = 'public.whatsapp_conversations'::regclass ORDER BY 1`)).rows,
})
const columns = async (db) => (await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'whatsapp_conversations' ORDER BY ordinal_position`)).rows.map((r) => r.column_name)

describe('migration 696 — whatsapp_conversations.whatsapp_number_id', () => {
  let db
  afterEach(async () => { await db?.close() })

  it('BEFORE: a read naming the column fails (42703)', async () => {
    db = await boot()
    let err
    try { await db.query('SELECT whatsapp_number_id FROM public.whatsapp_conversations') } catch (e) { err = e }
    expect(err?.code).toBe('42703')
  })

  it('AFTER: the column exists, nullable, every existing thread NULL (the default number, as today)', async () => {
    db = await boot()
    expect(await abortMessage(db, MIG_696)).toBeNull()
    expect(await stamps(db)).toEqual([{ id: C1, whatsapp_number_id: null }, { id: C2, whatsapp_number_id: null }])
    const { rows: [col] } = await db.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'whatsapp_conversations' AND column_name = 'whatsapp_number_id'`)
    expect(col).toEqual({ data_type: 'uuid', is_nullable: 'YES' })
  })

  it('a stamp to a real number lands; to no number is refused; deleting the number clears the stamp, never the thread', async () => {
    db = await boot()
    expect(await abortMessage(db, MIG_696)).toBeNull()
    await db.query(`UPDATE public.whatsapp_conversations SET whatsapp_number_id = '${N2}' WHERE id = '${C1}'`)
    let err
    try { await db.query(`UPDATE public.whatsapp_conversations SET whatsapp_number_id = 'f0000000-0000-0000-0000-0000000000ff' WHERE id = '${C2}'`) } catch (e) { err = e }
    expect(err?.code).toBe('23503')
    await db.query(`DELETE FROM public.whatsapp_numbers WHERE id = '${N2}'`)
    expect(await stamps(db)).toEqual([{ id: C1, whatsapp_number_id: null }, { id: C2, whatsapp_number_id: null }])
  })

  it('keeps the ACL and the policy; authenticated reads the column and still writes nothing', async () => {
    db = await boot()
    const before = await aclAndPolicies(db)
    expect(await abortMessage(db, MIG_696)).toBeNull()
    expect(await aclAndPolicies(db)).toEqual(before)
    await run(db, `SET ROLE authenticated;`)
    const { rows } = await db.query('SELECT whatsapp_number_id FROM public.whatsapp_conversations')
    expect(rows).toHaveLength(2)
    let err
    try { await db.query(`UPDATE public.whatsapp_conversations SET whatsapp_number_id = '${N1}'`) } catch (e) { err = e }
    expect(err?.code).toBe('42501')
    await run(db, `RESET ROLE;`)
  })

  it('a second run passes; the rollback record restores the before-state', async () => {
    db = await boot()
    const before = await columns(db)
    expect(await abortMessage(db, MIG_696)).toBeNull()
    expect(await abortMessage(db, MIG_696)).toBeNull()
    expect(await abortMessage(db, ROLLBACK_696)).toBeNull()
    expect(await columns(db)).toEqual(before)
  })

  it('aborts before anything when whatsapp_numbers is missing', async () => {
    db = await boot('', SCHEMA.replace(/CREATE TABLE public\.whatsapp_numbers[^;]*;/, '').replace(/INSERT INTO public\.whatsapp_numbers[^;]*;/, ''))
    const before = await columns(db)
    expect(await abortMessage(db, MIG_696)).toMatch(/mig 696: whatsapp_conversations and whatsapp_numbers must exist/)
    expect(await columns(db)).toEqual(before)
  })

  it('aborts WHOLE when a client already holds a write on the table', async () => {
    db = await boot('GRANT UPDATE ON public.whatsapp_conversations TO authenticated;')
    const before = await columns(db)
    expect(await abortMessage(db, MIG_696)).toMatch(/mig 696: a client role holds a write/)
    expect(await columns(db)).toEqual(before)
  })
})
