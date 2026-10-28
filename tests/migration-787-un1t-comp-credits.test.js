// UN1TCOMP.1 — behavioural test for migration 787 (the 'comp_credits' op on
// the un1t.online write ledger, its six comp_* columns, their CHECK and the
// "given" index).
//
// PGlite (PostgreSQL 17): the tables mig 744 touches, reduced to what it
// needs, then the real 744, 760 and 787 files. Fictional ids only: the repo
// is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_744 = MIG('744_un1t_write_back.sql')
const MIG_760 = MIG('760_un1t_trial_regrant.sql')
const MIG_787 = MIG('787_un1t_comp_credits.sql')

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'a0000000-0000-0000-0000-00000000000b'
const CONTACT = 'c0000000-0000-0000-0000-00000000000c'
const STAFF = 'b0000000-0000-0000-0000-00000000000b'

const SETUP_SQL = `
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;

    CREATE TABLE public.locations (id uuid PRIMARY KEY);
    INSERT INTO public.locations VALUES ('${LOC}'), ('${LOC_B}');
    CREATE TABLE public.contacts (id uuid PRIMARY KEY);
    INSERT INTO public.contacts VALUES ('${CONTACT}');

    CREATE TABLE public.un1t_clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, un1t_user_id text NOT NULL,
      contact_id uuid, synced_at timestamptz NOT NULL DEFAULT now(), UNIQUE (location_id, un1t_user_id));
    CREATE TABLE public.un1t_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, un1t_id text NOT NULL,
      contact_id uuid, synced_at timestamptz NOT NULL DEFAULT now(), UNIQUE (location_id, un1t_id));
    CREATE TABLE public.un1t_bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, un1t_id text NOT NULL,
      contact_id uuid, status text, synced_at timestamptz NOT NULL DEFAULT now(), UNIQUE (location_id, un1t_id));
    CREATE TABLE public.agent_membership_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL);
    CREATE TABLE public.class_booking_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, glofox_event_id text NOT NULL);
    ALTER TABLE public.class_booking_requests ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.class_booking_requests FROM anon, authenticated, PUBLIC;
`

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)
let seq = 0
const COLS = ['location_id', 'contact_id', 'un1t_user_id', 'op', 'origin', 'actor_user_id', 'idempotency_key', 'stage',
  'comp_amount', 'comp_expires_in_days', 'comp_use_by', 'comp_reason', 'comp_note', 'comp_expires_at']
function row(over = {}) {
  const r = {
    location_id: LOC, contact_id: CONTACT, un1t_user_id: 'u-1', op: 'comp_credits', origin: 'staff', actor_user_id: STAFF,
    idempotency_key: `k:${++seq}`, stage: 'sent', comp_amount: 2, comp_expires_in_days: 8, comp_use_by: '2026-11-05',
    comp_reason: 'goodwill', comp_note: null, comp_expires_at: null, ...over,
  }
  return db.query(
    `INSERT INTO public.un1t_write_events (${COLS.join(', ')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    COLS.map((c) => r[c]))
}
const plain = (op, over = {}) => row({
  op, origin: 'mia', actor_user_id: null, comp_amount: null, comp_expires_in_days: null, comp_use_by: null, comp_reason: null, ...over,
})

beforeAll(async () => {
  db = new PGlite()
  await runSql(SETUP_SQL)
  await runSql(MIG_744)
  await runSql(MIG_760)
  await runSql(MIG_787)
}, 60_000)
afterAll(() => db?.close())

describe('mig 787 — comp_credits on the un1t.online write ledger', () => {
  it('builds, passes its own self-check and is idempotent', async () => {
    await expect(runSql(MIG_787)).resolves.toBeDefined()
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'un1t_write_events_comp_given'`)
    expect(rows[0].n).toBe(1)
  })

  it('admits op comp_credits and still every earlier op; refuses anything else', async () => {
    await expect(row()).resolves.toBeDefined()
    for (const op of ['create_client', 'forgot_password', 'book', 'cancel', 'checkout', 'fee_charge', 'move']) {
      await expect(plain(op, { un1t_user_id: `u-${op}` })).resolves.toBeDefined()
    }
    await expect(plain('trial_regrant', { un1t_user_id: 'u-rg' })).resolves.toBeDefined()
    await expect(plain('credits_free', { un1t_user_id: 'u-x' })).rejects.toMatchObject({ code: '23514' })
  })

  it('a comp_credits row names its person, the member of staff, origin staff, and its amount, days, day and reason within the limits', async () => {
    for (const over of [
      { un1t_user_id: null }, { actor_user_id: null }, { origin: 'mia' },
      { comp_amount: 0 }, { comp_amount: 11 }, { comp_amount: null },
      { comp_expires_in_days: 0 }, { comp_expires_in_days: 366 },
      { comp_use_by: null }, { comp_reason: 'because' }, { comp_reason: null },
      { comp_note: 'x'.repeat(201) },
    ]) {
      await expect(row(over), JSON.stringify(over)).rejects.toMatchObject({ code: '23514' })
    }
    await expect(row({ comp_amount: 10, comp_expires_in_days: 365, comp_reason: 'referral_reward', comp_note: 'x'.repeat(200) })).resolves.toBeDefined()
    for (const reason of ['injury', 'class_cancelled', 'other']) await expect(row({ comp_reason: reason })).resolves.toBeDefined()
  })

  it('no other op carries a comp_* column', async () => {
    for (const over of [{ comp_amount: 2 }, { comp_use_by: '2026-11-05' }, { comp_reason: 'goodwill' }, { comp_note: 'n' }, { comp_expires_at: '2026-11-05T10:00:00Z' }, { comp_expires_in_days: 3 }]) {
      await expect(plain('book', { un1t_user_id: 'u-b', ...over }), JSON.stringify(over)).rejects.toMatchObject({ code: '23514' })
    }
  })

  it('one open attempt per key, but many grants per person (no one-done rule)', async () => {
    await row({ idempotency_key: 'comp:dup', un1t_user_id: 'u-many' })
    await expect(row({ idempotency_key: 'comp:dup', un1t_user_id: 'u-many' })).rejects.toMatchObject({ code: '23505' })
    for (let i = 0; i < 3; i++) await expect(row({ un1t_user_id: 'u-many', stage: 'done' })).resolves.toBeDefined()
    await expect(row({ un1t_user_id: 'u-many', location_id: LOC_B, stage: 'done' })).resolves.toBeDefined()
  })

  it('leaves the ledger closed to client roles', async () => {
    const { rows } = await db.query(`
      SELECT count(*)::int AS n FROM information_schema.table_privileges
       WHERE table_name = 'un1t_write_events' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`)
    expect(rows[0].n).toBe(0)
  })

  it('aborts on an op CHECK that drops an earlier op', async () => {
    const probe = new PGlite()
    try {
      await probe['exec'](SETUP_SQL)
      await probe['exec'](MIG_744)
      const broken = MIG_787.replace("CHECK (op IN ('create_client', 'forgot_password', ", "CHECK (op IN (")
      expect(broken).not.toBe(MIG_787)
      await expect(probe['exec'](broken)).rejects.toThrow(/does not admit create_client/)
    } finally {
      await probe.close()
    }
  })
})
