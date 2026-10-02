// TRIALDEFAULT.1 (C145) — behavioural test for migration 702.
//
// No local Supabase stack exists, so the DDL would otherwise get its first
// run on prod. This boots PGlite (PostgreSQL 17) with contacts reduced to the
// columns that matter (prod: trial_credits_remaining integer, nullable,
// DEFAULT 3 from mig 001) and proves:
//   * BEFORE: an insert that omits the column gets 3 credits;
//   * AFTER: it gets NULL ("no count"); an explicit value is still stored;
//     every existing row keeps its value (3s and NULLs alike);
//   * the file aborts WHOLE, changing nothing, when the default has drifted
//     to something other than 3, or the column is NOT NULL; a second run
//     passes (already no default); the rollback record restores DEFAULT 3.
// Fictional ids only: the repo is public.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_702 = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/702_contacts_trial_credits_no_default.sql'), 'utf8')
const ROLLBACK_702 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.contacts ALTER COLUMN trial_credits_remaining SET DEFAULT 3;
COMMIT;
`
const SCHEMA = `
  CREATE TABLE public.contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text,
    glofox_member_id text,
    trial_credits_remaining INT DEFAULT 3
  );
  INSERT INTO public.contacts (email, glofox_member_id, trial_credits_remaining) VALUES
    ('linked@example.test', 'gx-1', 7),
    ('unlinked@example.test', NULL, 3),
    ('nocount@example.test', NULL, NULL);
`
const run = (db, sql) => db['exec'](sql)
async function boot(extra = '') {
  const db = new PGlite()
  await run(db, SCHEMA)
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
const columnDefault = async (db) => (await db.query(
  `SELECT column_default AS d FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'trial_credits_remaining'`)).rows[0].d
const creditsOf = async (db, email) => (await db.query(
  'SELECT trial_credits_remaining AS c FROM public.contacts WHERE email = $1', [email])).rows[0].c
const snapshot = async (db) => (await db.query(
  'SELECT email, trial_credits_remaining AS c FROM public.contacts ORDER BY email')).rows

describe('migration 702 — contacts.trial_credits_remaining has no default', () => {
  let db
  afterEach(async () => { await db?.close() })

  it('BEFORE: a contact inserted without a count gets 3 credits', async () => {
    db = await boot()
    await run(db, "INSERT INTO public.contacts (email) VALUES ('new@example.test')")
    expect(await creditsOf(db, 'new@example.test')).toBe(3)
  })

  it('AFTER: a new contact has no count; an explicit value is stored; existing rows untouched', async () => {
    db = await boot()
    const before = await snapshot(db)
    await run(db, MIG_702)
    expect(await columnDefault(db)).toBeNull()
    expect(await snapshot(db)).toEqual(before)
    await run(db, "INSERT INTO public.contacts (email) VALUES ('new@example.test')")
    expect(await creditsOf(db, 'new@example.test')).toBeNull()
    await run(db, "INSERT INTO public.contacts (email, trial_credits_remaining) VALUES ('explicit@example.test', 2)")
    expect(await creditsOf(db, 'explicit@example.test')).toBe(2)
  })

  it('a second run passes (already no default)', async () => {
    db = await boot()
    await run(db, MIG_702)
    await run(db, MIG_702)
    expect(await columnDefault(db)).toBeNull()
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

  it('the rollback record restores DEFAULT 3', async () => {
    db = await boot()
    await run(db, MIG_702)
    await run(db, ROLLBACK_702)
    expect(await columnDefault(db)).toBe('3')
    await run(db, "INSERT INTO public.contacts (email) VALUES ('back@example.test')")
    expect(await creditsOf(db, 'back@example.test')).toBe(3)
  })
})
