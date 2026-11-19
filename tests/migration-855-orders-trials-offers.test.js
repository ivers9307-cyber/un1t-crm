// ORDERSTRIALS.1 (mig 855) — paid trials and offer sales are projected into
// orders by trigger, and a projection failure never fails the payment write.
// Run on real Postgres (PGlite).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const SQL = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/855_orders_trials_offers.sql'), 'utf8')
const LOC = '00000000-0000-4000-8000-0000000000aa'
const ORG = '00000000-0000-4000-8000-0000000000ab'
const OFFER = '00000000-0000-4000-8000-0000000000ac'
const T1 = '00000000-0000-4000-8000-000000000001'
const T2 = '00000000-0000-4000-8000-000000000002'
const P1 = '00000000-0000-4000-8000-000000000011'
const P2 = '00000000-0000-4000-8000-000000000012'
const P3 = '00000000-0000-4000-8000-000000000013'
const PRE_TRIAL = '00000000-0000-4000-8000-000000000021'
const PRE_OFFER = '00000000-0000-4000-8000-000000000022'

let pg
const q = async (text, params) => (await pg.query(text, params)).rows
const ordersFor = async (id) => q('SELECT * FROM public.orders WHERE source_id = $1', [id])

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE SCHEMA private;
    CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid);
    CREATE TABLE public.sale_offers (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.error_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(),
      route_path text, route_type text, name text, message text);
    CREATE TABLE public.orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, organization_id uuid,
      source_type text NOT NULL, source_id uuid NOT NULL, contact_id uuid, contact_email text NOT NULL,
      contact_phone text, contact_name text, amount_cents integer NOT NULL, currency text NOT NULL DEFAULT 'EUR',
      status text NOT NULL, payment_provider text, payment_provider_ref text, connected_account_id text,
      completed_at timestamptz, refunded_at timestamptz, refunded_amount_cents integer, metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT orders_source_type_check CHECK (source_type = ANY (ARRAY['race_registration','car_deposit'])),
      CONSTRAINT orders_source_unique UNIQUE (source_type, source_id)
    );
    CREATE TABLE public.trial_purchases (
      id uuid PRIMARY KEY, location_id uuid NOT NULL, contact_id uuid, customer_name text, first_name text,
      last_name text, customer_email text NOT NULL, customer_phone text, product_name text NOT NULL,
      amount_cents integer NOT NULL, currency text DEFAULT 'EUR', payment_provider text, payment_provider_ref text,
      connected_account_id text, paid_at timestamptz, status text
    );
    CREATE TABLE public.offer_purchases (
      id uuid PRIMARY KEY, offer_id uuid NOT NULL, location_id uuid NOT NULL, buyer_name text NOT NULL,
      buyer_email text NOT NULL, buyer_phone text NOT NULL DEFAULT '', contact_id uuid, revolut_order_id text,
      amount_cents integer NOT NULL, currency text NOT NULL DEFAULT 'EUR', state text NOT NULL DEFAULT 'created',
      paid_at timestamptz, payment_provider text NOT NULL DEFAULT 'revolut', origin text NOT NULL DEFAULT 'page',
      un1t_transaction_id text, updated_at timestamptz NOT NULL DEFAULT now()
    );
  `)
  await q('INSERT INTO public.locations VALUES ($1, $2)', [LOC, ORG])
  await q("INSERT INTO public.sale_offers VALUES ($1, '30 + 10 pack')", [OFFER])
  // Paid before the migration: the backfill must pick these up.
  await q(`INSERT INTO public.trial_purchases (id, location_id, customer_email, first_name, last_name, product_name, amount_cents,
           payment_provider, payment_provider_ref, paid_at, status) VALUES ($1, $2, 'pre@x.ie', 'Pre', 'Trial', '14 Day Reset', 3900,
           'revolut', 'rev-pre', '2026-11-01T10:00:00Z', 'granted')`, [PRE_TRIAL, LOC])
  await q(`INSERT INTO public.offer_purchases (id, offer_id, location_id, buyer_name, buyer_email, revolut_order_id, amount_cents, state, paid_at)
           VALUES ($1, $2, $3, 'Pre Buyer', 'buy@x.ie', 'rev-off-pre', 38000, 'paid', '2026-11-02T10:00:00Z')`, [PRE_OFFER, OFFER, LOC])
  await pg.exec(SQL)
}, 60_000)
afterAll(async () => { await pg?.close() })
beforeEach(async () => {
  await pg.exec(`DELETE FROM public.error_events;
    DELETE FROM public.orders WHERE source_id NOT IN ('${PRE_TRIAL}', '${PRE_OFFER}');
    DELETE FROM public.trial_purchases WHERE id <> '${PRE_TRIAL}';
    DELETE FROM public.offer_purchases WHERE id <> '${PRE_OFFER}';`)
})

describe('backfill', () => {
  it('copies trials and offers paid before the migration as completed orders', async () => {
    const [t] = await ordersFor(PRE_TRIAL)
    expect(t).toMatchObject({ source_type: 'trial_purchase', status: 'completed', amount_cents: 3900, contact_name: 'Pre Trial',
      payment_provider: 'revolut', payment_provider_ref: 'rev-pre', organization_id: ORG })
    expect(t.metadata).toEqual({ product_name: '14 Day Reset' })
    const [o] = await ordersFor(PRE_OFFER)
    expect(o).toMatchObject({ source_type: 'offer_purchase', status: 'completed', amount_cents: 38000, payment_provider_ref: 'rev-off-pre' })
    expect(o.metadata).toEqual({ offer_id: OFFER, offer_name: '30 + 10 pack' })
  })
})

describe('trial_purchases trigger', () => {
  it('an unpaid checkout is not an order; paying it makes one', async () => {
    await q(`INSERT INTO public.trial_purchases (id, location_id, customer_email, customer_name, product_name, amount_cents, payment_provider, status)
             VALUES ($1, $2, 'a@x.ie', 'Ann', 'Trial', 3900, 'stripe_connect', 'awaiting_payment')`, [T1, LOC])
    expect(await ordersFor(T1)).toHaveLength(0)
    await q(`UPDATE public.trial_purchases SET paid_at = now(), payment_provider_ref = 'pi_1', connected_account_id = 'acct_1' WHERE id = $1`, [T1])
    const rows = await ordersFor(T1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'completed', payment_provider: 'stripe_connect', payment_provider_ref: 'pi_1', connected_account_id: 'acct_1' })
  })

  it('fills in a contact learned later, and never touches status or refunds', async () => {
    await q(`INSERT INTO public.trial_purchases (id, location_id, customer_email, product_name, amount_cents, payment_provider, payment_provider_ref, paid_at)
             VALUES ($1, $2, 'b@x.ie', 'Trial', 3900, 'revolut', 'rev-1', now())`, [T2, LOC])
    await q(`UPDATE public.orders SET status = 'refunded', refunded_amount_cents = 3900 WHERE source_id = $1`, [T2])
    const contact = '00000000-0000-4000-8000-0000000000cc'
    await q('UPDATE public.trial_purchases SET contact_id = $1 WHERE id = $2', [contact, T2])
    const [o] = await ordersFor(T2)
    expect(o).toMatchObject({ contact_id: contact, status: 'refunded', refunded_amount_cents: 3900 })
  })

  it('a projection failure is recorded and the payment write still stands', async () => {
    await pg.exec('ALTER TABLE public.orders ADD CONSTRAINT boom CHECK (amount_cents < 0) NOT VALID')
    try {
      await q(`INSERT INTO public.trial_purchases (id, location_id, customer_email, product_name, amount_cents, payment_provider, paid_at)
               VALUES ($1, $2, 'c@x.ie', 'Trial', 3900, 'revolut', now())`, [T1, LOC])
      expect(await q('SELECT id FROM public.trial_purchases WHERE id = $1', [T1])).toHaveLength(1)
      expect(await ordersFor(T1)).toHaveLength(0)
      const [e] = await q('SELECT route_type, name, message FROM public.error_events')
      expect(e).toMatchObject({ route_type: 'db_trigger', name: 'order_projection_failed' })
      expect(e.message).toContain(T1)
    } finally {
      await pg.exec('ALTER TABLE public.orders DROP CONSTRAINT boom')
    }
  })
})

describe('offer_purchases trigger', () => {
  it('a Revolut sale becomes an order when it is paid', async () => {
    await q(`INSERT INTO public.offer_purchases (id, offer_id, location_id, buyer_name, buyer_email, revolut_order_id, amount_cents)
             VALUES ($1, $2, $3, 'Bo', 'bo@x.ie', 'rev-2', 20000)`, [P1, OFFER, LOC])
    expect(await ordersFor(P1)).toHaveLength(0)
    await q(`UPDATE public.offer_purchases SET state = 'paid', paid_at = now() WHERE id = $1`, [P1])
    expect((await ordersFor(P1))[0]).toMatchObject({ payment_provider: 'revolut', payment_provider_ref: 'rev-2', contact_name: 'Bo', contact_phone: null })
  })

  it('a un1t.online sale the page started is an order, keyed by its transaction', async () => {
    await q(`INSERT INTO public.offer_purchases (id, offer_id, location_id, buyer_name, buyer_email, amount_cents, state, paid_at, payment_provider, origin, un1t_transaction_id)
             VALUES ($1, $2, $3, 'Cy', 'cy@x.ie', 9900, 'paid', now(), 'un1t_online', 'page', 'tx-9')`, [P2, OFFER, LOC])
    expect((await ordersFor(P2))[0]).toMatchObject({ payment_provider: 'un1t_online', payment_provider_ref: 'tx-9' })
  })

  it('a sale made in the un1t.online app or at the desk is not an order', async () => {
    await q(`INSERT INTO public.offer_purchases (id, offer_id, location_id, buyer_name, buyer_email, amount_cents, state, paid_at, payment_provider, origin, un1t_transaction_id)
             VALUES ($1, $2, $3, 'Di', 'di@x.ie', 9900, 'paid', now(), 'un1t_online', 'off_page', 'tx-10')`, [P3, OFFER, LOC])
    expect(await ordersFor(P3)).toHaveLength(0)
  })
})

describe('orders.source_type', () => {
  it('takes the two new kinds and still refuses anything else', async () => {
    await expect(q(`INSERT INTO public.orders (location_id, source_type, source_id, contact_email, amount_cents, status)
                    VALUES ($1, 'donation', gen_random_uuid(), 'x@x.ie', 1, 'completed')`, [LOC])).rejects.toThrow(/orders_source_type_check/)
  })
})
