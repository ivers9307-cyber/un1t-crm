// MIAHATCH.4 — behavioural test for migration 752 (mia_purchase_intents,
// mia_purchase_offers). PGlite with the three parent tables reduced to their
// ids (locations, contacts, un1t_products), the three roles, then the REAL 752
// file. Proves: both tables exist with RLS on and no policy; anon and
// authenticated hold nothing while service_role has the four; the one-live-link
// partial unique index; the status CHECK; the 140-char blurb CHECK; the file
// leaves the agent_membership_requests kind CHECK alone (D owns refund_request);
// and re-applies cleanly.
//
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_752 = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/752_mia_purchase_intents_offers.sql'), 'utf8')

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const ORG = 'c0000000-0000-0000-0000-00000000000c'
const PROD_A = 'd0000000-0000-0000-0000-00000000000d'
const PROD_A2 = 'd0000000-0000-0000-0000-0000000000d2'

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)

const insertIntent = (loc, user, status = 'link_sent', expires = "now() + interval '23 hours'") => db.query(
  `INSERT INTO public.mia_purchase_intents
     (location_id, organization_id, channel, un1t_user_id, un1t_product_id, status, expires_at)
   VALUES ($1, $2, 'whatsapp', $3, 'prod-1', $4, ${expires}) RETURNING id`,
  [loc, ORG, user, status])

const insertOffer = (loc, product, sort = 1, blurb = null) => db.query(
  `INSERT INTO public.mia_purchase_offers (location_id, un1t_product_row_id, sort_order, blurb)
   VALUES ($1, $2, $3, $4) RETURNING id`, [loc, product, sort, blurb])

const priv = async (role, table, p) => (await db.query(
  'SELECT has_table_privilege($1, $2, $3) AS ok', [role, `public.${table}`, p])).rows[0].ok

beforeAll(async () => {
  db = new PGlite()
  await runSql(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE TABLE public.locations (id uuid PRIMARY KEY);
    CREATE TABLE public.contacts (id uuid PRIMARY KEY);
    CREATE TABLE public.un1t_products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE
    );
    INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
    INSERT INTO public.un1t_products (id, location_id) VALUES ('${PROD_A}', '${LOC_A}'), ('${PROD_A2}', '${LOC_A}');
  `)
  await runSql(MIG_752)
}, 60_000)
afterAll(() => db?.close())

describe('migration 752 — mia_purchase_intents / mia_purchase_offers', () => {
  it('both tables exist with RLS on and no policy', async () => {
    const { rows } = await db.query(`
      SELECT c.relname, c.relrowsecurity,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname IN ('mia_purchase_intents', 'mia_purchase_offers')
       ORDER BY c.relname`)
    expect(rows).toEqual([
      { relname: 'mia_purchase_intents', relrowsecurity: true, policies: 0 },
      { relname: 'mia_purchase_offers', relrowsecurity: true, policies: 0 },
    ])
  })

  it('anon/authenticated hold nothing; service_role has the four', async () => {
    for (const t of ['mia_purchase_intents', 'mia_purchase_offers']) {
      for (const role of ['anon', 'authenticated']) {
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          expect(await priv(role, t, p), `${role} ${p} on ${t}`).toBe(false)
        }
      }
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(await priv('service_role', t, p), `service_role ${p} on ${t}`).toBe(true)
      }
    }
  })

  it('a second link_sent row for the same (location, user) fails 23505; a link_sent beside an expired one is fine', async () => {
    await insertIntent(LOC_A, 'user-1', 'expired')
    await insertIntent(LOC_A, 'user-1', 'paid')
    await insertIntent(LOC_A, 'user-1', 'link_sent')
    await expect(insertIntent(LOC_A, 'user-1', 'link_sent')).rejects.toMatchObject({ code: '23505' })
    // Another member, and the same member at another studio, are unaffected.
    await insertIntent(LOC_A, 'user-2', 'link_sent')
    await insertIntent(LOC_B, 'user-1', 'link_sent')
  })

  it('a settled intent frees the member for a new link', async () => {
    await insertIntent(LOC_A, 'user-3', 'link_sent')
    await db.query(`UPDATE public.mia_purchase_intents SET status = 'expired' WHERE un1t_user_id = 'user-3'`)
    await insertIntent(LOC_A, 'user-3', 'link_sent')
  })

  it('every documented status is accepted and the status check refuses pending', async () => {
    let i = 0
    for (const s of ['paid', 'booked', 'book_failed', 'no_class', 'expired', 'refused']) {
      await insertIntent(LOC_A, `status-user-${i++}`, s)
    }
    await expect(insertIntent(LOC_A, 'user-pending', 'pending')).rejects.toThrow(/mia_purchase_intents_status_check/)
  })

  it('refuses a null expires_at, channel, user or product', async () => {
    for (const col of ['expires_at', 'channel', 'un1t_user_id', 'un1t_product_id', 'organization_id']) {
      const cols = { location_id: `'${LOC_A}'`, organization_id: `'${ORG}'`, channel: "'whatsapp'",
        un1t_user_id: "'null-user'", un1t_product_id: "'p'", status: "'expired'", expires_at: 'now()' }
      delete cols[col]
      await expect(db.query(
        `INSERT INTO public.mia_purchase_intents (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')})`,
      ), col).rejects.toMatchObject({ code: '23502' })
    }
  })

  it('success_token_hash is unique (nulls allowed many times)', async () => {
    const withHash = (user, hash) => db.query(
      `INSERT INTO public.mia_purchase_intents
         (location_id, organization_id, channel, un1t_user_id, un1t_product_id, status, expires_at, success_token_hash)
       VALUES ($1, $2, 'whatsapp', $3, 'p', 'expired', now(), $4)`, [LOC_A, ORG, user, hash])
    await withHash('hash-1', 'h-aaa')
    await withHash('hash-2', null)
    await withHash('hash-3', null)
    await expect(withHash('hash-4', 'h-aaa')).rejects.toMatchObject({ code: '23505' })
  })

  it('contact_id is set null when the contact is deleted; the location FK refuses an unknown studio', async () => {
    const contact = 'e0000000-0000-0000-0000-00000000000e'
    await runSql(`INSERT INTO public.contacts VALUES ('${contact}')`)
    await db.query(
      `INSERT INTO public.mia_purchase_intents
         (location_id, organization_id, contact_id, channel, un1t_user_id, un1t_product_id, status, expires_at)
       VALUES ($1, $2, $3, 'whatsapp', 'contact-user', 'p', 'expired', now())`, [LOC_A, ORG, contact])
    await runSql(`DELETE FROM public.contacts WHERE id = '${contact}'`)
    const { rows } = await db.query(`SELECT contact_id FROM public.mia_purchase_intents WHERE un1t_user_id = 'contact-user'`)
    expect(rows[0].contact_id).toBeNull()
    await expect(insertIntent('f0000000-0000-0000-0000-00000000000f', 'ghost')).rejects.toMatchObject({ code: '23503' })
  })

  it('has the (status, expires_at) sweep index', async () => {
    const { rows } = await db.query(`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'mia_purchase_intents' AND indexdef ILIKE '%(status, expires_at)%'`)
    expect(rows).toHaveLength(1)
  })

  it('offers: a blurb of 140 chars is fine, 141 is refused', async () => {
    await insertOffer(LOC_A, PROD_A, 1, 'x'.repeat(140))
    await expect(insertOffer(LOC_A, PROD_A2, 2, 'x'.repeat(141))).rejects.toThrow(/mia_purchase_offers_blurb_check/)
    await insertOffer(LOC_A, PROD_A2, 2, null)
  })

  it('offers: one row per (studio, product); the product FK cascades the offer away', async () => {
    await expect(insertOffer(LOC_A, PROD_A, 3)).rejects.toMatchObject({ code: '23505' })
    await expect(insertOffer(LOC_A, 'f0000000-0000-0000-0000-0000000000f1', 3)).rejects.toMatchObject({ code: '23503' })
    await runSql(`DELETE FROM public.un1t_products WHERE id = '${PROD_A2}'`)
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.mia_purchase_offers WHERE un1t_product_row_id = $1`, [PROD_A2])
    expect(rows[0].n).toBe(0)
  })

  it('offers: deleting the studio cascades its offers', async () => {
    const loc = '90000000-0000-0000-0000-000000000009'
    const prod = '90000000-0000-0000-0000-0000000000a9'
    await runSql(`INSERT INTO public.locations VALUES ('${loc}');
      INSERT INTO public.un1t_products (id, location_id) VALUES ('${prod}', '${loc}');`)
    await insertOffer(loc, prod, 1, 'one class')
    await runSql(`DELETE FROM public.locations WHERE id = '${loc}'`)
    const { rows } = await db.query('SELECT count(*)::int AS n FROM public.mia_purchase_offers WHERE location_id = $1', [loc])
    expect(rows[0].n).toBe(0)
  })

  it('indexes the two foreign keys the advisor flags (contact_id, un1t_product_row_id)', async () => {
    const { rows } = await db.query(`
      SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('mia_purchase_intents_contact_id', 'mia_purchase_offers_product_row_id')
       ORDER BY indexname`)
    expect(rows.map((r) => r.indexname)).toEqual(['mia_purchase_intents_contact_id', 'mia_purchase_offers_product_row_id'])
    expect(rows[0].tablename).toBe('mia_purchase_intents')
    expect(rows[0].indexdef).toMatch(/\(contact_id\)/)
    expect(rows[1].tablename).toBe('mia_purchase_offers')
    expect(rows[1].indexdef).toMatch(/\(un1t_product_row_id\)/)
  })

  it('file does not touch agent_membership_requests_kind_check (refund_request is D\'s migration)', () => {
    const code = MIG_752.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/agent_membership_requests_kind_check/)
    expect(code).not.toMatch(/agent_membership_requests/)
  })

  it('file re-applies cleanly', async () => {
    await runSql(MIG_752)
    await runSql(MIG_752)
  })
})
