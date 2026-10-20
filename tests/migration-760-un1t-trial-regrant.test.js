// TRIALREGRANT.1 — behavioural test for migration 760 (the 'trial_regrant'
// op on the un1t.online write ledger, its user CHECK and the one-regrant
// index).
//
// PGlite (PostgreSQL 17): the tables mig 744 touches, reduced to what it
// needs, then the real 744 file, then the real 760 file. Fictional ids only:
// the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_744 = MIG('744_un1t_write_back.sql')
const MIG_760 = MIG('760_un1t_trial_regrant.sql')

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'a0000000-0000-0000-0000-00000000000b'
const CONTACT = 'c0000000-0000-0000-0000-00000000000c'

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
function row(over = {}) {
  const r = {
    location_id: LOC, contact_id: CONTACT, un1t_user_id: 'u-1', op: 'trial_regrant', origin: 'mia',
    idempotency_key: `k:${++seq}`, target: null, stage: 'sent', method: null, ...over,
  }
  return db.query(
    `INSERT INTO public.un1t_write_events
       (location_id, contact_id, un1t_user_id, op, origin, idempotency_key, target, stage, method)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [r.location_id, r.contact_id, r.un1t_user_id, r.op, r.origin, r.idempotency_key, r.target, r.stage, r.method])
}

beforeAll(async () => {
  db = new PGlite()
  await runSql(SETUP_SQL)
  await runSql(MIG_744)
  await runSql(MIG_760)
}, 60_000)
afterAll(() => db?.close())

describe('mig 760 — trial_regrant on the un1t.online write ledger', () => {
  it('builds, passes its own self-check and is idempotent', async () => {
    await expect(runSql(MIG_760)).resolves.toBeDefined()
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'un1t_write_events_one_regrant'`)
    expect(rows[0].n).toBe(1)
  })

  it('admits op trial_regrant and still every op mig 744 allowed; refuses anything else', async () => {
    await expect(row()).resolves.toBeDefined()
    for (const op of ['create_client', 'forgot_password', 'book', 'cancel', 'checkout']) {
      await expect(row({ op, un1t_user_id: `u-${op}` })).resolves.toBeDefined()
    }
    await expect(row({ op: 'trial', un1t_user_id: 'u-trial', target: 'prod-1', method: 'charge' })).resolves.toBeDefined()
    await expect(row({ op: 'credits_grant' })).rejects.toMatchObject({ code: '23514' })
  })

  it('a trial_regrant row needs its un1t user and carries no method', async () => {
    await expect(row({ un1t_user_id: null })).rejects.toMatchObject({ code: '23514' })
    await expect(row({ un1t_user_id: 'u-m', method: 'charge' })).rejects.toMatchObject({ code: '23514' })
  })

  it('one in-flight, in-doubt or done re-grant per person per studio; a refused one does not count', async () => {
    await row({ un1t_user_id: 'u-once', stage: 'refused' })
    await row({ un1t_user_id: 'u-once', stage: 'refused' })
    await expect(row({ un1t_user_id: 'u-once', stage: 'done' })).resolves.toBeDefined()
    for (const stage of ['sent', 'unknown', 'done']) {
      await expect(row({ un1t_user_id: 'u-once', stage })).rejects.toMatchObject({ code: '23505' })
    }
    // Another studio, or another person, is not blocked.
    await expect(row({ un1t_user_id: 'u-once', location_id: LOC_B, stage: 'done' })).resolves.toBeDefined()
    await expect(row({ un1t_user_id: 'u-other', stage: 'done' })).resolves.toBeDefined()
  })

  it('leaves the ledger closed to client roles', async () => {
    const { rows } = await db.query(`
      SELECT count(*)::int AS n FROM information_schema.table_privileges
       WHERE table_name = 'un1t_write_events' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`)
    expect(rows[0].n).toBe(0)
  })

  it('aborts on an op CHECK that drops a mig 744 op', async () => {
    const probe = new PGlite()
    try {
      await probe['exec'](SETUP_SQL)
      await probe['exec'](MIG_744)
      const broken = MIG_760.replace("'create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout', 'trial_regrant'));", "'trial', 'book', 'cancel', 'checkout', 'trial_regrant'));")
      expect(broken).not.toBe(MIG_760)
      await expect(probe['exec'](broken)).rejects.toThrow(/does not admit create_client/)
    } finally {
      await probe.close()
    }
  })
})
