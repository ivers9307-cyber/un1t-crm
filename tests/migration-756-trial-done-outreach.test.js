// TRIALDONE.1 — migration 756 (trial_done_outreach). Static assertions on the
// SQL text, then a PGlite run of the REAL file (locations and contacts reduced
// to their ids, the three roles) to prove the table behaves: columns, the
// per-studio-once unique, the CHECKs, the cascade, the closed ACL, re-apply.
//
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const SQL = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/756_trial_done_outreach.sql'), 'utf8')

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const CONTACT = 'c0000000-0000-0000-0000-00000000000c'

const COLUMNS = [
  'id', 'location_id', 'contact_id', 'deal_id', 'trigger_kind', 'trigger_at',
  'opener_claimed_at', 'opener_sent_at', 'opener_wa_message_id', 'followup_kind',
  'followup_claimed_at', 'followup_sent_at', 'followup_wa_message_id',
  'closed_at', 'closed_reason', 'created_at', 'updated_at',
]

describe('mig 756 file text', () => {
  it('creates the table idempotently inside a transaction with a lock timeout', () => {
    expect(SQL).toMatch(/BEGIN;/)
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '5s'/)
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS public\.trial_done_outreach/)
    expect(SQL).toMatch(/COMMIT;/)
  })

  it.each(COLUMNS)('declares column %s', (col) => {
    expect(SQL).toMatch(new RegExp(`^\\s+${col}\\s`, 'm'))
  })

  it('is unique per (location_id, contact_id)', () => {
    expect(SQL).toMatch(/UNIQUE\s*\(location_id,\s*contact_id\)/)
  })

  it('is closed to every client session', () => {
    expect(SQL).toMatch(/ALTER TABLE public\.trial_done_outreach ENABLE ROW LEVEL SECURITY/)
    expect(SQL).toMatch(/REVOKE ALL ON public\.trial_done_outreach FROM anon, authenticated/)
    expect(SQL).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.trial_done_outreach TO service_role/)
    expect(SQL).not.toMatch(/CREATE POLICY/i)
  })

  it('self-checks that RLS is on', () => {
    expect(SQL).toMatch(/DO \$\$/)
    expect(SQL).toMatch(/relrowsecurity/)
    expect(SQL).toMatch(/RAISE EXCEPTION 'mig 756: row level security is not enabled on trial_done_outreach'/)
  })
})

describe('mig 756 behaviour (PGlite)', () => {
  let db
  const runSql = (text) => db['exec'](text)
  const priv = async (role, p) => (await db.query(
    'SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'public.trial_done_outreach', p])).rows[0].ok
  const insert = (loc, contact = CONTACT, kind = 'three_attended') => db.query(
    `INSERT INTO public.trial_done_outreach (location_id, contact_id, trigger_kind, trigger_at)
     VALUES ($1, $2, $3, now()) RETURNING id`, [loc, contact, kind])

  beforeAll(async () => {
    db = new PGlite()
    await runSql(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE TABLE public.locations (id uuid PRIMARY KEY);
      CREATE TABLE public.contacts (id uuid PRIMARY KEY);
      INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
      INSERT INTO public.contacts VALUES ('${CONTACT}');
    `)
    await runSql(SQL)
  }, 60_000)
  afterAll(() => db?.close())

  it('has every column', async () => {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'trial_done_outreach'`)
    expect(rows.map((r) => r.column_name).sort()).toEqual([...COLUMNS].sort())
  })

  it('records a person once per studio but allows another studio', async () => {
    await insert(LOC_A)
    await expect(insert(LOC_A)).rejects.toThrow(/duplicate key|unique/i)
    await expect(insert(LOC_B)).resolves.toBeTruthy()
  })

  it('refuses an unknown trigger_kind and followup_kind', async () => {
    await expect(insert(LOC_A, CONTACT, 'bogus')).rejects.toThrow(/check/i)
    await expect(db.query(
      `UPDATE public.trial_done_outreach SET followup_kind = 'bogus' WHERE location_id = $1`, [LOC_A],
    )).rejects.toThrow(/check/i)
    await expect(db.query(
      `UPDATE public.trial_done_outreach SET followup_kind = 'nudge' WHERE location_id = $1`, [LOC_A],
    )).resolves.toBeTruthy()
  })

  it('accepts two_attended_expired', async () => {
    const c2 = 'c0000000-0000-0000-0000-0000000000c2'
    await db.query('INSERT INTO public.contacts VALUES ($1)', [c2])
    await expect(insert(LOC_A, c2, 'two_attended_expired')).resolves.toBeTruthy()
  })

  it('cascades when the contact is deleted', async () => {
    const c3 = 'c0000000-0000-0000-0000-0000000000c3'
    await db.query('INSERT INTO public.contacts VALUES ($1)', [c3])
    await insert(LOC_A, c3)
    await db.query('DELETE FROM public.contacts WHERE id = $1', [c3])
    const { rows } = await db.query('SELECT 1 FROM public.trial_done_outreach WHERE contact_id = $1', [c3])
    expect(rows).toHaveLength(0)
  })

  it('has RLS on, no policy, anon/authenticated closed, service_role open', async () => {
    const rls = await db.query(
      `SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'trial_done_outreach'`)
    expect(rls.rows[0].relrowsecurity).toBe(true)
    const pol = await db.query(`SELECT 1 FROM pg_policies WHERE tablename = 'trial_done_outreach'`)
    expect(pol.rows).toHaveLength(0)
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(await priv('anon', p)).toBe(false)
      expect(await priv('authenticated', p)).toBe(false)
      expect(await priv('service_role', p)).toBe(true)
    }
  })

  it('has the contact index and the open-rows partial index', async () => {
    const { rows } = await db.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'trial_done_outreach'`)
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/\(contact_id\)/)
    expect(defs).toMatch(/\(location_id\)\s+WHERE \(closed_at IS NULL\)/)
  })

  it('re-applies cleanly', async () => {
    await expect(runSql(SQL)).resolves.toBeTruthy()
  })
})
