// UN1TWRITE.1 — behavioural test for migration 742 (un1t.online write-back:
// the write ledger, the mirror's keep-the-CRM-write trigger, the terms columns
// on the /start queue and the refund_request approval kind).
//
// PGlite (PostgreSQL 17) with only what the file touches, in the shape prod
// holds on 18 Oct 2026: locations and contacts reduced to ids; un1t_bookings,
// un1t_clients and un1t_transactions as mig 726 made them; class_booking_requests
// as mig 335 plus 437/438/442's columns, with prod's ACL (authenticated arwd,
// RLS on, no policy); agent_membership_requests with mig 711's kind CHECK.
// The schema's default privileges are reset to the pre-677 shape (anon and
// authenticated get everything) so the file's own REVOKEs are what close the
// new table and function, not PGlite's defaults. Then the real 742 file runs.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_742 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/742_un1t_write_back.sql'), 'utf8')

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const CONTACT = 'c0000000-0000-0000-0000-00000000000c'
const T = '2026-10-18T10:00:00Z'
const at = (minutes) => new Date(Date.parse(T) + minutes * 60_000).toISOString()

const MIG_711_KINDS = [
  'pause', 'cancellation', 'class_booking', 'consultation', 'class_cancellation',
  'event_booking', 'event_cancellation', 'membership_purchase', 'event_move',
]

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)

let keySeq = 0
const nextKey = (prefix = 'k') => `${prefix}:${++keySeq}`

function ledgerRow(overrides = {}) {
  const row = {
    location_id: LOC, contact_id: CONTACT, un1t_user_id: 'u-1', op: 'book', origin: 'staff',
    idempotency_key: nextKey(), target: 'ev-1', stage: 'sent', method: null, message: null,
    ...overrides,
  }
  return db.query(
    `INSERT INTO public.un1t_write_events
       (location_id, contact_id, un1t_user_id, op, origin, idempotency_key, target, stage, method, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [row.location_id, row.contact_id, row.un1t_user_id, row.op, row.origin,
      row.idempotency_key, row.target, row.stage, row.method, row.message])
}

let bookingSeq = 0
async function crmBooking({ status, crmAt = T, eventId = 'ev-crm' }) {
  const un1tId = `bk-${++bookingSeq}`
  await db.query(
    `INSERT INTO public.un1t_bookings (location_id, un1t_id, un1t_user_id, event_id, status, synced_at, crm_written_at)
     VALUES ($1, $2, 'u-1', $3, $4, $5, $6)`, [LOC, un1tId, eventId, status, at(-30), crmAt])
  return un1tId
}
// The sync's upsert: every mapped column, never crm_written_at.
async function syncBooking(un1tId, { status, syncedAt, eventId = 'other' }) {
  await db.query(
    `INSERT INTO public.un1t_bookings (location_id, un1t_id, un1t_user_id, event_id, status, synced_at)
     VALUES ($1, $2, 'u-1', $3, $4, $5)
     ON CONFLICT (location_id, un1t_id) DO UPDATE
       SET un1t_user_id = EXCLUDED.un1t_user_id, event_id = EXCLUDED.event_id,
           status = EXCLUDED.status, synced_at = EXCLUDED.synced_at`,
    [LOC, un1tId, eventId, status, syncedAt])
  const { rows } = await db.query(
    `SELECT event_id, status, synced_at, crm_written_at FROM public.un1t_bookings WHERE location_id = $1 AND un1t_id = $2`,
    [LOC, un1tId])
  return rows[0]
}
const iso = (d) => new Date(d).toISOString()

beforeAll(async () => {
  db = new PGlite()
  await runSql(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    -- A database whose defaults were reset (pre-677): the file must close what it makes.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;

    CREATE TABLE public.locations (id uuid PRIMARY KEY);
    INSERT INTO public.locations VALUES ('${LOC}');
    CREATE TABLE public.contacts (id uuid PRIMARY KEY);
    INSERT INTO public.contacts VALUES ('${CONTACT}');

    CREATE TABLE public.un1t_clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
      un1t_user_id text NOT NULL,
      contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
      status text, credit_balance integer, credit_unlimited boolean, last_attended_at timestamptz,
      bookings_30d_attended integer, bookings_30d_no_show integer, ltv_cents integer,
      remote_created_at timestamptz, remote_updated_at timestamptz,
      synced_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (location_id, un1t_user_id)
    );
    CREATE TABLE public.un1t_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
      un1t_id text NOT NULL, un1t_user_id text,
      contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
      product_id text, product_title text, invoice_id text, type text, product_type text,
      amount_cents integer, currency text, refunded boolean, refund_status text,
      remote_created_at timestamptz, raw jsonb,
      synced_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (location_id, un1t_id)
    );
    CREATE TABLE public.un1t_bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
      un1t_id text NOT NULL, un1t_user_id text,
      contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
      event_id text, status text, source text, credit_charged boolean, has_guest boolean,
      external_member_ref text, external_booking_ref text,
      remote_created_at timestamptz, remote_updated_at timestamptz, raw jsonb,
      synced_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (location_id, un1t_id)
    );
    ALTER TABLE public.un1t_clients ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.un1t_transactions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.un1t_bookings ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.un1t_clients, public.un1t_transactions, public.un1t_bookings FROM anon, authenticated;

    CREATE TABLE public.agent_membership_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL
    );
    ALTER TABLE public.agent_membership_requests
      ADD CONSTRAINT agent_membership_requests_kind_check
      CHECK (kind = ANY (ARRAY[${MIG_711_KINDS.map((k) => `'${k}'::text`).join(', ')}]));

    CREATE TABLE public.class_booking_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
      contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
      glofox_event_id text NOT NULL, class_name text, starts_at timestamptz,
      customer_name text, customer_email text, customer_phone text,
      status text NOT NULL DEFAULT 'queued', attempts int NOT NULL DEFAULT 0, last_error text,
      glofox_booking_id text,
      approval_request_id uuid REFERENCES public.agent_membership_requests(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      trial_membership_id text, trial_plan_code text,
      payment_status text, payment_provider text, payment_provider_ref text,
      payment_checkout_token text, payment_checkout_url text, amount_cents integer, currency text,
      connected_account_id text
    );
    ALTER TABLE public.class_booking_requests ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.class_booking_requests FROM anon, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_booking_requests TO authenticated;
    INSERT INTO public.class_booking_requests (location_id, glofox_event_id) VALUES ('${LOC}', 'un1t:ev-old');
  `)
  await runSql(MIG_742)
}, 60_000)
afterAll(() => db?.close())

describe('mig 742 — un1t.online write-back core', () => {
  it('builds and passes its own self-check', async () => {
    const { rows } = await db.query(`
      SELECT c.relrowsecurity,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
             (SELECT count(*)::int FROM pg_indexes WHERE tablename = 'un1t_write_events'
                AND indexname IN ('un1t_write_events_one_open', 'un1t_write_events_one_done',
                                  'un1t_write_events_one_trial', 'un1t_write_events_contact_op')) AS indexes,
             (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'un1t_mirror_keep_crm_write' AND NOT tgisinternal) AS triggers
        FROM pg_class c WHERE c.oid = 'public.un1t_write_events'::regclass`)
    expect(rows[0]).toEqual({ relrowsecurity: true, policies: 0, indexes: 4, triggers: 3 })
    const cols = await db.query(`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'crm_written_at' ORDER BY table_name`)
    expect(cols.rows.map((r) => r.table_name)).toEqual(['un1t_bookings', 'un1t_clients', 'un1t_transactions'])
  })

  it('is idempotent: a second run passes and changes nothing', async () => {
    await expect(runSql(MIG_742)).resolves.toBeDefined()
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'un1t_mirror_keep_crm_write'`)
    expect(rows[0].n).toBe(3)
  })

  describe('ledger', () => {
    it('a second open (sent/unknown) row for one key is refused 23505', async () => {
      const key = nextKey('book')
      await ledgerRow({ idempotency_key: key, stage: 'sent' })
      await expect(ledgerRow({ idempotency_key: key, stage: 'unknown' })).rejects.toMatchObject({ code: '23505' })
      await expect(ledgerRow({ idempotency_key: key, stage: 'sent' })).rejects.toMatchObject({ code: '23505' })
      // A closed attempt beside the open one is history, not a second attempt in flight.
      await expect(ledgerRow({ idempotency_key: key, stage: 'refused' })).resolves.toBeDefined()
    })

    it('a second done create_client, trial or forgot_password row for one key is refused', async () => {
      for (const [op, method, user] of [['create_client', null, null], ['trial', 'charge', 'u-done'], ['forgot_password', null, 'u-pw']]) {
        const key = nextKey(op)
        await ledgerRow({ op, method, un1t_user_id: user, target: 'p-done', idempotency_key: key, stage: 'done' })
        await expect(ledgerRow({ op, method, un1t_user_id: user, target: 'p-done', idempotency_key: key, stage: 'done' }))
          .rejects.toMatchObject({ code: '23505' })
      }
    })

    it('a done trial by charge then a done trial by free_checkout for the same user and product is refused', async () => {
      await ledgerRow({ op: 'trial', method: 'charge', un1t_user_id: 'u-2', target: 'prod-trial', idempotency_key: `trial:${LOC}:u-2:prod-trial:charge`, stage: 'done' })
      await expect(ledgerRow({ op: 'trial', method: 'free_checkout', un1t_user_id: 'u-2', target: 'prod-trial', idempotency_key: `trial:${LOC}:u-2:prod-trial:free_checkout`, stage: 'done' }))
        .rejects.toMatchObject({ code: '23505' })
      // The refused charge plus a done free checkout is the normal 6.6 path.
      await ledgerRow({ op: 'trial', method: 'charge', un1t_user_id: 'u-3', target: 'prod-trial', stage: 'refused' })
      await expect(ledgerRow({ op: 'trial', method: 'free_checkout', un1t_user_id: 'u-3', target: 'prod-trial', stage: 'done' })).resolves.toBeDefined()
    })

    it('two done book rows for one key are allowed (rebook after cancel)', async () => {
      const key = `book:${LOC}:u-1:ev-rebook`
      await ledgerRow({ op: 'book', idempotency_key: key, stage: 'done' })
      await expect(ledgerRow({ op: 'book', idempotency_key: key, stage: 'done' })).resolves.toBeDefined()
    })

    it('trial row without method, or a book row with method, is refused', async () => {
      await expect(ledgerRow({ op: 'trial', method: null })).rejects.toMatchObject({ code: '23514' })
      await expect(ledgerRow({ op: 'book', method: 'charge' })).rejects.toMatchObject({ code: '23514' })
      await expect(ledgerRow({ op: 'trial', method: 'gift' })).rejects.toMatchObject({ code: '23514' })
    })

    it('op, origin and stage outside their lists, and a message over 500 chars, are refused', async () => {
      await expect(ledgerRow({ op: 'refund' })).rejects.toMatchObject({ code: '23514' })
      await expect(ledgerRow({ origin: 'cron' })).rejects.toMatchObject({ code: '23514' })
      await expect(ledgerRow({ stage: 'failed' })).rejects.toMatchObject({ code: '23514' })
      await expect(ledgerRow({ message: 'x'.repeat(501) })).rejects.toMatchObject({ code: '23514' })
      await expect(ledgerRow({ message: 'x'.repeat(500) })).resolves.toBeDefined()
    })
  })

  describe('un1t_mirror_keep_crm_write', () => {
    it('sync upsert pulled before the CRM write keeps every CRM column and takes the new synced_at', async () => {
      const id = await crmBooking({ status: 'booked' })
      const row = await syncBooking(id, { status: 'booked', syncedAt: at(-1), eventId: 'other' })
      expect(row.event_id).toBe('ev-crm')
      expect(row.status).toBe('booked')
      expect(iso(row.synced_at)).toBe(at(-1))
      expect(iso(row.crm_written_at)).toBe(iso(T))
    })

    it('sync terminal status beats a CRM booked whatever the times', async () => {
      const id = await crmBooking({ status: 'booked' })
      const row = await syncBooking(id, { status: 'attended', syncedAt: at(-5) })
      expect(row.status).toBe('attended')
      expect(row.event_id).toBe('other')
    })

    it('sync booked from an older pull does not undo a CRM cancelled', async () => {
      const id = await crmBooking({ status: 'cancelled' })
      const row = await syncBooking(id, { status: 'booked', syncedAt: at(-1) })
      expect(row.status).toBe('cancelled')
      expect(row.event_id).toBe('ev-crm')
      expect(iso(row.synced_at)).toBe(at(-1))
    })

    it('sync pulled after the CRM write wins', async () => {
      const id = await crmBooking({ status: 'cancelled' })
      const row = await syncBooking(id, { status: 'booked', syncedAt: at(1) })
      expect(row).toMatchObject({ status: 'booked', event_id: 'other' })
      expect(iso(row.synced_at)).toBe(at(1))
    })

    it("the CRM's own next write passes", async () => {
      const id = await crmBooking({ status: 'booked' })
      await db.query(
        `UPDATE public.un1t_bookings SET status = 'cancelled', event_id = 'ev-next', crm_written_at = $3, synced_at = $4
          WHERE location_id = $1 AND un1t_id = $2`, [LOC, id, at(10), at(-60)])
      const { rows } = await db.query(`SELECT status, event_id FROM public.un1t_bookings WHERE un1t_id = $1`, [id])
      expect(rows[0]).toEqual({ status: 'cancelled', event_id: 'ev-next' })
    })

    it('a row the CRM never wrote takes every sync upsert', async () => {
      const id = await crmBooking({ status: 'booked', crmAt: null })
      const row = await syncBooking(id, { status: 'booked', syncedAt: at(-100) })
      expect(row.event_id).toBe('other')
    })

    it('the time rule applies on un1t_clients and un1t_transactions; the rank rule only on un1t_bookings', async () => {
      await db.query(
        `INSERT INTO public.un1t_clients (location_id, un1t_user_id, status, credit_balance, synced_at, crm_written_at)
         VALUES ($1, 'u-cl', 'booked', 5, $2, $3)`, [LOC, at(-30), T])
      const upsertClient = async (status, credits, syncedAt) => {
        await db.query(
          `INSERT INTO public.un1t_clients (location_id, un1t_user_id, status, credit_balance, synced_at)
           VALUES ($1, 'u-cl', $2, $3, $4)
           ON CONFLICT (location_id, un1t_user_id) DO UPDATE
             SET status = EXCLUDED.status, credit_balance = EXCLUDED.credit_balance, synced_at = EXCLUDED.synced_at`,
          [LOC, status, credits, syncedAt])
        return (await db.query(`SELECT status, credit_balance, synced_at FROM public.un1t_clients WHERE un1t_user_id = 'u-cl'`)).rows[0]
      }
      // A "terminal" status word on a client row is not ranked: the older pull loses.
      let client = await upsertClient('cancelled', 4, at(-1))
      expect(client).toMatchObject({ status: 'booked', credit_balance: 5 })
      expect(iso(client.synced_at)).toBe(at(-1))
      client = await upsertClient('cancelled', 4, at(1))
      expect(client).toMatchObject({ status: 'cancelled', credit_balance: 4 })

      await db.query(
        `INSERT INTO public.un1t_transactions (location_id, un1t_id, product_title, amount_cents, raw, synced_at, crm_written_at)
         VALUES ($1, 'tx-1', 'The Trial', 0, '{"source":"crm_write"}', $2, $3)`, [LOC, at(-30), T])
      const upsertTx = async (title, syncedAt) => {
        await db.query(
          `INSERT INTO public.un1t_transactions (location_id, un1t_id, product_title, amount_cents, raw, synced_at)
           VALUES ($1, 'tx-1', $2, 0, '{"source":"sync"}', $3)
           ON CONFLICT (location_id, un1t_id) DO UPDATE
             SET product_title = EXCLUDED.product_title, raw = EXCLUDED.raw, synced_at = EXCLUDED.synced_at`,
          [LOC, title, syncedAt])
        return (await db.query(`SELECT product_title, raw, synced_at FROM public.un1t_transactions WHERE un1t_id = 'tx-1'`)).rows[0]
      }
      let tx = await upsertTx('Synced Title', at(-2))
      expect(tx).toMatchObject({ product_title: 'The Trial', raw: { source: 'crm_write' } })
      expect(iso(tx.synced_at)).toBe(at(-2))
      tx = await upsertTx('Synced Title', at(2))
      expect(tx).toMatchObject({ product_title: 'Synced Title', raw: { source: 'sync' } })
    })
  })

  it('refund_request is an allowed kind and every kind from mig 711 still is', async () => {
    for (const kind of [...MIG_711_KINDS, 'refund_request']) {
      await expect(db.query(`INSERT INTO public.agent_membership_requests (kind) VALUES ($1)`, [kind])).resolves.toBeDefined()
    }
    await expect(db.query(`INSERT INTO public.agent_membership_requests (kind) VALUES ('refund')`))
      .rejects.toMatchObject({ code: '23514' })
  })

  describe('class_booking_requests terms columns', () => {
    const insertCbr = (cols, vals) => db.query(
      `INSERT INTO public.class_booking_requests (location_id, glofox_event_id${cols.map((c) => `, ${c}`).join('')})
       VALUES ($1, 'un1t:ev-1'${vals.map((_, i) => `, $${i + 2}`).join('')}) RETURNING id`, [LOC, ...vals])

    it('terms_source outside the three values is refused; terms_accepted_at without terms_source is refused', async () => {
      await expect(insertCbr(['terms_accepted_at', 'terms_source'], [T, 'email'])).rejects.toMatchObject({ code: '23514' })
      await expect(insertCbr(['terms_accepted_at'], [T])).rejects.toMatchObject({ code: '23514' })
      await expect(insertCbr(['terms_source'], ['website'])).rejects.toMatchObject({ code: '23514' })
      for (const source of ['website', 'whatsapp_flow', 'test_account']) {
        await expect(insertCbr(['terms_accepted_at', 'terms_source', 'terms_version'], [T, source, '2026-10'])).resolves.toBeDefined()
      }
    })

    it('a row with no terms (every existing row) is fine, and un1t_steps holds the funnel record', async () => {
      await expect(insertCbr([], [])).resolves.toBeDefined()
      const steps = { explanation_email: 'sent', forgot_password: 'done', booking_confirmation: 'sent', skips: ['trial'] }
      const { rows } = await insertCbr(['un1t_steps'], [JSON.stringify(steps)])
      const read = await db.query(`SELECT un1t_steps FROM public.class_booking_requests WHERE id = $1`, [rows[0].id])
      expect(read.rows[0].un1t_steps).toEqual(steps)
    })
  })

  it('anon and authenticated hold no privilege on un1t_write_events and cannot execute the trigger function', async () => {
    const { rows } = await db.query(`
      SELECT has_table_privilege('authenticated', 'public.un1t_write_events', 'SELECT') AS auth_select,
             has_table_privilege('authenticated', 'public.un1t_write_events', 'INSERT') AS auth_insert,
             has_table_privilege('anon', 'public.un1t_write_events', 'SELECT') AS anon_select,
             has_table_privilege('service_role', 'public.un1t_write_events', 'INSERT') AS service_insert,
             has_function_privilege('anon', 'public.un1t_mirror_keep_crm_write()', 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', 'public.un1t_mirror_keep_crm_write()', 'EXECUTE') AS auth_exec,
             (SELECT count(*)::int FROM information_schema.table_privileges
               WHERE table_schema = 'public' AND table_name = 'un1t_write_events'
                 AND grantee IN ('anon', 'authenticated', 'PUBLIC')) AS client_grants`)
    expect(rows[0]).toEqual({
      auth_select: false, auth_insert: false, anon_select: false, service_insert: true,
      anon_exec: false, auth_exec: false, client_grants: 0,
    })
  })
})
