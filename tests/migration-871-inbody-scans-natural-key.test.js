// INBODYDEDUPE.1 — behavioural test for migration 871. Runs the REAL file in
// PGlite over inbody_scans as mig 272 created it and proves:
//   * matched_phone9 is the last nine digits of matched_phone, the same value
//     for every spelling of one number (the normalisePhone9 rule), NULL under
//     nine digits;
//   * one scan (studio + phone + second) cannot be recorded twice, whatever
//     the spelling, and the upsert every writer sends (ON CONFLICT on the new
//     key, the statement PostgREST builds) updates the one row in place;
//   * another scan for the same person, or the same second at another
//     studio, is a second row; rows with no phone never collide;
//   * the guard refuses to apply over existing duplicates, naming the count,
//     and deletes nothing;
//   * a second run passes and changes nothing; no grant is added.
// Fictional ids and numbers only: the repo is public.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { normalisePhone9 } from '../src/lib/person-links.js'
import { SCAN_CONFLICT_TARGET } from '../src/lib/inbody-ingest.js'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/871_inbody_scans_natural_key.sql'), 'utf8')
const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'

// inbody_scans as mig 272 created it (locations/contacts reduced to ids).
const BASE = `
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.contacts (id uuid PRIMARY KEY);
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  CREATE TABLE public.inbody_scans (
    id uuid primary key default gen_random_uuid(),
    contact_id uuid references public.contacts(id) on delete set null,
    location_id uuid not null references public.locations(id) on delete cascade,
    source text not null default 'lookinbody',
    external_id text,
    scanned_at timestamptz not null,
    weight_kg numeric, pbf_percent numeric, smm_kg numeric, bmi numeric,
    bmr numeric, body_fat_mass_kg numeric, inbody_score numeric,
    matched_phone text,
    raw jsonb,
    created_at timestamptz not null default now(),
    unique (source, external_id)
  );
  CREATE ROLE authenticated NOLOGIN;
`

let db
const insert = (phone, at, { loc = LOC_A, ext = `${phone}_${at}`, weight = 80 } = {}) => db.query(
  'INSERT INTO public.inbody_scans (location_id, matched_phone, scanned_at, external_id, weight_kg) VALUES ($1, $2, $3, $4, $5)',
  [loc, phone, at, ext, weight])
// The statement PostgREST builds for ingestScan's upsert.
const upsert = (phone, at, { loc = LOC_A, weight = 80 } = {}) => db.query(
  `INSERT INTO public.inbody_scans (source, external_id, location_id, matched_phone, scanned_at, weight_kg)
   VALUES ('lookinbody', $1, $2, $3, $4, $5)
   ON CONFLICT (${SCAN_CONFLICT_TARGET}) DO UPDATE SET
     source = EXCLUDED.source, external_id = EXCLUDED.external_id, location_id = EXCLUDED.location_id,
     matched_phone = EXCLUDED.matched_phone, scanned_at = EXCLUDED.scanned_at, weight_kg = EXCLUDED.weight_kg`,
  [`${phone}_${at}_${loc}`, loc, phone, at, weight])
const count = async () => (await db.query('SELECT count(*)::int AS n FROM public.inbody_scans')).rows[0].n
const errorOf = async (p) => { try { await p; return null } catch (e) { return e } }
const AT = '2026-11-20T09:30:15'

beforeEach(async () => {
  db = new PGlite()
  await db.exec(BASE)
})
afterEach(async () => { await db.close() })

describe('871 — inbody_scans natural key', () => {
  it('matched_phone9 is normalisePhone9 of matched_phone, for every spelling', async () => {
    const spellings = ['0851234567', '+353851234567', '353851234567', '+353 85 123 4567', '(085) 123-4567', '851234567', '12345678', '', null]
    for (const [i, p] of spellings.entries()) await insert(p, `2026-11-20T09:30:${String(i).padStart(2, '0')}`)
    await db.exec(MIG)
    const { rows } = await db.query('SELECT matched_phone, matched_phone9 FROM public.inbody_scans ORDER BY scanned_at')
    for (const r of rows) expect(r.matched_phone9).toBe(normalisePhone9(r.matched_phone))
    expect(rows.filter((r) => r.matched_phone9 === '851234567')).toHaveLength(6)
  })

  it('refuses a second row for one scan, whatever the phone spelling (23505)', async () => {
    await db.exec(MIG)
    await insert('0851234567', AT)
    const err = await errorOf(insert('+353851234567', AT))
    expect(err?.code).toBe('23505')
    expect(await count()).toBe(1)
  })

  it('the writers\' upsert updates the one row in place', async () => {
    await db.exec(MIG)
    await upsert('+353851234567', AT, { weight: 80 })
    await upsert('0851234567', AT, { weight: 81 })
    await upsert('0851234567', AT, { weight: 81 })
    const { rows } = await db.query('SELECT matched_phone, weight_kg FROM public.inbody_scans')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ matched_phone: '0851234567' })
    expect(Number(rows[0].weight_kg)).toBe(81)
  })

  it('another scan for the same person, or the same second at another studio, is another row', async () => {
    await db.exec(MIG)
    await upsert('0851234567', AT)
    await upsert('0851234567', '2026-11-27T09:30:15')
    await upsert('+353851234567', AT, { loc: LOC_B })
    expect(await count()).toBe(3)
  })

  it('rows with no usable phone never collide', async () => {
    await db.exec(MIG)
    await insert(null, AT, { ext: null })
    await insert(null, AT, { ext: null })
    await insert('1234', AT, { ext: 'a' })
    await insert('1234', AT, { ext: 'b' })
    expect(await count()).toBe(4)
  })

  it('refuses to apply over existing duplicates, naming the count, and deletes nothing', async () => {
    await insert('0851234567', AT)
    await insert('+353851234567', AT) // same scan, other spelling: the bug
    await insert('353851234567', AT)
    await insert('0869999999', AT)
    await insert('+353869999999', AT)
    await insert('0851234567', '2026-11-27T09:30:15') // a real second scan
    await insert('0851234567', AT, { loc: LOC_B, ext: 'other-studio' }) // other studio
    const err = await errorOf(db.exec(MIG))
    expect(String(err?.message)).toMatch(/871: 2 InBody scan\(s\) recorded more than once \(3 surplus row\(s\)\)/)
    await db.exec('ROLLBACK') // the file's own BEGIN is left aborted
    expect(await count()).toBe(7)
    const { rows } = await db.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'inbody_scans' AND column_name = 'matched_phone9'")
    expect(rows).toHaveLength(0)
  })

  it('a second run passes and changes nothing; no grant is added', async () => {
    await db.exec(MIG)
    await upsert('0851234567', AT)
    await db.exec(MIG)
    expect(await count()).toBe(1)
    const { rows: idx } = await db.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'inbody_scans_natural_key'")
    expect(idx[0].indexdef).toMatch(/UNIQUE INDEX .* \(location_id, matched_phone9, scanned_at\)/)
    expect(idx[0].indexdef).not.toMatch(/WHERE/)
    const { rows: grants } = await db.query("SELECT 1 FROM information_schema.role_table_grants WHERE table_name = 'inbody_scans' AND grantee = 'authenticated'")
    expect(grants).toHaveLength(0)
  })
})
