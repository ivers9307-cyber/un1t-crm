// 846 — RECONCILEBATCH.1: the nightly reconcile in batches. One call over every
// (contact, studio) pair ran past the API's 8 s statement timeout; the batch
// function covers the same pairs a slice of contacts at a time. Proves, on the
// 838 fixture (real schema through 770, prod's service_role without USAGE on
// private):
//   * looping the batches from NULL until done gives exactly the counts the
//     single call gives, at any batch size;
//   * it runs as service_role (SECURITY DEFINER, pinned search_path);
//   * no client role can execute it; the old function is untouched.
// Fictional ids only: the repo is public.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mig, signedOut, bootProd } from './helpers/contacts-resolvers-699-fixture.js'
import { asRole } from './helpers/member-write-sweep.js'
import {
  MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764, MIG_765,
  BEFORE2, GLOFOX_ROWS, ENDED_ROW, PERSON_GROUPS_270, MEMBERSHIP_FACT_SEEDS,
} from './helpers/contact-studios-fixture.js'

const MIG_767 = mig('767_person_groups_organization.sql')
const MIG_768 = mig('768_contact_side_channels_dropped.sql')
const MIG_770 = mig('770_contact_studios_membership_facts.sql')
const MIG_838 = mig('838_reconcile_contact_studios_definer.sql')
const MIG_846 = mig('846_reconcile_contact_studios_batch.sql')
const PRE = [MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764]
const BATCH_FN = 'public.reconcile_contact_studios_batch(uuid, integer)'
const SINGLE = 'SELECT inserted, updated, ended, unchanged FROM public.reconcile_contact_studios(NULL)'

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


async function loopBatches(db, limit, role = null) {
  const sum = { inserted: 0, updated: 0, ended: 0, unchanged: 0 }
  let after = null
  let calls = 0
  for (;;) {
    const sql = `SELECT * FROM public.reconcile_contact_studios_batch(${after ? `'${after}'::uuid` : 'NULL'}, ${limit})`
    const [row] = role ? await asRole(db, role, sql) : (await db.query(sql)).rows
    calls++
    for (const k of Object.keys(sum)) sum[k] += Number(row[k])
    if (row.done || !row.last_contact_id || row.last_contact_id === after) break
    after = row.last_contact_id
    if (calls > 500) throw new Error('batches did not finish')
  }
  return { sum, calls }
}
async function rolledBack(db, fn) {
  await db.exec('BEGIN;')
  try { return await fn() } finally { await db.exec('ROLLBACK;') }
}

let db
describe('846: reconcile_contact_studios_batch', () => {
  beforeAll(async () => {
    db = await boot()
    await signedOut(db); await db['exec'](MIG_838)
    await signedOut(db); await db['exec'](MIG_846)
  }, 120_000)
  afterAll(() => db?.close())

  it('the batches, at any size, add up to exactly what the single call does', async () => {
    const single = await rolledBack(db, async () => (await db.query(SINGLE)).rows[0])
    for (const limit of [1, 2, 500]) {
      const { sum, calls } = await rolledBack(db, () => loopBatches(db, limit))
      expect(sum).toEqual({ inserted: single.inserted, updated: single.updated, ended: single.ended, unchanged: single.unchanged })
      if (limit === 1) expect(calls).toBeGreaterThan(1)
    }
  })

  it('runs as the service role', async () => {
    const { sum } = await rolledBack(db, () => loopBatches(db, 2, 'service_role'))
    expect(sum.inserted + sum.updated + sum.ended + sum.unchanged).toBeGreaterThan(0)
  })

  it('past the last contact it reports done with nothing to do', async () => {
    const [row] = (await db.query("SELECT * FROM public.reconcile_contact_studios_batch('ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, 10)")).rows
    expect(row).toMatchObject({ inserted: 0, updated: 0, ended: 0, unchanged: 0, done: true })
  })

  it('is SECURITY DEFINER with a pinned search_path, and service_role only', async () => {
    const { rows } = await db.query('SELECT prosecdef, proconfig FROM pg_proc WHERE oid = to_regprocedure($1)', [BATCH_FN])
    expect(rows[0].prosecdef).toBe(true)
    expect(rows[0].proconfig).toContain('search_path=public, pg_temp')
    for (const role of ['anon', 'authenticated']) {
      const { rows: r } = await db.query("SELECT has_function_privilege($1, to_regprocedure($2), 'EXECUTE') AS ok", [role, BATCH_FN])
      expect(r[0].ok).toBe(false)
    }
  })
})
