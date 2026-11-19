// ORDERSMORE.1 (mig 856) — paid class bookings, donations, staff payment links
// and class fees are projected into orders; a donation refunded outside the
// ledger marks its order refunded; a projection failure never fails the write.
// Run on real Postgres (PGlite).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const SQL = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/856_orders_bookings_donations_links_fees.sql'), 'utf8')
const LOC = '00000000-0000-4000-8000-0000000000aa'
const ORG = '00000000-0000-4000-8000-0000000000ab'
const RACE = '00000000-0000-4000-8000-0000000000ac'
const CONTACT = '00000000-0000-4000-8000-0000000000ad'
const ORPHAN = '00000000-0000-4000-8000-0000000000ae'
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PRE_DON_PAID = id(901)
const PRE_DON_REFUNDED = id(902)

let pg
const q = async (text, params) => (await pg.query(text, params)).rows
const orderFor = async (sourceId) => (await q('SELECT * FROM public.orders WHERE source_id = $1', [sourceId]))

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE SCHEMA private;
    CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid);
    CREATE TABLE public.contacts (id uuid PRIMARY KEY, email text, phone text, name text);
    CREATE TABLE public.error_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(),
      route_path text, route_type text, name text, message text);
    CREATE TABLE public.orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, organization_id uuid,
      source_type text NOT NULL, source_id uuid NOT NULL, contact_id uuid, contact_email text NOT NULL,
      contact_phone text, contact_name text, amount_cents integer NOT NULL, currency text NOT NULL DEFAULT 'EUR',
      status text NOT NULL, payment_provider text, payment_provider_ref text, connected_account_id text,
      completed_at timestamptz, refunded_at timestamptz, refunded_amount_cents integer, metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT orders_source_type_check CHECK (source_type = ANY (ARRAY['race_registration','car_deposit','trial_purchase','offer_purchase'])),
      CONSTRAINT orders_source_unique UNIQUE (source_type, source_id)
    );
    CREATE TABLE public.class_booking_requests (
      id uuid PRIMARY KEY, location_id uuid NOT NULL, contact_id uuid, class_name text, starts_at timestamptz,
      customer_name text, customer_email text, customer_phone text, status text, payment_status text,
      payment_provider text, payment_provider_ref text, amount_cents integer, currency text, connected_account_id text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.donations (
      id uuid PRIMARY KEY, race_event_id uuid NOT NULL, location_id uuid NOT NULL, contact_id uuid, donor_name text NOT NULL,
      donor_email text NOT NULL, amount_cents integer NOT NULL, currency text NOT NULL DEFAULT 'EUR', status text NOT NULL,
      payment_provider text, payment_provider_ref text, connected_account_id text, paid_at timestamptz, refunded_at timestamptz
    );
    CREATE TABLE public.staff_payment_links (
      id uuid PRIMARY KEY, location_id uuid NOT NULL, contact_id uuid NOT NULL, un1t_product_id text NOT NULL, product_title text,
      price_cents integer, status text NOT NULL, paid_transaction_id text, paid_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.class_fees (
      id uuid PRIMARY KEY, location_id uuid NOT NULL, contact_id uuid, class_title text, starts_at timestamptz, kind text NOT NULL,
      amount_cents integer NOT NULL, currency text NOT NULL, status text NOT NULL, charged_at timestamptz, un1t_transaction_id text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `)
  await q('INSERT INTO public.locations VALUES ($1, $2)', [LOC, ORG])
  await q("INSERT INTO public.contacts VALUES ($1, 'm@x.ie', '0851234567', 'Mo Member')", [CONTACT])
  await q(`INSERT INTO public.donations (id, race_event_id, location_id, donor_name, donor_email, amount_cents, status, payment_provider, payment_provider_ref, paid_at)
           VALUES ($1, $2, $3, 'Dee', 'd@x.ie', 2500, 'paid', 'revolut', 'rev-d1', '2026-11-01T10:00:00Z')`, [PRE_DON_PAID, RACE, LOC])
  await q(`INSERT INTO public.donations (id, race_event_id, location_id, donor_name, donor_email, amount_cents, status, payment_provider, payment_provider_ref, paid_at, refunded_at)
           VALUES ($1, $2, $3, 'Ed', 'e@x.ie', 1000, 'refunded', 'revolut', 'rev-d2', '2026-11-01T10:00:00Z', '2026-11-03T10:00:00Z')`, [PRE_DON_REFUNDED, RACE, LOC])
  await pg.exec(SQL)
}, 60_000)
afterAll(async () => { await pg?.close() })
beforeEach(async () => {
  await pg.exec(`DELETE FROM public.error_events;
    DELETE FROM public.orders WHERE source_id NOT IN ('${PRE_DON_PAID}', '${PRE_DON_REFUNDED}');
    DELETE FROM public.class_booking_requests; DELETE FROM public.staff_payment_links; DELETE FROM public.class_fees;
    DELETE FROM public.donations WHERE id NOT IN ('${PRE_DON_PAID}', '${PRE_DON_REFUNDED}');`)
})

describe('backfill', () => {
  it('copies paid donations, and a refunded one arrives refunded', async () => {
    expect((await orderFor(PRE_DON_PAID))[0]).toMatchObject({ source_type: 'donation', status: 'completed', amount_cents: 2500, organization_id: ORG })
    expect((await orderFor(PRE_DON_REFUNDED))[0]).toMatchObject({ status: 'refunded', refunded_amount_cents: 1000 })
  })
})

describe('class_booking_requests', () => {
  it('a paid booking is an order; a pending one is not', async () => {
    await q(`INSERT INTO public.class_booking_requests (id, location_id, customer_email, customer_name, class_name, payment_status, payment_provider, payment_provider_ref, amount_cents, currency)
             VALUES ($1, $2, 'b@x.ie', 'Bea', 'HYROX', 'pending', 'revolut', 'rev-b', 1500, 'EUR')`, [id(1), LOC])
    expect(await orderFor(id(1))).toHaveLength(0)
    await q(`UPDATE public.class_booking_requests SET payment_status = 'paid' WHERE id = $1`, [id(1)])
    const [o] = await orderFor(id(1))
    expect(o).toMatchObject({ source_type: 'class_booking', status: 'completed', payment_provider_ref: 'rev-b', contact_name: 'Bea' })
    expect(o.metadata.class_name).toBe('HYROX')
  })
})

describe('donations', () => {
  it('becomes an order when paid, and follows a refund made outside the ledger', async () => {
    await q(`INSERT INTO public.donations (id, race_event_id, location_id, donor_name, donor_email, amount_cents, status, payment_provider)
             VALUES ($1, $2, $3, 'Fi', 'f@x.ie', 5000, 'awaiting_payment', 'stripe_connect')`, [id(2), RACE, LOC])
    expect(await orderFor(id(2))).toHaveLength(0)
    await q(`UPDATE public.donations SET status = 'paid', paid_at = now(), payment_provider_ref = 'pi_9', connected_account_id = 'acct_9' WHERE id = $1`, [id(2)])
    expect((await orderFor(id(2)))[0]).toMatchObject({ status: 'completed', connected_account_id: 'acct_9' })
    await q(`UPDATE public.donations SET status = 'refunded', refunded_at = now() WHERE id = $1`, [id(2)])
    expect((await orderFor(id(2)))[0]).toMatchObject({ status: 'refunded', refunded_amount_cents: 5000 })
  })

  it('a donation refunded through the ledger first leaves the order as the ledger wrote it', async () => {
    await q(`INSERT INTO public.donations (id, race_event_id, location_id, donor_name, donor_email, amount_cents, status, payment_provider, paid_at)
             VALUES ($1, $2, $3, 'Gu', 'g@x.ie', 5000, 'paid', 'revolut', now())`, [id(3), RACE, LOC])
    await q(`UPDATE public.orders SET status = 'refunded', refunded_amount_cents = 5000, refunded_at = '2026-11-10T00:00:00Z' WHERE source_id = $1`, [id(3)])
    await q(`UPDATE public.donations SET status = 'refunded', refunded_at = now() WHERE id = $1`, [id(3)])
    const [o] = await orderFor(id(3))
    expect(new Date(o.refunded_at).toISOString()).toBe('2026-11-10T00:00:00.000Z')
  })
})

describe('staff_payment_links and class_fees (un1t.online)', () => {
  it('a paid link is an order with the contact details', async () => {
    await q(`INSERT INTO public.staff_payment_links (id, location_id, contact_id, un1t_product_id, product_title, price_cents, status)
             VALUES ($1, $2, $3, 'prod-1', '1 Month', 9900, 'sent')`, [id(4), LOC, CONTACT])
    expect(await orderFor(id(4))).toHaveLength(0)
    await q(`UPDATE public.staff_payment_links SET status = 'paid', paid_at = now(), paid_transaction_id = 'tx-4' WHERE id = $1`, [id(4)])
    expect((await orderFor(id(4)))[0]).toMatchObject({ payment_provider: 'un1t_online', payment_provider_ref: 'tx-4',
      contact_email: 'm@x.ie', contact_name: 'Mo Member', amount_cents: 9900 })
  })

  it('a charged fee is an order; a contact that is gone leaves an empty email, not a failure', async () => {
    await q(`INSERT INTO public.class_fees (id, location_id, contact_id, class_title, kind, amount_cents, currency, status, charged_at, un1t_transaction_id)
             VALUES ($1, $2, $3, 'Strength', 'late_cancel', 1000, 'EUR', 'charged', now(), 'tx-5')`, [id(5), LOC, ORPHAN])
    expect((await orderFor(id(5)))[0]).toMatchObject({ source_type: 'class_fee', contact_email: '', payment_provider_ref: 'tx-5' })
    expect(await q('SELECT * FROM public.error_events')).toEqual([])
  })

  it('a waived fee is not an order', async () => {
    await q(`INSERT INTO public.class_fees (id, location_id, contact_id, class_title, kind, amount_cents, currency, status)
             VALUES ($1, $2, $3, 'Strength', 'no_show', 1000, 'EUR', 'waived')`, [id(6), LOC, CONTACT])
    expect(await orderFor(id(6))).toHaveLength(0)
  })
})

describe('a projection failure', () => {
  it('is recorded and the write stands', async () => {
    await pg.exec('ALTER TABLE public.orders ADD CONSTRAINT boom CHECK (amount_cents < 0) NOT VALID')
    try {
      await q(`INSERT INTO public.class_fees (id, location_id, contact_id, class_title, kind, amount_cents, currency, status, charged_at, un1t_transaction_id)
               VALUES ($1, $2, $3, 'Strength', 'late_cancel', 1000, 'EUR', 'charged', now(), 'tx-7')`, [id(7), LOC, CONTACT])
      expect(await q('SELECT id FROM public.class_fees WHERE id = $1', [id(7)])).toHaveLength(1)
      const [e] = await q('SELECT route_type, name, message FROM public.error_events')
      expect(e).toMatchObject({ route_type: 'db_trigger', name: 'order_projection_failed' })
      expect(e.message).toContain(id(7))
    } finally {
      await pg.exec('ALTER TABLE public.orders DROP CONSTRAINT boom')
    }
  })
})
