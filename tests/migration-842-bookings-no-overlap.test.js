// BOOKONE.1 — behavioural test for migration 842: the database refuses two
// live bookings of one event type that overlap. Runs the REAL file in PGlite
// with btree_gist loaded. Fictional ids only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/842_bookings_no_overlap.sql'), 'utf8')
const EV = 'e0000000-0000-0000-0000-000000000001'
const EV2 = 'e0000000-0000-0000-0000-000000000002'

const BASE = `
  CREATE TABLE public.bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type_id uuid NOT NULL,
    booking_date date NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL,
    status text DEFAULT 'confirmed'
  );
`
let db
const book = (start, end, { ev = EV, date = '2026-11-20', status = 'confirmed' } = {}) => db.query(
  'INSERT INTO public.bookings (event_type_id, booking_date, start_time, end_time, status) VALUES ($1, $2, $3, $4, $5)',
  [ev, date, start, end, status])
const errorOf = async (p) => { try { await p; return null } catch (e) { return e } }

beforeEach(async () => {
  db = new PGlite({ extensions: { btree_gist } })
  await db.exec(BASE)
})
afterEach(async () => { await db.close() })

describe('842 — bookings_no_overlap', () => {
  it('refuses a second live booking that overlaps (23P01)', async () => {
    await db.exec(MIG)
    await book('10:00', '10:30')
    const err = await errorOf(book('10:15', '10:45'))
    expect(err?.code).toBe('23P01')
  })

  it('allows back-to-back slots, other days, other event types and cancelled rows', async () => {
    await db.exec(MIG)
    await book('10:00', '10:30')
    await book('10:30', '11:00')
    await book('10:00', '10:30', { date: '2026-11-21' })
    await book('10:00', '10:30', { ev: EV2 })
    await book('10:00', '10:30', { status: 'cancelled' })
    const { rows } = await db.query('SELECT count(*)::int AS n FROM public.bookings')
    expect(rows[0].n).toBe(5)
  })

  it('cancelling a booking frees its slot', async () => {
    await db.exec(MIG)
    await book('10:00', '10:30')
    await db.query("UPDATE public.bookings SET status = 'cancelled'")
    expect(await errorOf(book('10:00', '10:30'))).toBeNull()
  })

  it('moving a booking onto another live one is refused too', async () => {
    await db.exec(MIG)
    await book('10:00', '10:30')
    await book('11:00', '11:30')
    const err = await errorOf(db.query("UPDATE public.bookings SET start_time = '10:15', end_time = '10:45' WHERE start_time = '11:00'"))
    expect(err?.code).toBe('23P01')
  })

  it('refuses to apply over existing overlaps, naming the count', async () => {
    await book('10:00', '10:30')
    await book('10:15', '10:45')
    const err = await errorOf(db.exec(MIG))
    expect(String(err?.message)).toMatch(/842: 1 overlapping/)
  })
})
