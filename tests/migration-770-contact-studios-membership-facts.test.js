// 770 — ORGCONTACTS.7 (spec 2026-10-25): the un1t.online membership facts move
// onto the relationship row. Four sync-owned columns on contact_studios,
// backfilled from contact_memberships' API rows (never the export artefacts);
// derive_contact_studio reads membership_status = 'active' as the membership
// and membership_since into first_seen_at; reconcile_contact_studios no longer
// unions the table; contact_studios_upsert never names a membership column.
// PGlite over the shared fixture, through 768, then this file.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mig, LOC_A, LOC_B, signedOut, bootProd } from './helpers/contacts-resolvers-699-fixture.js'
import {
  MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764, MIG_765, md5Of,
  C_C1, C_D1, C_C2, C_C3, BEFORE2, GLOFOX_ROWS, ENDED_ROW, PERSON_GROUPS_270, MEMBERSHIP_FACT_SEEDS,
} from './helpers/contact-studios-fixture.js'

const MIG_767 = mig('767_person_groups_organization.sql')
const MIG_768 = mig('768_contact_side_channels_dropped.sql')
const MIG_770 = mig('770_contact_studios_membership_facts.sql')
const PRE = [MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764]
const DERIVE = 'public.derive_contact_studio(uuid, uuid)'
const RECONCILE = 'public.reconcile_contact_studios(uuid)'
const COLS = ['membership_ended_at', 'membership_plan', 'membership_since', 'membership_status'] // alphabetical, as the catalog query orders

async function boot({ before770 = '' } = {}) {
  const db = await bootProd({ before2: BEFORE2, migrate: PRE.slice(0, 4) })
  await db['exec'](GLOFOX_ROWS)
  for (const sql of PRE.slice(4)) { await signedOut(db); await db['exec'](sql) }
  await db['exec'](ENDED_ROW)
  await signedOut(db); await db['exec'](MIG_765)
  await db['exec'](PERSON_GROUPS_270)
  await signedOut(db); await db['exec'](MIG_767)
  await signedOut(db); await db['exec'](MIG_768)
  await db['exec'](MEMBERSHIP_FACT_SEEDS)
  if (before770) await db['exec'](before770)
  return db
}
const abortMessage = async (db, sql) => { try { await db.exec(sql); return null } catch (e) { await db.exec('ROLLBACK').catch(() => {}); return String(e.message || e) } }
const facts = async (db, c, l) => (await db.query(`SELECT membership_plan, membership_status, membership_since, membership_ended_at FROM public.contact_studios WHERE contact_id = $1 AND location_id = $2`, [c, l])).rows[0] || null
const columns = async (db) => (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contact_studios' AND column_name LIKE 'membership_%' ORDER BY 1`)).rows.map((r) => r.column_name)

let db
describe('after 770', () => {
  let derive770, reconcile770
  beforeAll(async () => { db = await boot(); await signedOut(db); await db['exec'](MIG_770); derive770 = await md5Of(db, DERIVE); reconcile770 = await md5Of(db, RECONCILE) }, 120_000)
  afterAll(() => db?.close())

  it('adds the four columns with their CHECKs; service role only, no client privilege', async () => {
    expect(await columns(db)).toEqual(COLS)
    const { rows: checks } = await db.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'public.contact_studios'::regclass AND contype = 'c' AND conname LIKE 'contact_studios_membership_%' ORDER BY 1`)
    expect(checks.map((c) => c.conname)).toEqual(['contact_studios_membership_shape_check', 'contact_studios_membership_status_check'])
    expect(await abortMessage(db, `UPDATE public.contact_studios SET membership_status = 'ended', membership_ended_at = NULL WHERE contact_id = '${C_C1}' AND location_id = '${LOC_B}'`)).toMatch(/membership_status_check/)
    expect(await abortMessage(db, `UPDATE public.contact_studios SET membership_plan = 'x' WHERE contact_id = '${C_C2}'`)).toMatch(/membership_shape_check/)
    const { rows: [p] } = await db.query(`SELECT count(*)::int AS n FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = 'contact_studios' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`)
    expect(p.n).toBe(0)
  })

  it('backfills every un1t_online_api row (plan, status, since, ended_at) and no export row', async () => {
    expect(await facts(db, C_C1, LOC_B)).toEqual({ membership_plan: 'Founding Membership — Unlimited', membership_status: 'active', membership_since: new Date('2026-02-01T00:00:00Z'), membership_ended_at: null })
    expect(await facts(db, C_D1, LOC_A)).toEqual({ membership_plan: 'Monthly', membership_status: 'active', membership_since: new Date('2026-03-01T00:00:00Z'), membership_ended_at: null })
    expect(await facts(db, C_C3, LOC_B)).toEqual({ membership_plan: 'Old plan', membership_status: 'ended', membership_since: new Date('2026-01-01T00:00:00Z'), membership_ended_at: new Date('2026-09-01T00:00:00Z') })
    // the export artefact at B for C_C1 did not overwrite the api facts; a contact with export rows only carries none
    const { rows: [n] } = await db.query(`SELECT count(*)::int AS n FROM public.contact_studios WHERE membership_status IS NOT NULL`)
    expect(n.n).toBe(3)
  })

  it("derive reads membership_status = 'active' as the membership (kind member) and membership_since into first_seen_at; an ended one is kind client", async () => {
    const { rows: [c1] } = await db.query(`SELECT kind, status, first_seen_at FROM public.derive_contact_studio($1, $2)`, [C_C1, LOC_B])
    expect(c1).toMatchObject({ kind: 'member', status: 'active' })
    expect(new Date(c1.first_seen_at).getTime()).toBeLessThanOrEqual(new Date('2026-02-01T00:00:00Z').getTime())
    // C_C3 at B: an ended membership is no membership (and nothing else holds the relationship)
    const { rows: [c3] } = await db.query(`SELECT kind, status FROM public.derive_contact_studio($1, $2)`, [C_C3, LOC_B])
    expect(c3.kind).not.toBe('member')
    expect(c3.status).toBe('ended')
    const { rows: [src] } = await db.query(`SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)`, [DERIVE])
    expect(src.prosrc).not.toMatch(/contact_memberships/)
    const { rows: [rsrc] } = await db.query(`SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)`, [RECONCILE])
    expect(rsrc.prosrc).not.toMatch(/contact_memberships/)
  })

  it('contact_studios_upsert never names a membership column: the reconcile leaves plan/status/since/ended_at as they were', async () => {
    await db.query(`UPDATE public.contact_studios SET membership_plan = 'Hand-set plan' WHERE contact_id = $1 AND location_id = $2`, [C_C1, LOC_B])
    await db.query(`SELECT * FROM public.reconcile_contact_studios(NULL)`)
    expect((await facts(db, C_C1, LOC_B)).membership_plan).toBe('Hand-set plan')
    const { rows: [u] } = await db.query(`SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('private.contact_studios_upsert(uuid, uuid)')`)
    expect(u.prosrc).not.toMatch(/membership_/)
  })

  it('idempotent: a second run passes and changes nothing (derive and reconcile unchanged)', async () => {
    expect(await abortMessage(db, MIG_770)).toBeNull()
    expect(await md5Of(db, DERIVE)).toBe(derive770)
    expect(await md5Of(db, RECONCILE)).toBe(reconcile770)
    expect(await columns(db)).toEqual(COLS)
  })
})

describe('the file aborts as a whole, or replays safely', () => {
  afterAll(() => db?.close())
  it('fails closed on an api row violating the CHECK, naming it, and changes nothing', async () => {
    db = await boot({ before770: `UPDATE public.contact_memberships SET ended_at = now() WHERE contact_id = '${C_C1}' AND location_id = '${LOC_B}' AND source = 'un1t_online_api'` })
    await signedOut(db)
    expect(await abortMessage(db, MIG_770)).toMatch(/mig 770: .*(violat|active with an ended_at)/)
    expect(await columns(db)).toEqual([])
    await db.close()
  })
  it('replay-safe: with no source columns on contact_memberships (the 648 stub) it adds the columns and backfills nothing', async () => {
    db = await boot({ before770: `DROP TABLE public.contact_memberships; CREATE TABLE public.contact_memberships (id uuid PRIMARY KEY, source text NOT NULL);` })
    await signedOut(db)
    expect(await abortMessage(db, MIG_770)).toBeNull()
    expect(await columns(db)).toEqual(COLS)
    const { rows: [n] } = await db.query(`SELECT count(*)::int AS n FROM public.contact_studios WHERE membership_status IS NOT NULL`)
    expect(n.n).toBe(0)
  })
})
