// PAGES.1 — behavioural test for migration 792's backfill, replayed on PGlite
// over reduced tables (only the columns 792 reads or writes).
//
// It proves the rows the public URLs need exist after the migration in the
// shape prod had on 31 Oct 2026 (Stillorgan and Hatch Street rows with
// paid_trial + class_funnel blocks, NO campaign_funnel and NO corp_promo
// block): /50plus and /corp are created from their type defaults, so neither
// 404s after deploy. And, when the source blocks exist, that they are used:
// /50plus takes the first block of each show_sections type in that order.
// The file runs twice cleanly, and leaves none of its backfill helpers behind.
// Fictional ids only: the repo is public.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// PGlite's multi-statement SQL runner (an in-process database call, not a shell).
const runSql = (db, text) => db['exec'](text)

const MIG_792 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/792_landing_pages.sql'), 'utf8')

const ORG = 'c0000000-0000-0000-0000-00000000000a'
const STILL = 'a0000000-0000-0000-0000-00000000000a'
const HATCH = 'a0000000-0000-0000-0000-00000000000b'

const BASE = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE SCHEMA private;
  CREATE TABLE public.organizations (id uuid PRIMARY KEY);
  CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid REFERENCES public.organizations(id), name text,
    active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.org_settings (organization_id uuid PRIMARY KEY, company_name text);
  CREATE TABLE public.company_settings (location_id uuid PRIMARY KEY, company_name text);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY);
  CREATE TABLE public.landing_page_settings (
    location_id uuid PRIMARY KEY REFERENCES public.locations(id), public_path text, blocks jsonb,
    logo_url text, logo_alt text, logo_width_px integer, show_instagram_feed boolean,
    chooser_label text, chooser_cta_text text, chooser_image_url text,
    publish_state text, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.class_booking_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.trial_purchases (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.corp_promo_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.funnel_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE FUNCTION private.log_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
  INSERT INTO public.organizations VALUES ('${ORG}');
  INSERT INTO public.locations VALUES ('${STILL}', '${ORG}', 'UN1T Stillorgan'), ('${HATCH}', '${ORG}', 'UN1T Hatch Street');
`

const PAID = (studio) => ({ id: `pt-${studio}`, type: 'paid_trial', heading: 'Reset', plan_code: `P-${studio}`, price_cents: 4900 })
const FUNNEL = { id: 'cf', type: 'class_funnel', heading: 'Book', trial_plan_code: 'T1', terms_label: 'I agree' }

async function boot({ stillBlocks, hatchBlocks, orgName = null, studioName = null }) {
  const db = new PGlite()
  await runSql(db, BASE)
  if (orgName !== null) await db.query('INSERT INTO public.org_settings VALUES ($1, $2)', [ORG, orgName])
  if (studioName !== null) await db.query('INSERT INTO public.company_settings VALUES ($1, $2)', [HATCH, studioName])
  await db.query(
    `INSERT INTO public.landing_page_settings (location_id, public_path, blocks, publish_state) VALUES
       ($1, 'stillorgan', $2::jsonb, 'live'), ($3, 'hatch-street', $4::jsonb, 'live')`,
    [STILL, JSON.stringify(stillBlocks), HATCH, JSON.stringify(hatchBlocks)],
  )
  await runSql(db, MIG_792)
  return db
}

const page = async (db, slug) => (await db.query('SELECT * FROM public.landing_pages WHERE slug = $1', [slug])).rows[0]
const studioRows = async (db, slug) => (await db.query(
  'SELECT s.* FROM public.landing_page_studios s JOIN public.landing_pages p ON p.id = s.page_id WHERE p.slug = $1 ORDER BY s.sort_order', [slug])).rows

describe('mig 792 backfill (PGlite replay)', () => {
  it('prod shape (no campaign_funnel, no corp_promo): /50plus and /corp still exist, from the type defaults', async () => {
    const db = await boot({
      stillBlocks: [
        { id: 'h', type: 'hero', heading: 'Hi' },
        PAID('s'), FUNNEL,
        { id: 'r1', type: 'reviews', min_rating: 4 },
        { id: 's1', type: 'stats', items: [1] },
        { id: 'faq', type: 'faq' },
        { id: 'v1', type: 'video_testimonials' },
        { id: 's2', type: 'stats', items: [2] },
      ],
      hatchBlocks: [PAID('h'), FUNNEL, { id: 'g', type: 'gallery' }],
    })

    const fifty = await page(db, '50plus')
    expect(fifty).toBeTruthy()
    expect(fifty.publish_state).toBe('live')
    expect(fifty.offer_type).toBe('one_class')
    expect(fifty.primary_location_id).toBe(STILL)
    // Default page half, then the FIRST stats / video_testimonials / reviews, in that order.
    expect(fifty.blocks.map((b) => b.id)).toEqual(['campaign-50plus', 's1', 'v1', 'r1'])
    expect(fifty.blocks[0]).toEqual({ id: 'campaign-50plus', type: 'campaign_funnel' })
    const [fs] = await studioRows(db, '50plus')
    expect(fs).toMatchObject({ location_id: STILL, enabled: true, offer: { class_keywords: '50+' } })
    expect(fs.attribution).toEqual({ tag: 'stillorgan-50plus', lead_source: 'meta_50plus' })

    const corp = await page(db, 'corp')
    expect(corp).toBeTruthy()
    expect(corp.publish_state).toBe('live')
    expect(corp.offer_type).toBe('promo_credits')
    expect(corp.primary_location_id).toBe(HATCH)
    expect(corp.blocks.map((b) => b.id)).toEqual(['corp-promo', 'g'])
    const [cs] = await studioRows(db, 'corp')
    expect(cs).toMatchObject({ location_id: HATCH, enabled: true, offer: { promo_key: 'hatch-3-free' }, attribution: {} })

    for (const slug of ['stillorgan', 'hatch-street', 'trial', 'start', 'free-class']) expect(await page(db, slug), slug).toBeTruthy()
    await db.close()
  })

  it("seeds today's tab title and description on the three live campaign pages (titles without the brand suffix)", async () => {
    const db = await boot({ stillBlocks: [PAID('s')], hatchBlocks: [PAID('h')], orgName: '  UN1T Dublin ' })
    expect((await page(db, 'trial')).chrome).toMatchObject({
      noindex: true,
      meta_title: 'The UN1T Trial',
      meta_description: 'The UN1T Trial at UN1T Dublin. Choose your studio, pay once, start this week.',
    })
    expect((await page(db, '50plus')).chrome).toMatchObject({
      noindex: true,
      meta_title: 'The 50+ Club Trial',
      meta_description: 'A free trial of The 50+ Club at UN1T Stillorgan. Coach-led strength for the over-50s, three mornings a week. Pick your first class.',
    })
    expect((await page(db, 'corp')).chrome).toMatchObject({
      noindex: true,
      meta_title: 'Exclusive Corporate Trial',
      meta_description: 'A free offer for our partner companies. Claim it in under a minute.',
    })
    await db.close()
  })

  it('names the organisation from a studio company_settings row when org_settings has none, and drops " at" when neither does', async () => {
    const named = await boot({ stillBlocks: [PAID('s')], hatchBlocks: [PAID('h')], orgName: '', studioName: 'UN1T Hatch' })
    expect((await page(named, 'trial')).chrome.meta_description).toBe('The UN1T Trial at UN1T Hatch. Choose your studio, pay once, start this week.')
    await named.close()
    const bare = await boot({ stillBlocks: [PAID('s')], hatchBlocks: [PAID('h')] })
    expect((await page(bare, 'trial')).chrome.meta_description).toBe('The UN1T Trial. Choose your studio, pay once, start this week.')
    await bare.close()
  })

  it('uses the source blocks when they exist: show_sections order, first of each type, the block offer', async () => {
    const db = await boot({
      stillBlocks: [
        PAID('s'),
        { id: 'cf50', type: 'campaign_funnel', campaign: '50plus', heading: 'Strong at 50', show_sections: ['reviews', 'stats'],
          class_keywords: 'Over 50', trial_plan_code: 'T50', tag: '', lead_source: 'meta_x' },
        { id: 's1', type: 'stats' }, { id: 'r1', type: 'reviews' }, { id: 'r2', type: 'reviews' }, { id: 'v1', type: 'video_testimonials' },
      ],
      hatchBlocks: [PAID('h'), { id: 'cp', type: 'corp_promo', heading: 'Free', promo_key: 'acme-3' }],
    })
    const fifty = await page(db, '50plus')
    expect(fifty.blocks.map((b) => b.id)).toEqual(['cf50', 'r1', 's1'])
    expect(fifty.blocks[0]).toEqual({ id: 'cf50', type: 'campaign_funnel', heading: 'Strong at 50' })
    const [fs] = await studioRows(db, '50plus')
    expect(fs.offer).toEqual({ class_keywords: 'Over 50', trial_plan_code: 'T50' })
    expect(fs.attribution).toEqual({ tag: 'stillorgan-50plus', lead_source: 'meta_x' })
    const [cs] = await studioRows(db, 'corp')
    expect(cs.offer).toEqual({ promo_key: 'acme-3' })
    expect((await page(db, 'corp')).blocks[0]).toEqual({ id: 'cp', type: 'corp_promo', heading: 'Free' })
    await db.close()
  })

  it('runs twice cleanly and leaves no backfill helper behind', async () => {
    const db = await boot({ stillBlocks: [PAID('s')], hatchBlocks: [PAID('h')] })
    await runSql(db, MIG_792)
    expect((await db.query("SELECT count(*)::int AS n FROM public.landing_pages WHERE slug IN ('50plus', 'corp')")).rows[0].n).toBe(2)
    const fns = (await db.query("SELECT n.nspname || '.' || p.proname AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname LIKE 'landing_page%' ORDER BY 1")).rows.map((r) => r.fn)
    expect(fns).toEqual(['public.landing_page_studios_same_org'])
    await db.close()
  })
})
