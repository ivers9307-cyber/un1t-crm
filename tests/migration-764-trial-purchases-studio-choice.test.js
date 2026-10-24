// TRIALSTUDIO.1 — behavioural test for migration 764 (trial_purchases gains
// the un1t.online columns and the help/handled/expired statuses, and the write
// ledger admits the 'web_trial' origin).
//
// PGlite (PostgreSQL 17): the tables mig 744 and 762 touch, reduced to what
// they need, then the real 744, 762 and 764 files. Fictional ids only: the
// repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_744 = MIG('744_un1t_write_back.sql')
const MIG_762 = MIG('762_trial_purchases.sql')
const MIG_764 = MIG('764_trial_purchases_studio_choice.sql')

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const CONTACT = 'c0000000-0000-0000-0000-00000000000c'

const SETUP_SQL = `
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;

    CREATE TABLE public.locations (id uuid PRIMARY KEY);
    INSERT INTO public.locations VALUES ('${LOC}');
    CREATE TABLE public.contacts (id uuid PRIMARY KEY);
    INSERT INTO public.contacts VALUES ('${CONTACT}');

    CREATE TABLE public.cron_heartbeats (
      name text PRIMARY KEY, expected_interval_seconds integer, grace_seconds integer, last_ok_at timestamptz);
    CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS
      $fn$ BEGIN NEW.updated_at = now(); RETURN NEW; END $fn$;

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

function ledgerRow(over = {}) {
  const r = {
    location_id: LOC, contact_id: CONTACT, un1t_user_id: 'u-1', op: 'checkout', origin: 'staff',
    idempotency_key: `k:${++seq}`, target: null, stage: 'sent', method: null, ...over,
  }
  return db.query(
    `INSERT INTO public.un1t_write_events
       (location_id, contact_id, un1t_user_id, op, origin, idempotency_key, target, stage, method)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [r.location_id, r.contact_id, r.un1t_user_id, r.op, r.origin, r.idempotency_key, r.target, r.stage, r.method])
}

// A Stillorgan-shaped row (Glofox membership and plan) in the given status.
function insertStatus(status) {
  return db.query(
    `INSERT INTO public.trial_purchases
       (location_id, customer_email, product_name, membership_id, plan_code, amount_cents, status)
     VALUES ($1, 'b@example.com', 'The UN1T Trial', 'm-1', 'plan-1', 3900, $2) RETURNING id`,
    [LOC, status])
}

beforeAll(async () => {
  db = new PGlite()
  await runSql(SETUP_SQL)
  await runSql(MIG_744)
  await runSql(MIG_762)
  await runSql(MIG_764)
}, 60_000)
afterAll(() => db?.close())

describe('mig 764 — trial_purchases studio choice', () => {
  it('builds, passes its own self-check and is idempotent', async () => {
    await expect(runSql(MIG_764)).resolves.toBeDefined()
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'idx_trial_purchases_un1t_open'`)
    expect(rows[0].n).toBe(1)
  })

  it('a trial_purchases row with no Glofox plan but a un1t product is accepted', async () => {
    const { rows } = await db.query(
      `INSERT INTO public.trial_purchases
         (location_id, customer_email, product_name, amount_cents, payment_provider, un1t_product_id,
          un1t_user_id, un1t_ledger_id, terms_accepted_at, terms_source, terms_version, status)
       VALUES ($1, 'a@example.com', 'The UN1T Trial', 3900, 'un1t_online', 'p-1',
          'u-1', gen_random_uuid(), now(), 'trial_page', 'v1', 'awaiting_payment')
       RETURNING membership_id, plan_code, un1t_product_id, un1t_user_id, un1t_ledger_id, terms_version`, [LOC])
    expect(rows[0].membership_id).toBeNull()
    expect(rows[0].plan_code).toBeNull()
    expect(rows[0].un1t_product_id).toBe('p-1')
    expect(rows[0].terms_version).toBe('v1')
  })

  it('every status from mig 762 and the three new ones are accepted; a made-up one is refused', async () => {
    for (const s of ['awaiting_payment', 'queued', 'processing', 'granted', 'needs_review', 'failed', 'payment_failed',
      'help_requested', 'handled', 'expired']) {
      await expect(insertStatus(s)).resolves.toBeTruthy()
    }
    await expect(insertStatus('bogus')).rejects.toMatchObject({ code: '23514' })
  })

  it('the open-checkout index is partial on un1t_online + awaiting_payment', async () => {
    const { rows } = await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_trial_purchases_un1t_open'`)
    expect(rows[0].indexdef).toContain('(created_at)')
    expect(rows[0].indexdef).toContain(`payment_provider = 'un1t_online'`)
    expect(rows[0].indexdef).toContain(`status = 'awaiting_payment'`)
  })

  it("un1t_write_events accepts origin 'web_trial', every mig 744 origin, and still refuses 'cron'", async () => {
    await expect(ledgerRow({ origin: 'web_trial' })).resolves.toBeTruthy()
    for (const origin of ['staff', 'funnel', 'approval', 'mia', 'test_account']) {
      await expect(ledgerRow({ origin })).resolves.toBeTruthy()
    }
    await expect(ledgerRow({ origin: 'cron' })).rejects.toMatchObject({ code: '23514' })
  })

  it('anon and authenticated hold nothing on trial_purchases after 764', async () => {
    const { rows } = await db.query(`
      SELECT count(*)::int AS n FROM information_schema.table_privileges
       WHERE table_name = 'trial_purchases' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`)
    expect(rows[0].n).toBe(0)
    const col = await db.query(`
      SELECT count(*)::int AS n FROM information_schema.column_privileges
       WHERE table_name = 'trial_purchases' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`)
    expect(col.rows[0].n).toBe(0)
  })

  it('aborts on a status CHECK that drops a mig 762 status', async () => {
    const probe = new PGlite()
    try {
      await probe['exec'](SETUP_SQL)
      await probe['exec'](MIG_744)
      await probe['exec'](MIG_762)
      const broken = MIG_764.replace("'granted', 'needs_review', 'failed',", "'granted', 'failed',")
      expect(broken).not.toBe(MIG_764)
      await expect(probe['exec'](broken)).rejects.toThrow(/does not admit needs_review/)
    } finally {
      await probe.close()
    }
  })
})
