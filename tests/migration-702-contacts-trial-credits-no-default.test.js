// TRIALDEFAULT.1 (C145) — behavioural test for migration 702.
//
// No local Supabase stack exists, so the DDL would otherwise get its first
// run on prod. This boots PGlite (PostgreSQL 17) with contacts reduced to the
// columns that matter (prod: trial_credits_remaining integer, nullable,
// DEFAULT 3 from mig 001) and proves:
//   * BEFORE: an insert that omits the column gets 3 credits;
//   * AFTER: it gets NULL ("no count"); an explicit value is still stored;
//   * the old default is cleared (Richard, 2 Oct): exactly the contacts at 3
//     with no Glofox link go to NULL and their ids are kept in
//     private.c145_trial_credits_cleared_20261002 (no anon/authenticated
//     access); linked contacts, other counts and NULLs are untouched;
//   * the file aborts WHOLE, changing nothing, when the default has drifted
//     to something other than 3, the column is NOT NULL, or the number of
//     rows to clear is outside the pinned 360-420; a second run passes and
//     clears nothing more; the rollback record restores DEFAULT 3 and the
//     recorded 3s, never over a value Glofox has set since.
// Fictional ids only: the repo is public.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_702 = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/702_contacts_trial_credits_no_default.sql'), 'utf8')
// The rollback record from the file header, verbatim in substance.
const ROLLBACK_702 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.contacts ALTER COLUMN trial_credits_remaining SET DEFAULT 3;
UPDATE public.contacts c
   SET trial_credits_remaining = 3
  FROM private.c145_trial_credits_cleared_20261002 b
 WHERE b.contact_id = c.id
   AND c.trial_credits_remaining IS NULL
   AND c.glofox_member_id IS NULL;
COMMIT;
`
const BACKUP = 'private.c145_trial_credits_cleared_20261002'
// Prod on 2 Oct: 372 unlinked contacts at 3 (the pin is 360-420).
const LIVE_UNLINKED_AT_3 = 372
const schema = (unlinkedAt3) => `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;
  CREATE SCHEMA private;
  CREATE TABLE public.contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text,
    glofox_member_id text,
    trial_credits_remaining INT DEFAULT 3
  );
  INSERT INTO public.contacts (email, glofox_member_id, trial_credits_remaining) VALUES
    ('linked@example.test', 'gx-1', 7),
    ('linked3@example.test', 'gx-2', 3),
    ('unlinked2@example.test', NULL, 2),
    ('nocount@example.test', NULL, NULL);
  INSERT INTO public.contacts (email, glofox_member_id, trial_credits_remaining)
    SELECT 'phantom' || g || '@example.test', NULL, 3 FROM generate_series(1, ${unlinkedAt3}) g;
`
const run = (db, sql) => db['exec'](sql)
async function boot(extra = '', unlinkedAt3 = LIVE_UNLINKED_AT_3) {
  const db = new PGlite()
  await run(db, schema(unlinkedAt3))
  if (extra) await run(db, extra)
  return db
}
const kept = async (db) => (await db.query(
  "SELECT email, trial_credits_remaining AS c FROM public.contacts WHERE email NOT LIKE 'phantom%' ORDER BY email")).rows
const phantoms = async (db) => (await db.query(
  `SELECT count(*)::int AS n, count(*) FILTER (WHERE trial_credits_remaining IS NULL)::int AS nulls
     FROM public.contacts WHERE email LIKE 'phantom%'`)).rows[0]
const backupExists = async (db) => (await db.query(
  "SELECT to_regclass('private.c145_trial_credits_cleared_20261002') IS NOT NULL AS e")).rows[0].e
const backupIds = async (db) => (await db.query(
  `SELECT b.contact_id FROM ${BACKUP} b ORDER BY 1`)).rows.map((r) => r.contact_id)
const phantomIds = async (db) => (await db.query(
  "SELECT id FROM public.contacts WHERE email LIKE 'phantom%' ORDER BY 1")).rows.map((r) => r.id)
async function abortMessage(db, sql) {
  try {
    await run(db, sql)
    return null
  } catch (e) {
    await run(db, 'ROLLBACK;')
    return String(e.message || e)
  }
}
const columnDefault = async (db) => (await db.query(
  `SELECT column_default AS d FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'trial_credits_remaining'`)).rows[0].d
const creditsOf = async (db, email) => (await db.query(
  'SELECT trial_credits_remaining AS c FROM public.contacts WHERE email = $1', [email])).rows[0].c

describe('migration 702 — contacts.trial_credits_remaining has no default', () => {
  let db
  afterEach(async () => { await db?.close() })

  it('BEFORE: a contact inserted without a count gets 3 credits', async () => {
    db = await boot()
    await run(db, "INSERT INTO public.contacts (email) VALUES ('new@example.test')")
    expect(await creditsOf(db, 'new@example.test')).toBe(3)
  })

  it('AFTER: a new contact has no count; an explicit value is stored', async () => {
    db = await boot()
    await run(db, MIG_702)
    expect(await columnDefault(db)).toBeNull()
    await run(db, "INSERT INTO public.contacts (email) VALUES ('new@example.test')")
    expect(await creditsOf(db, 'new@example.test')).toBeNull()
    await run(db, "INSERT INTO public.contacts (email, trial_credits_remaining) VALUES ('explicit@example.test', 2)")
    expect(await creditsOf(db, 'explicit@example.test')).toBe(2)
  })

  it('clears exactly the unlinked 3s, records their ids, leaves every other row alone', async () => {
    db = await boot()
    const before = await kept(db)
    const ids = await phantomIds(db)
    await run(db, MIG_702)
    expect(await phantoms(db)).toEqual({ n: LIVE_UNLINKED_AT_3, nulls: LIVE_UNLINKED_AT_3 })
    expect(await backupIds(db)).toEqual(ids)
    // Linked (even at 3), other counts and NULLs: untouched.
    expect(await kept(db)).toEqual(before)
    expect(await creditsOf(db, 'linked3@example.test')).toBe(3)
  })

  it('the backup table is closed to anon and authenticated', async () => {
    db = await boot()
    await run(db, MIG_702)
    const privs = (await db.query(
      `SELECT r.rolname, has_table_privilege(r.rolname, '${BACKUP}', 'SELECT') AS sel,
              has_table_privilege(r.rolname, '${BACKUP}', 'INSERT') AS ins
         FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role') ORDER BY 1`)).rows
    expect(privs).toEqual([
      { rolname: 'anon', sel: false, ins: false },
      { rolname: 'authenticated', sel: false, ins: false },
      { rolname: 'service_role', sel: true, ins: true },
    ])
    expect((await db.query(
      "SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'private.c145_trial_credits_cleared_20261002'::regclass")).rows[0].r).toBe(true)
  })

  for (const n of [359, 421]) {
    it(`aborts whole, changing nothing, when ${n} rows would be cleared (pin 360-420)`, async () => {
      db = await boot('', n)
      const msg = await abortMessage(db, MIG_702)
      expect(msg).toMatch(new RegExp(`mig 702: ${n} unlinked contacts at 3 credits, expected 360-420`))
      expect(await columnDefault(db)).toBe('3')
      expect(await phantoms(db)).toEqual({ n, nulls: 0 })
      expect(await backupExists(db)).toBe(false)
    })
  }

  it('a second run passes and clears nothing more (a 3 set since is kept)', async () => {
    db = await boot()
    await run(db, MIG_702)
    await run(db, "INSERT INTO public.contacts (email, trial_credits_remaining) VALUES ('later@example.test', 3)")
    await run(db, MIG_702)
    expect(await columnDefault(db)).toBeNull()
    expect(await creditsOf(db, 'later@example.test')).toBe(3)
    expect((await backupIds(db)).length).toBe(LIVE_UNLINKED_AT_3)
  })

  it('aborts whole when the default has drifted from 3', async () => {
    db = await boot('ALTER TABLE public.contacts ALTER COLUMN trial_credits_remaining SET DEFAULT 5;')
    const msg = await abortMessage(db, MIG_702)
    expect(msg).toMatch(/mig 702: .*default is 5, expected 3 or none/)
    expect(await columnDefault(db)).toBe('5')
  })

  it('aborts whole when the column is NOT NULL', async () => {
    db = await boot(`
      UPDATE public.contacts SET trial_credits_remaining = 0 WHERE trial_credits_remaining IS NULL;
      ALTER TABLE public.contacts ALTER COLUMN trial_credits_remaining SET NOT NULL;
    `)
    const msg = await abortMessage(db, MIG_702)
    expect(msg).toMatch(/mig 702: .*expected a nullable integer/)
    expect(await columnDefault(db)).toBe('3')
  })

  it('the rollback record restores DEFAULT 3 and the cleared 3s, never over a Glofox value', async () => {
    db = await boot()
    await run(db, MIG_702)
    // Since the clear: one phantom got linked and Glofox set its balance.
    await run(db, `UPDATE public.contacts SET glofox_member_id = 'gx-9', trial_credits_remaining = 1
                    WHERE email = 'phantom1@example.test'`)
    await run(db, ROLLBACK_702)
    expect(await columnDefault(db)).toBe('3')
    expect(await creditsOf(db, 'phantom1@example.test')).toBe(1)
    expect(await phantoms(db)).toEqual({ n: LIVE_UNLINKED_AT_3, nulls: 0 })
    expect(await creditsOf(db, 'nocount@example.test')).toBeNull()
    await run(db, "INSERT INTO public.contacts (email) VALUES ('back@example.test')")
    expect(await creditsOf(db, 'back@example.test')).toBe(3)
  })
})
