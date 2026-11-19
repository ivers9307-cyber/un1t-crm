// SALEPAGE.1 (mig 860) — a page may now be a sale; nothing else is allowed in.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { OFFER_TYPES } from '../src/lib/landing-page-offers.js'

const SQL = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/860_landing_page_sale_offer_type.sql'), 'utf8')
let pg
beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`CREATE TABLE public.landing_pages (id serial PRIMARY KEY, offer_type text NOT NULL DEFAULT 'none',
    CONSTRAINT landing_pages_offer_type_check CHECK (offer_type IN ('paid_trial', 'class_funnel', 'one_class', 'promo_credits', 'none')));`)
  await pg.exec(SQL)
}, 60_000)
afterAll(async () => { await pg?.close() })

describe('mig 860', () => {
  it('accepts every offer type the editor offers, and nothing else', async () => {
    for (const t of OFFER_TYPES) await pg.query('INSERT INTO public.landing_pages (offer_type) VALUES ($1)', [t])
    await expect(pg.query("INSERT INTO public.landing_pages (offer_type) VALUES ('raffle')")).rejects.toThrow(/landing_pages_offer_type_check/)
  })
})
