// REFUNDLEDGER.1 (mig 853) — refunds are claimed before money moves, so two
// refunds can never be in flight on one order. Run on real Postgres (PGlite).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const SQL = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/853_order_refunds.sql'), 'utf8')
const ORDER = '00000000-0000-4000-8000-000000000001'
const LOC = '00000000-0000-4000-8000-0000000000aa'
const ACTOR = '00000000-0000-4000-8000-0000000000bb'

let pg
const q = async (text, params) => (await pg.query(text, params)).rows
const claim = async (amount, reason = 'Customer asked') =>
  (await q('SELECT public.claim_order_refund($1, $2, $3, $4) AS r', [ORDER, amount, reason, ACTOR]))[0].r
const finish = async (id, status, providerId = null) =>
  (await q('SELECT public.finish_order_refund($1, $2, $3, $4) AS r', [id, status, providerId, null]))[0].r
const order = async () => (await q('SELECT status, refunded_amount_cents, metadata FROM public.orders WHERE id = $1', [ORDER]))[0]

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE TABLE public.orders (
      id uuid PRIMARY KEY, location_id uuid, amount_cents integer, currency text, status text,
      payment_provider text, refunded_amount_cents integer, refunded_at timestamptz,
      metadata jsonb, updated_at timestamptz
    );
  `)
  await pg.exec(SQL)
}, 60_000)
afterAll(async () => { await pg?.close() })
beforeEach(async () => {
  await pg.exec('DELETE FROM public.order_refunds; DELETE FROM public.orders;')
  await q(`INSERT INTO public.orders (id, location_id, amount_cents, currency, status, payment_provider, refunded_amount_cents, metadata)
           VALUES ($1, $2, 1000, 'EUR', 'completed', 'revolut', 0, '{"kept":"yes"}')`, [ORDER, LOC])
})

describe('claim_order_refund', () => {
  it('claims a partial refund and records it as requested with its own key', async () => {
    const r = await claim(300)
    expect(r).toMatchObject({ ok: true, resumed: false, amount_cents: 300, is_full: false })
    expect(r.idempotency_key).toBe(`refund:${ORDER}:${r.refund_id}`)
    expect((await q('SELECT status FROM public.order_refunds'))[0].status).toBe('requested')
  })

  it('a second, different amount is refused while the first is in flight (the race)', async () => {
    await claim(1000)
    expect(await claim(500)).toMatchObject({ ok: false, code: 'refund_in_progress', amount_cents: 1000 })
  })

  it('the same amount again resumes the open refund with the same key', async () => {
    const first = await claim(400)
    const again = await claim(400)
    expect(again).toMatchObject({ ok: true, resumed: true, refund_id: first.refund_id, idempotency_key: first.idempotency_key })
  })

  it('no amount means what is left, and refuses more than that', async () => {
    const a = await claim(300)
    await finish(a.refund_id, 'completed', 'rf1')
    expect(await claim(800)).toMatchObject({ ok: false, code: 'refund_exceeds_order', remaining_cents: 700 })
    expect(await claim(null)).toMatchObject({ ok: true, amount_cents: 700, is_full: true })
  })

  it('counts a refund made outside the ledger (the Stripe webhook total)', async () => {
    await q('UPDATE public.orders SET refunded_amount_cents = 600 WHERE id = $1', [ORDER])
    expect(await claim(null)).toMatchObject({ amount_cents: 400 })
  })

  it('refuses an order that is not completed, and a reason that is blank', async () => {
    await q("UPDATE public.orders SET status = 'pending' WHERE id = $1", [ORDER])
    expect(await claim(100)).toMatchObject({ ok: false, code: 'invalid_status', status: 'pending' })
    await q("UPDATE public.orders SET status = 'completed' WHERE id = $1", [ORDER])
    await expect(claim(100, '   ')).rejects.toThrow()
  })

  it('the database itself allows only one open refund per order', async () => {
    await claim(100)
    await expect(q(`INSERT INTO public.order_refunds (order_id, location_id, amount_cents, currency, reason, idempotency_key)
                    VALUES ($1, $2, 50, 'EUR', 'x', 'k2')`, [ORDER, LOC])).rejects.toThrow(/order_refunds_one_open_per_order/)
  })
})

describe('finish_order_refund', () => {
  it('completed adds to the total, keeps other metadata and records who and why', async () => {
    const a = await claim(300)
    expect(await finish(a.refund_id, 'completed', 'rf1')).toMatchObject({ ok: true, refunded_total_cents: 300, is_full: false })
    const o = await order()
    expect(o).toMatchObject({ status: 'completed', refunded_amount_cents: 300 })
    expect(o.metadata).toMatchObject({ kept: 'yes', refund_reason: 'Customer asked', refund_provider_id: 'rf1', refund_revolut_id: 'rf1' })
  })

  it('two partial refunds in turn add up, and the last one flips the order to refunded', async () => {
    await finish((await claim(400)).refund_id, 'completed', 'rf1')
    expect(await finish((await claim(600)).refund_id, 'completed', 'rf2')).toMatchObject({ refunded_total_cents: 1000, is_full: true })
    expect(await order()).toMatchObject({ status: 'refunded', refunded_amount_cents: 1000 })
    expect((await q("SELECT count(*)::int AS n FROM public.order_refunds WHERE status = 'completed'"))[0].n).toBe(2)
  })

  it('failed frees the order for another amount; unknown keeps it held', async () => {
    const a = await claim(500)
    await finish(a.refund_id, 'unknown')
    expect(await claim(200)).toMatchObject({ ok: false, code: 'refund_in_progress' })
    await finish(a.refund_id, 'failed')
    expect(await claim(200)).toMatchObject({ ok: true, resumed: false })
    expect((await order()).refunded_amount_cents).toBe(0)
  })

  it('recording the same completion twice changes nothing', async () => {
    const a = await claim(300)
    await finish(a.refund_id, 'completed', 'rf1')
    expect(await finish(a.refund_id, 'completed', 'rf1')).toMatchObject({ ok: true, refunded_total_cents: 300 })
    expect((await order()).refunded_amount_cents).toBe(300)
  })
})

describe('a refund held past the idempotency window', () => {
  it('is never resumed: it asks for a check by hand', async () => {
    const a = await claim(500)
    await finish(a.refund_id, 'unknown')
    await q("UPDATE public.order_refunds SET created_at = now() - interval '21 hours' WHERE id = $1", [a.refund_id])
    expect(await claim(500)).toMatchObject({ ok: false, code: 'refund_needs_check', refund_id: a.refund_id })
  })
})

