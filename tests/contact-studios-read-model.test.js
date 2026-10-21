// ORGCONTACTS.5 — the contacts read model, pinned once against the single
// relationship helper (spec §2.3): one PGlite replay of the shared fixture
// through migs 699, 731, 732, 758, 762, 764, 765, 767 and 768, asserting what
// stands at the end rather than each step (the per-migration tests for
// 731/732/758/762 went with their objects; 764/765/767/768 keep theirs):
//   * contacts_select is 765's three-branch policy: Contacts at the row's
//     studio, the member's own row, or ANY contact_studios row at a studio
//     where the caller holds Contacts (private.auth_contact_studio_contact_ids,
//     an InitPlan, 765's body); the membership helper and crossover_contact_ids
//     are gone;
//   * who sees whom: Contacts at B reads A's contact with a deal at B, the
//     Stillorgan member whose Glofox account was linked at B, B's own, the
//     un1t client, the active member, an ENDED relationship at B (decision
//     2), and not a contact whose only relationship is at C; Contacts at A
//     alone reads none of B's relationships; a member reads their own row;
//   * the tables are closed: anon and authenticated hold nothing on
//     contact_studios or studio_contacts; the view is security_invoker;
//   * the reconcile re-derives every pair with the tables that remain.
// Fictional ids only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { asUser, asRole, IDS } from './helpers/member-write-sweep.js'
import { mig, LOC_A, LOC_B, LOC_C, ORG1, signedOut, bootProd } from './helpers/contacts-resolvers-699-fixture.js'
import {
  MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764, MIG_765,
  QUAL_765, STUDIO_HELPER, OLD_HELPER, CROSS_RPC, MD5_765_STUDIO, md5Of,
  C_A, C_A2, C_B, C_C1, C_D1, C_C2, C_C3, BEFORE2, GLOFOX_ROWS, ENDED_ROW, PERSON_GROUPS_270,
} from './helpers/contact-studios-fixture.js'

const MIG_767 = mig('767_person_groups_organization.sql')
const MIG_768 = mig('768_contact_side_channels_dropped.sql')
const PRE = [MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764]

let db
const sees = async (uid, id) => (await asUser(db, uid, `SELECT count(*)::int AS n FROM public.contacts WHERE id = '${id}'`))[0].n === 1
const count = async (uid) => (await asUser(db, uid, 'SELECT count(*)::int AS n FROM public.contacts'))[0].n

beforeAll(async () => {
  db = await bootProd({ before2: BEFORE2, migrate: PRE.slice(0, 4) })
  await db['exec'](GLOFOX_ROWS)
  for (const sql of PRE.slice(4)) { await signedOut(db); await db['exec'](sql) }
  await db['exec'](ENDED_ROW)
  await signedOut(db); await db['exec'](MIG_765)
  await db['exec'](PERSON_GROUPS_270)
  await signedOut(db); await db['exec'](MIG_767)
  await signedOut(db); await db['exec'](MIG_768)
}, 120_000)
afterAll(() => db?.close())

describe('the single relationship helper', () => {
  it('contacts_select is 765’s policy on the studio helper (765’s body); the membership helper and the RPC are gone', async () => {
    const { rows: [p] } = await db.query(`SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'`)
    expect(p.qual).toBe(QUAL_765)
    expect(await md5Of(db, STUDIO_HELPER)).toBe(MD5_765_STUDIO)
    expect((await db.query(`SELECT to_regprocedure($1) IS NULL AS gone`, [OLD_HELPER])).rows[0].gone).toBe(true)
    expect((await db.query(`SELECT to_regprocedure($1) IS NULL AS gone`, [CROSS_RPC])).rows[0].gone).toBe(true)
    expect((await db.query(`SELECT to_regclass('public.glofox_crossover_members') IS NULL AS gone`)).rows[0].gone).toBe(true)
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts'`)).rows[0].n).toBe(1)
  })
})

describe('who sees whom', () => {
  it('Contacts at B: every contact with a relationship at B, an ended one included; not one whose only relationship is at C', async () => {
    for (const id of [C_B, C_C1, C_D1, C_A2, C_A, C_C3]) expect(await sees(IDS.STAFF_B, id), id).toBe(true)
    expect(await sees(IDS.STAFF_B, C_C2)).toBe(false)
    expect(await count(IDS.STAFF_B)).toBe(6)
  })
  it('Contacts at A alone: A’s own contacts, none of B’s relationships', async () => {
    expect(await sees(IDS.STAFF_A, C_A)).toBe(true)
    expect(await sees(IDS.STAFF_A, C_B)).toBe(false)
    expect(await sees(IDS.STAFF_A, C_C1)).toBe(false)
    expect(await sees(IDS.STAFF_A, C_C2)).toBe(false)
  })
  it('a member reads their own row and nothing else', async () => {
    expect(await sees(IDS.MEMBER_UID, IDS.C_MEMBER)).toBe(true)
    expect(await count(IDS.MEMBER_UID)).toBe(1)
  })
})

describe('closed tables', () => {
  it('anon and authenticated hold nothing on contact_studios or studio_contacts; the view is security_invoker; service_role reads both', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const rel of ['public.contact_studios', 'public.studio_contacts']) {
        expect((await db.query(`SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [role, rel]))[0]?.ok ?? (await db.query(`SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [role, rel])).rows[0].ok).toBe(false)
      }
    }
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contact_studios'`)).rows[0].n).toBe(0)
    expect((await db.query(`SELECT array_to_string(reloptions, ',') AS o FROM pg_class WHERE oid = 'public.studio_contacts'::regclass`)).rows[0].o).toBe('security_invoker=on')
    expect((await asRole(db, 'service_role', `SELECT count(*)::int AS n FROM public.studio_contacts`))[0].n).toBeGreaterThan(0)
  })
})

describe('the reconcile with the tables that remain', () => {
  it('re-derives every pair, keeps the Glofox row at B and the ended row, ends nothing it should not', async () => {
    const { rows: [r] } = await db.query(`SELECT * FROM public.reconcile_contact_studios(NULL)`)
    expect(r.ended).toBe(0)
    const { rows } = await db.query(`SELECT contact_id, location_id, kind, status, source FROM public.contact_studios WHERE location_id = $1 ORDER BY contact_id`, [LOC_B])
    expect(rows.find((x) => x.contact_id === C_A2)).toMatchObject({ source: 'glofox', status: 'active' })
    expect(rows.find((x) => x.contact_id === C_C3)).toMatchObject({ status: 'ended' })
    expect(rows.find((x) => x.contact_id === C_A)).toMatchObject({ source: 'deal', status: 'active', kind: 'lead' })
  })
})
