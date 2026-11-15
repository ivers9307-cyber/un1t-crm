// 838 — RECONCILEDEF.1: the nightly contact_studios reconcile can run as the
// service role. Prod's service_role holds no USAGE on schema private (migs 721,
// 753), and reconcile_contact_studios was SECURITY INVOKER calling
// private.contact_studios_upsert, so every call failed "permission denied for
// schema private" (PostgREST 403) from mig 764 until this file.
//
// The shared fixture grants USAGE on private to service_role
// (tests/helpers/member-write-sweep.js BASE_SCHEMA), which is why no earlier
// test saw the failure. This file revokes it first, to model prod, then:
//   * reproduces the failure as service_role before 838;
//   * proves 838 makes the same call succeed with the same counts postgres gets;
//   * keeps the body, comment-free source and ACL; no client role can execute;
//   * a second run changes nothing.
// PGlite over the shared fixture, through 770, then this file.
// Fictional ids only: the repo is public.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mig, signedOut, bootProd } from './helpers/contacts-resolvers-699-fixture.js'
import { asRole } from './helpers/member-write-sweep.js'
import {
  MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764, MIG_765, md5Of,
  BEFORE2, GLOFOX_ROWS, ENDED_ROW, PERSON_GROUPS_270, MEMBERSHIP_FACT_SEEDS,
} from './helpers/contact-studios-fixture.js'

const MIG_767 = mig('767_person_groups_organization.sql')
const MIG_768 = mig('768_contact_side_channels_dropped.sql')
const MIG_770 = mig('770_contact_studios_membership_facts.sql')
const MIG_838 = mig('838_reconcile_contact_studios_definer.sql')
const PRE = [MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764]
const RECONCILE = 'public.reconcile_contact_studios(uuid)'
const CALL = 'SELECT * FROM public.reconcile_contact_studios(NULL)'

async function boot() {
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
  // Prod: service_role has no USAGE on schema private. The fixture grants it.
  await db['exec']('REVOKE USAGE ON SCHEMA private FROM service_role;')
  return db
}

const errorOf = async (fn) => { try { await fn(); return null } catch (e) { return String(e.message || e) } }
const fnRow = async (db) => (await db.query(
  `SELECT prosecdef, proconfig, proacl::text AS acl FROM pg_proc WHERE oid = to_regprocedure($1)`, [RECONCILE])).rows[0]
const canExec = async (db, role) => (await db.query(
  `SELECT has_function_privilege($1, to_regprocedure($2), 'EXECUTE') AS ok`, [role, RECONCILE])).rows[0].ok

let db
describe('838: reconcile_contact_studios runs as the service role', () => {
  let srcBefore, aclBefore
  beforeAll(async () => {
    db = await boot()
    srcBefore = await md5Of(db, RECONCILE)
    aclBefore = (await fnRow(db)).acl
  }, 120_000)
  afterAll(() => db?.close())

  it('before 838 the service role is refused: permission denied for schema private', async () => {
    expect(await fnRow(db)).toMatchObject({ prosecdef: false })
    const err = await errorOf(() => asRole(db, 'service_role', CALL))
    expect(err).toMatch(/permission denied for schema private/)
  })

  it('after 838 the same call succeeds and reports the same counts as the owner', async () => {
    await signedOut(db); await db['exec'](MIG_838)
    // Run as service_role first (rolled back), then as postgres, so both see the same starting rows.
    const [asService] = await asRole(db, 'service_role', CALL)
    await db.exec('BEGIN;')
    let asOwner
    try { asOwner = (await db.query(CALL)).rows[0] } finally { await db.exec('ROLLBACK;') }
    expect(asService).toBeTruthy()
    expect(asService).toEqual(asOwner)
    expect(Object.keys(asService).sort()).toEqual(['ended', 'inserted', 'skipped_no_primary', 'unchanged', 'updated'])
  })

  it('is SECURITY DEFINER with the search_path pinned; body and ACL unchanged', async () => {
    const row = await fnRow(db)
    expect(row.prosecdef).toBe(true)
    expect(row.proconfig).toEqual(['search_path=public, pg_temp'])
    expect(await md5Of(db, RECONCILE)).toBe(srcBefore)
    expect(row.acl).toBe(aclBefore)
  })

  it('no client role can execute it; service_role can', async () => {
    expect(await canExec(db, 'anon')).toBe(false)
    expect(await canExec(db, 'authenticated')).toBe(false)
    expect(await canExec(db, 'service_role')).toBe(true)
    const err = await errorOf(() => asRole(db, 'authenticated', CALL))
    expect(err).toMatch(/permission denied for function reconcile_contact_studios/)
  })

  it('does not widen the private schema: service_role still has no USAGE on it', async () => {
    const { rows: [r] } = await db.query(`SELECT has_schema_privilege('service_role', 'private', 'USAGE') AS u`)
    expect(r.u).toBe(false)
  })

  it('idempotent: a second run passes and changes nothing', async () => {
    const before = await fnRow(db)
    expect(await errorOf(() => db.exec(MIG_838))).toBeNull()
    expect(await fnRow(db)).toEqual(before)
    expect(await md5Of(db, RECONCILE)).toBe(srcBefore)
  })
})
