// HATCHPIPE.1 — behavioural + static tests for migration 736 (contacts
// .pipeline_stage_slug comes from the contact's OWN studio). PGlite with the
// minimal tables the trigger reads, the mig-155 trigger, then section 1 of the
// real file (the function); section 2 (recompute + self-check) is run with its
// expected-count constants rewritten to the fixture's counts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/736_contacts_stage_slug_own_studio.sql'), 'utf8')
const MARKER = '-- ─── 2. Recompute'
const [SECTION_1, SECTION_2_TAIL] = MIG.split(MARKER)
const SECTION_2 = MARKER + SECTION_2_TAIL
const FUNCTION_BODY = SECTION_1.slice(SECTION_1.indexOf('create or replace function'))

const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4' // hard-coded in section 2, as in migs 597/598
const STILL = 'a0000000-0000-0000-0000-000000000001'
const NOBOARD = 'c0000000-0000-0000-0000-0000000000c1'

// board ids
const P_STILL = 'e0000000-0000-0000-0000-000000000001' // Still primary
const P_STILL_2 = 'e0000000-0000-0000-0000-000000000002' // Still other enabled
const P_STILL_3 = 'e0000000-0000-0000-0000-000000000003' // Still other enabled
const P_HATCH = 'e0000000-0000-0000-0000-000000000004' // Hatch primary (waitlist)
const P_HATCH_2 = 'e0000000-0000-0000-0000-000000000005' // Hatch other (acquisition)
// stage ids (one per board, slug in the fixture below)
const S = {
  still: 'f0000000-0000-0000-0000-000000000001',
  still2: 'f0000000-0000-0000-0000-000000000002',
  still3: 'f0000000-0000-0000-0000-000000000003',
  waitlist: 'f0000000-0000-0000-0000-000000000004',
  hatchAcq: 'f0000000-0000-0000-0000-000000000005',
}

const SCHEMA = `
  CREATE TABLE locations (id uuid PRIMARY KEY);
  INSERT INTO locations VALUES ('${HATCH}'), ('${STILL}'), ('${NOBOARD}');
  CREATE TABLE pipelines (id uuid PRIMARY KEY, location_id uuid NOT NULL, key text NOT NULL,
    enabled boolean NOT NULL DEFAULT true, is_primary boolean NOT NULL DEFAULT false);
  INSERT INTO pipelines VALUES
    ('${P_STILL}',   '${STILL}',  'acquisition', true, true),
    ('${P_STILL_2}', '${STILL}',  'second',      true, false),
    ('${P_STILL_3}', '${STILL}',  'third',       true, false),
    ('${P_HATCH}',   '${HATCH}',  'waitlist',    true, true),
    ('${P_HATCH_2}', '${HATCH}',  'acquisition', true, false);
  CREATE TABLE pipeline_stages (id uuid PRIMARY KEY, location_id uuid NOT NULL, pipeline_id uuid NOT NULL, slug text NOT NULL);
  INSERT INTO pipeline_stages VALUES
    ('${S.still}',    '${STILL}', '${P_STILL}',   'still_primary_stage'),
    ('${S.still2}',   '${STILL}', '${P_STILL_2}', 'still_second_stage'),
    ('${S.still3}',   '${STILL}', '${P_STILL_3}', 'still_third_stage'),
    ('${S.waitlist}', '${HATCH}', '${P_HATCH}',   'hatch_waitlist'),
    ('${S.hatchAcq}', '${HATCH}', '${P_HATCH_2}', 'hatch_acquisition');
  CREATE TABLE contacts (id uuid PRIMARY KEY, location_id uuid, pipeline_stage_slug text);
  CREATE TABLE deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, location_id uuid,
    stage_id uuid, pipeline_id uuid, status text NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now());
`
// mig 155's trigger, verbatim.
const TRIGGER = `
  CREATE TRIGGER sync_contacts_pipeline_stage_slug_trigger
  AFTER INSERT OR UPDATE OR DELETE ON deals
  FOR EACH ROW EXECUTE FUNCTION sync_contacts_pipeline_stage_slug();
`

let n = 0
const uuid = () => `d0000000-0000-0000-0000-${String(++n).padStart(12, '0')}`
const T = (day) => `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`

// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (db, text) => db['exec'](text)

async function freshDb() {
  const db = new PGlite()
  await runSql(db, SCHEMA)
  await runSql(db, SECTION_1)
  return db
}
const addContact = (db, loc, slug = null) => {
  const id = uuid()
  return db.query(`INSERT INTO contacts VALUES ($1, $2, $3)`, [id, loc, slug]).then(() => id)
}
const addDeal = (db, contactId, dealLoc, stageId, pipelineId, day, status = 'open') => {
  const id = uuid()
  return db.query(
    `INSERT INTO deals (id, contact_id, location_id, stage_id, pipeline_id, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, contactId, dealLoc, stageId, pipelineId, status, T(day)],
  ).then(() => id)
}
const slugOf = async (db, id) => (await db.query(`SELECT pipeline_stage_slug AS s FROM contacts WHERE id = $1`, [id])).rows[0].s

describe('mig 736 — the trigger function (section 1)', () => {
  let db
  beforeAll(async () => {
    db = await freshDb()
    await runSql(db, TRIGGER)
  }, 60_000)
  afterAll(() => db?.close())

  it('primary deal at own studio wins over a newer deal on another own-studio board', async () => {
    const c = await addContact(db, STILL)
    await addDeal(db, c, STILL, S.still, P_STILL, 1)
    await addDeal(db, c, STILL, S.still2, P_STILL_2, 5)
    expect(await slugOf(db, c)).toBe('still_primary_stage')
  })

  it('no own-studio primary deal → newest open deal on another enabled own-studio board', async () => {
    const c = await addContact(db, STILL)
    await addDeal(db, c, STILL, S.still2, P_STILL_2, 2)
    await addDeal(db, c, STILL, S.still3, P_STILL_3, 6)
    expect(await slugOf(db, c)).toBe('still_third_stage')
  })

  it('a newer open deal at another studio never sets the slug (Stillorgan member with a Hatch waitlist deal keeps their Stillorgan stage)', async () => {
    const c = await addContact(db, STILL)
    await addDeal(db, c, STILL, S.still, P_STILL, 1)
    await addDeal(db, c, HATCH, S.waitlist, P_HATCH, 9)
    expect(await slugOf(db, c)).toBe('still_primary_stage')
  })

  it("no own-studio open deal → slug unchanged (not NULL, not the other studio's)", async () => {
    const held = await addContact(db, STILL, 'still_primary_stage')
    await addDeal(db, held, HATCH, S.waitlist, P_HATCH, 3)
    expect(await slugOf(db, held)).toBe('still_primary_stage')
    const blank = await addContact(db, STILL, null)
    await addDeal(db, blank, HATCH, S.waitlist, P_HATCH, 3)
    expect(await slugOf(db, blank)).toBeNull()
  })

  it('closing the last open deal leaves the slug unchanged', async () => {
    const c = await addContact(db, HATCH)
    const deal = await addDeal(db, c, HATCH, S.waitlist, P_HATCH, 4)
    expect(await slugOf(db, c)).toBe('hatch_waitlist')
    await db.query(`UPDATE deals SET status = 'lost' WHERE id = $1`, [deal])
    expect(await slugOf(db, c)).toBe('hatch_waitlist')
    await db.query(`DELETE FROM deals WHERE id = $1`, [deal])
    expect(await slugOf(db, c)).toBe('hatch_waitlist')
  })

  it('a disabled own-studio board is ignored', async () => {
    const c = await addContact(db, STILL, 'prior_slug')
    await addDeal(db, c, STILL, S.still2, P_STILL_2, 7)
    expect(await slugOf(db, c)).toBe('still_second_stage')
    await db.query(`UPDATE pipelines SET enabled = false WHERE id = $1`, [P_STILL_2])
    try {
      const d = await addContact(db, STILL, 'prior_slug')
      await addDeal(db, d, STILL, S.still2, P_STILL_2, 7)
      expect(await slugOf(db, d)).toBe('prior_slug')
    } finally {
      await db.query(`UPDATE pipelines SET enabled = true WHERE id = $1`, [P_STILL_2])
    }
  })

  it('a contact at a studio with no board is untouched by any deal', async () => {
    const c = await addContact(db, NOBOARD, 'keep_me')
    await addDeal(db, c, STILL, S.still, P_STILL, 8)
    expect(await slugOf(db, c)).toBe('keep_me')
  })
})

describe('mig 736 — section 2 recompute and self-check', () => {
  // Fixture written with the trigger OFF (as live data is: stale slugs from before the rule).
  const ids = {}
  const build = async () => {
    const db = await freshDb()
    // (a) x2: Stillorgan members holding an open Hatch deal, slug wrongly from it.
    ids.a1 = await addContact(db, STILL, 'hatch_waitlist')
    await addDeal(db, ids.a1, STILL, S.still, P_STILL, 1)
    await addDeal(db, ids.a1, HATCH, S.waitlist, P_HATCH, 9)
    ids.a2 = await addContact(db, STILL, 'hatch_waitlist')
    await addDeal(db, ids.a2, STILL, S.still2, P_STILL_2, 2)
    await addDeal(db, ids.a2, HATCH, S.waitlist, P_HATCH, 9)
    // (b) x1: Hatch-owned, slug came from a newer Stillorgan deal.
    ids.b1 = await addContact(db, HATCH, 'still_primary_stage')
    await addDeal(db, ids.b1, HATCH, S.waitlist, P_HATCH, 1)
    await addDeal(db, ids.b1, STILL, S.still, P_STILL, 9)
    // (d) x1: a stale slug with no Hatch deal involved.
    ids.d1 = await addContact(db, STILL, 'stale_slug')
    await addDeal(db, ids.d1, STILL, S.still3, P_STILL_3, 3)
    // already correct, no change.
    ids.ok = await addContact(db, STILL, 'still_primary_stage')
    await addDeal(db, ids.ok, STILL, S.still, P_STILL, 3)
    // no own-studio deal: keeps its slug (step 3). No-board studio likewise.
    ids.keep = await addContact(db, STILL, 'keep_me')
    await addDeal(db, ids.keep, HATCH, S.hatchAcq, P_HATCH_2, 4)
    ids.nb = await addContact(db, NOBOARD, 'keep_me_too')
    await addDeal(db, ids.nb, STILL, S.still, P_STILL, 4)
    ids.none = await addContact(db, STILL, 'no_deals')
    return db
  }
  const withCounts = (a, b, c, d) => SECTION_2
    .replace(/v_expect_a constant int := \d+/, `v_expect_a constant int := ${a}`)
    .replace(/v_expect_b constant int := \d+/, `v_expect_b constant int := ${b}`)
    .replace(/v_expect_c constant int := \d+/, `v_expect_c constant int := ${c}`)
    .replace(/v_expect_d constant int := \d+/, `v_expect_d constant int := ${d}`)
  const snapshot = async (db) => Object.fromEntries(
    (await db.query(`SELECT id, pipeline_stage_slug AS s FROM contacts`)).rows.map((r) => [r.id, r.s]))

  let db
  beforeAll(async () => { db = await build() }, 60_000)
  afterAll(() => db?.close())

  it('raises, and changes nothing, when the live counts differ from the constants', async () => {
    const before = await snapshot(db)
    await expect(runSql(db, SECTION_2)).rejects.toThrow(/HATCHPIPE\.1: slug changes a\/b\/c\/d = 2\/1\/0\/1, expected 13\/1\/0\/0/)
    expect(await snapshot(db)).toEqual(before)
  })

  it('with matching counts, applies the rule and leaves step-3 contacts alone', async () => {
    await runSql(db, withCounts(2, 1, 0, 1))
    expect(await slugOf(db, ids.a1)).toBe('still_primary_stage')
    expect(await slugOf(db, ids.a2)).toBe('still_second_stage')
    expect(await slugOf(db, ids.b1)).toBe('hatch_waitlist')
    expect(await slugOf(db, ids.d1)).toBe('still_third_stage')
    expect(await slugOf(db, ids.ok)).toBe('still_primary_stage')
    expect(await slugOf(db, ids.keep)).toBe('keep_me')
    expect(await slugOf(db, ids.nb)).toBe('keep_me_too')
    expect(await slugOf(db, ids.none)).toBe('no_deals')
  })

  it('section 2 recompute gives the same slug as the trigger for every fixture contact', async () => {
    const afterRecompute = await snapshot(db)
    await runSql(db, TRIGGER)
    await db.query(`UPDATE deals SET status = status`) // fires the trigger for every deal
    expect(await snapshot(db)).toEqual(afterRecompute)
  })

  it('leaves no temp table behind', async () => {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_class WHERE relname = 'a1_slug_rule'`)
    expect(rows[0].n).toBe(0)
  })
})

describe('mig 736 — file text', () => {
  const selects = FUNCTION_BODY.split(/\bSELECT\b/).slice(1).filter((s) => /\bFROM deals\b/.test(s))

  it('every SELECT branch filters p.location_id = v_loc and p.enabled', () => {
    expect(selects).toHaveLength(2)
    for (const s of selects) {
      expect(s).toMatch(/p\.location_id = v_loc/)
      expect(s).toMatch(/p\.enabled/)
    }
    expect(MIG).toMatch(/v_loc := \(SELECT location_id FROM contacts WHERE id = v_contact_id\)/)
  })

  it('no branch assigns NULL to pipeline_stage_slug (no "= NULL", no v_slug := NULL before the UPDATE)', () => {
    expect(MIG).not.toMatch(/=\s*NULL\b/i)
    expect(FUNCTION_BODY).not.toMatch(/v_slug\s*:=/)
    expect(FUNCTION_BODY).toMatch(/IF v_slug IS NULL THEN\s+RETURN COALESCE\(NEW, OLD\);\s+END IF;\s+UPDATE contacts/)
  })

  it('keeps IS DISTINCT FROM on the UPDATE and states "-- grant: none"', () => {
    expect(FUNCTION_BODY).toMatch(/UPDATE contacts\s+SET pipeline_stage_slug = v_slug\s+WHERE id = v_contact_id\s+AND pipeline_stage_slug IS DISTINCT FROM v_slug;/)
    expect(MIG).toMatch(/^-- grant: none \(function body only, CREATE OR REPLACE keeps the ACL\)$/m)
    expect(FUNCTION_BODY).toMatch(/security definer/i)
    expect(FUNCTION_BODY).toMatch(/set search_path to 'public'/)
  })

  it('declares the four expected-count constants and raises when any differs', () => {
    expect(SECTION_2).toMatch(/v_expect_a constant int := 13;/)
    expect(SECTION_2).toMatch(/v_expect_b constant int := 1;/)
    expect(SECTION_2).toMatch(/v_expect_c constant int := 0;/)
    expect(SECTION_2).toMatch(/v_expect_d constant int := 0;/)
    expect(SECTION_2).toMatch(/v_a is distinct from v_expect_a[\s\S]*v_d is distinct from v_expect_d[\s\S]*raise exception/)
  })

  it('post-check raises when a contact with an own-studio open deal holds a slug different from the rule', () => {
    expect(SECTION_2).toMatch(/c\.pipeline_stage_slug is distinct from r\.new_slug;\s+if v_wrong > 0 then\s+raise exception 'HATCHPIPE\.1: % contacts with an own-studio open deal hold a different slug'/)
  })
})
