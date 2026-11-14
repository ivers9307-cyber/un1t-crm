// TRIALABANDON.1 — behavioural test for migration 835 (the abandoned-checkout
// follow-up stamp on trial_purchases).
//
// Boots PGlite, runs the REAL mig 762 (trial_purchases), then 835, and proves:
//   * both columns exist, nullable, and existing rows stay NULL (nothing is
//     followed up retroactively by the migration itself);
//   * the table stays closed to client sessions (a new column inherits mig
//     762's lockdown; 835 grants nothing);
//   * a replay is a no-op;
//   * the header says it goes in BEFORE the deploy.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(import.meta.dirname, '..')
const read = (name) => readFileSync(path.join(root, 'supabase/migrations', name), 'utf8')
const MIG_762 = read('762_trial_purchases.sql')
const MIG_835 = read('835_trial_purchases_abandon_followup.sql')
const LOC = 'a0000000-0000-0000-0000-00000000000a'

let db
const runSql = (text) => db['exec'](text)

beforeEach(async () => {
  db = new PGlite()
  await runSql(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE TABLE public.locations (id uuid PRIMARY KEY);
    INSERT INTO public.locations VALUES ('${LOC}');
    CREATE TABLE public.contacts (id uuid PRIMARY KEY);
    CREATE TABLE public.cron_heartbeats (
      name text PRIMARY KEY, expected_interval_seconds integer, grace_seconds integer, last_ok_at timestamptz);
    CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS
      $fn$ BEGIN NEW.updated_at = now(); RETURN NEW; END $fn$;
  `)
  await runSql(MIG_762)
  await db.query(
    `INSERT INTO public.trial_purchases (location_id, customer_email, product_name, membership_id, plan_code, amount_cents)
     VALUES ($1, 'x@example.test', 'Trial', 'm', 'p', 3900)`, [LOC])
}, 60_000)

afterEach(async () => { await db?.close() })

const columns = async () => (await db.query(
  `SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trial_purchases' AND column_name LIKE 'abandon_followup%'
    ORDER BY column_name`)).rows

describe('mig 835 adds the abandoned-checkout follow-up stamp', () => {
  it('two nullable columns; an existing row stays unjudged', async () => {
    await runSql(MIG_835)
    expect(await columns()).toEqual([
      { column_name: 'abandon_followup_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'abandon_followup_outcome', data_type: 'text', is_nullable: 'YES' },
    ])
    const { rows } = await db.query('SELECT abandon_followup_at, abandon_followup_outcome FROM public.trial_purchases')
    expect(rows).toEqual([{ abandon_followup_at: null, abandon_followup_outcome: null }])
  })

  it('grants nothing: anon and authenticated still hold no privilege on the table or the new columns', async () => {
    await runSql(MIG_835)
    expect(MIG_835).not.toMatch(/\bGRANT\b\s+(SELECT|INSERT|UPDATE|DELETE|ALL)/i)
    const { rows } = await db.query(
      `SELECT r.rolname, has_table_privilege(r.rolname, 'public.trial_purchases', 'SELECT') AS t,
              has_column_privilege(r.rolname, 'public.trial_purchases', 'abandon_followup_at', 'SELECT') AS c,
              has_column_privilege(r.rolname, 'public.trial_purchases', 'abandon_followup_outcome', 'UPDATE') AS u
         FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated') ORDER BY 1`)
    expect(rows).toEqual([
      { rolname: 'anon', t: false, c: false, u: false },
      { rolname: 'authenticated', t: false, c: false, u: false },
    ])
  })

  it('a replay is a no-op and keeps a stamp already written', async () => {
    await runSql(MIG_835)
    await db.query(`UPDATE public.trial_purchases SET abandon_followup_at = now(), abandon_followup_outcome = 'enrolled'`)
    await runSql(MIG_835)
    const { rows } = await db.query('SELECT abandon_followup_outcome FROM public.trial_purchases')
    expect(rows).toEqual([{ abandon_followup_outcome: 'enrolled' }])
    expect(await columns()).toHaveLength(2)
  })

  it('says in its header that it goes in BEFORE the deploy', () => {
    expect(MIG_835).toMatch(/APPLY BEFORE THE CODE DEPLOYS/)
  })
})
