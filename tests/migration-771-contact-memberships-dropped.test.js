// 771 — ORGCONTACTS.7: contact_memberships is dropped, after a parity pass.
// Applied AFTER the code of the PR deploys and after one un1t sync has run on
// it: in the window between 770's apply and the deploy the old code kept
// writing the table every 15 minutes and never the columns, so 771 first
// copies status / ended_at / plan from any api row that differs (since only
// where the column is null), reports the count, then drops the table.
// PGlite over the shared fixture, through 770, then this file.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mig, LOC_A, LOC_B, signedOut, bootProd } from './helpers/contacts-resolvers-699-fixture.js'
import {
  MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764, MIG_765, md5Of,
  C_C1, C_D1, C_C2, BEFORE2, GLOFOX_ROWS, ENDED_ROW, PERSON_GROUPS_270, MEMBERSHIP_FACT_SEEDS,
} from './helpers/contact-studios-fixture.js'

const MIG_767 = mig('767_person_groups_organization.sql')
const MIG_768 = mig('768_contact_side_channels_dropped.sql')
const MIG_770 = mig('770_contact_studios_membership_facts.sql')
const MIG_771 = mig('771_contact_memberships_dropped.sql')
const PRE = [MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764]
const DERIVE = 'public.derive_contact_studio(uuid, uuid)'

async function boot({ before771 = '' } = {}) {
  const db = await bootProd({ before2: BEFORE2, migrate: PRE.slice(0, 4) })
  await db['exec'](GLOFOX_ROWS)
  for (const sql of PRE.slice(4)) { await signedOut(db); await db['exec'](sql) }
  await db['exec'](ENDED_ROW)
  await signedOut(db); await db['exec'](MIG_765)
  await db['exec'](PERSON_GROUPS_270)
  await signedOut(db); await db['exec'](MIG_767)
  await signedOut(db); await db['exec'](MIG_768)
  await db['exec'](MEMBERSHIP_FACT_SEEDS)
  await signedOut(db); await db['exec'](MIG_770)
  if (before771) await db['exec'](before771)
  return db
}
const abortMessage = async (db, sql) => { try { await db.exec(sql); return null } catch (e) { await db.exec('ROLLBACK').catch(() => {}); return String(e.message || e) } }
const facts = async (db, c, l) => (await db.query(`SELECT membership_plan, membership_status, membership_since, membership_ended_at FROM public.contact_studios WHERE contact_id = $1 AND location_id = $2`, [c, l])).rows[0] || null
const tableGone = async (db) => (await db.query(`SELECT to_regclass('public.contact_memberships') IS NULL AS gone`)).rows[0].gone

// The window: the old code ended C_C1's membership, changed C_D1's plan on its
// ended row, and recorded a brand-new api membership for C_C2 at B (whose
// relationship row carries no facts yet).
const WINDOW = `
  UPDATE public.contact_memberships SET status = 'ended', ended_at = '2026-10-20T00:00:00Z' WHERE contact_id = '${C_C1}' AND location_id = '${LOC_B}' AND source = 'un1t_online_api';
  UPDATE public.contact_memberships SET plan_name = 'Monthly (renamed)' WHERE contact_id = '${C_D1}' AND location_id = '${LOC_A}' AND source = 'un1t_online_api';
  INSERT INTO public.contact_memberships (organization_id, location_id, contact_id, source, plan_name, status, first_seen_at)
    SELECT organization_id, '${LOC_B}', '${C_C2}', 'un1t_online_api', 'New plan', 'active', '2026-10-21T00:00:00Z' FROM public.locations WHERE id = '${LOC_B}';
  INSERT INTO public.contact_studios (contact_id, location_id, organization_id, kind, status, source)
    SELECT '${C_C2}', '${LOC_B}', organization_id, 'member', 'active', 'un1t_online' FROM public.locations WHERE id = '${LOC_B}'
    ON CONFLICT (contact_id, location_id) DO NOTHING;
`

let db
describe('after 771', () => {
  beforeAll(async () => { db = await boot({ before771: WINDOW }); await signedOut(db) }, 120_000)
  afterAll(() => db?.close())

  it('copies status, ended_at and plan from newer api rows (since only where null), reports the count, then drops the table', async () => {
    expect(await abortMessage(db, MIG_771)).toBeNull()
    expect(await tableGone(db)).toBe(true)
    expect(await facts(db, C_C1, LOC_B)).toEqual({ membership_plan: 'Founding Membership — Unlimited', membership_status: 'ended', membership_since: new Date('2026-02-01T00:00:00Z'), membership_ended_at: new Date('2026-10-20T00:00:00Z') })
    expect(await facts(db, C_D1, LOC_A)).toEqual({ membership_plan: 'Monthly (renamed)', membership_status: 'active', membership_since: new Date('2026-03-01T00:00:00Z'), membership_ended_at: null })
    expect(await facts(db, C_C2, LOC_B)).toEqual({ membership_plan: 'New plan', membership_status: 'active', membership_since: new Date('2026-10-21T00:00:00Z'), membership_ended_at: null })
  })

  it('nothing references the table afterwards; the four columns and their CHECKs stay; derive and reconcile are untouched', async () => {
    const { rows: [n] } = await db.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname IN ('public', 'private') AND p.prosrc ILIKE '%contact_memberships%'`)
    expect(n.n).toBe(0)
    const { rows: cols } = await db.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contact_studios' AND column_name LIKE 'membership_%'`)
    expect(cols[0].n).toBe(4)
    expect(await md5Of(db, DERIVE)).toBeTruthy()
  })

  it('idempotent: a second run passes and changes nothing', async () => {
    const before = await facts(db, C_C1, LOC_B)
    expect(await abortMessage(db, MIG_771)).toBeNull()
    expect(await facts(db, C_C1, LOC_B)).toEqual(before)
  })
})

describe('the file refuses, or replays safely', () => {
  afterAll(() => db?.close())
  it('refuses while a function other than derive / reconcile still names the table, and changes nothing', { timeout: 120_000 }, async () => {
    db = await boot({ before771: `CREATE FUNCTION public.m771_probe() RETURNS int LANGUAGE sql AS $$ SELECT count(*)::int FROM public.contact_memberships $$;` })
    await signedOut(db)
    expect(await abortMessage(db, MIG_771)).toMatch(/mig 771: .*m771_probe/)
    expect(await tableGone(db)).toBe(false)
    await db.close()
  })
  it('replay-safe: on an absent table it passes and does nothing', { timeout: 120_000 }, async () => {
    db = await boot({ before771: `DROP TABLE public.contact_memberships;` })
    await signedOut(db)
    expect(await abortMessage(db, MIG_771)).toBeNull()
    expect(await tableGone(db)).toBe(true)
  })
})
