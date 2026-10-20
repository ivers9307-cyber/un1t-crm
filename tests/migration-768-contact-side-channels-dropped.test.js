// ORGCONTACTS.5 — behavioural test for migration 768: the Glofox link table
// (glofox_crossover_members, mig 758) and the two functions mig 765 left as
// deprecated delegates (private.auth_contact_membership_contact_ids,
// public.crossover_contact_ids) are gone; derive_contact_studio no longer
// reads the link table (a Glofox relationship at a sibling studio IS the
// contact_studios row with source glofox); person_groups.location_id becomes
// nullable ahead of its drop (createGroup writes it for one release more).
// contact_memberships stays (the un1t adapter still reads it: Task 24 ruling).
//
// Boots the shared contact_studios world through 765 and 767, then runs the
// REAL 768 file and proves: the objects are gone; contacts_select and the
// studio helper are untouched; the reconcile still runs and keeps the sibling
// Glofox row; the file aborts while a view still depends on a dropped
// function; a second run passes. Fictional ids only.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { asUser, IDS, abortMessage } from './helpers/member-write-sweep.js'
import { mig, LOC_A, LOC_B, ORG1, signedOut, bootProd } from './helpers/contacts-resolvers-699-fixture.js'
import {
  MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764, MIG_765,
  QUAL_765, STUDIO_HELPER, OLD_HELPER, CROSS_RPC, MD5_765_STUDIO, md5Of,
  C_A, C_A2, C_C3, BEFORE2, GLOFOX_ROWS, ENDED_ROW,
} from './helpers/contact-studios-fixture.js'

const MIG_767 = mig('767_person_groups_organization.sql')
const MIG_768 = mig('768_contact_side_channels_dropped.sql')
const DERIVE = 'public.derive_contact_studio(uuid, uuid)'
const RECONCILE = 'public.reconcile_contact_studios(uuid)'

// person_groups as mig 270 made it and 681 closed it (767 then adds organization_id).
const PERSON_GROUPS = `
  CREATE TABLE public.person_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    primary_contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
    note text, created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE INDEX idx_person_groups_location ON public.person_groups(location_id);
  CREATE TABLE public.person_group_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id uuid NOT NULL REFERENCES public.person_groups(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL UNIQUE REFERENCES public.contacts(id) ON DELETE CASCADE, match_method text NOT NULL, confidence text NOT NULL,
    added_by uuid, added_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE public.person_groups ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.person_group_members ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.person_groups, public.person_group_members FROM anon, authenticated, PUBLIC;
  INSERT INTO public.person_groups (location_id, primary_contact_id) VALUES ('${LOC_A}', '${C_A}');
`
const PRE = [MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764]
async function boot({ before = '' } = {}) {
  const db = await bootProd({ before2: BEFORE2, migrate: PRE.slice(0, 4) })
  await db['exec'](GLOFOX_ROWS)
  for (const sql of PRE.slice(4)) { await signedOut(db); await db['exec'](sql) }
  await db['exec'](ENDED_ROW)
  await signedOut(db); await db['exec'](MIG_765)
  await db['exec'](PERSON_GROUPS)
  await signedOut(db); await db['exec'](MIG_767)
  if (before) await db['exec'](before)
  return db
}
const exists = async (db, fn) => (await db.query(`SELECT to_regprocedure($1) IS NOT NULL AS ok`, [fn])).rows[0].ok
const tableExists = async (db, t) => (await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t])).rows[0].ok
const nullable = async (db, col) => (await db.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = $1`, [col])).rows[0]?.is_nullable
const glofoxRowAtB = async (db) => (await db.query(`SELECT kind, status, source FROM public.contact_studios WHERE contact_id = $1 AND location_id = $2`, [C_A2, LOC_B])).rows[0] || null

let db

describe('before 768: the deprecated objects still exist', () => {
  beforeAll(async () => { db = await boot() }, 90_000)
  afterAll(() => db?.close())
  it('the link table, both functions and the NOT NULL column are there; 764 backfilled the sibling Glofox row from the link table', async () => {
    expect(await tableExists(db, 'public.glofox_crossover_members')).toBe(true)
    expect(await exists(db, OLD_HELPER)).toBe(true)
    expect(await exists(db, CROSS_RPC)).toBe(true)
    expect(await nullable(db, 'location_id')).toBe('NO')
    expect(await glofoxRowAtB(db)).toMatchObject({ source: 'glofox', status: 'active' })
  })
})

describe('after 768', () => {
  let derive768, reconcile768
  beforeAll(async () => {
    db = await boot()
    await signedOut(db); await db['exec'](MIG_768)
    derive768 = await md5Of(db, DERIVE)
    reconcile768 = await md5Of(db, RECONCILE)
  }, 90_000)
  afterAll(() => db?.close())

  it('the link table and the two functions are gone; person_groups.location_id is nullable, DEPRECATED, and the 767 fill trigger stays until the column goes', async () => {
    expect(await tableExists(db, 'public.glofox_crossover_members')).toBe(false)
    expect(await exists(db, OLD_HELPER)).toBe(false)
    expect(await exists(db, CROSS_RPC)).toBe(false)
    expect(await nullable(db, 'location_id')).toBe('YES')
    expect(await nullable(db, 'organization_id')).toBe('NO')
    const { rows: [c] } = await db.query(`SELECT col_description('public.person_groups'::regclass, ordinal_position) AS comment FROM information_schema.columns WHERE table_name = 'person_groups' AND column_name = 'location_id'`)
    expect(c.comment).toMatch(/DEPRECATED/)
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.person_groups'::regclass AND tgname = 'person_groups_set_org'`)).rows[0].n).toBe(1)
    // the old code path (location_id only) still inserts; so does one with neither NOT NULL column's old shape
    const { rows: [g] } = await db.query(`INSERT INTO public.person_groups (location_id, primary_contact_id) VALUES ($1, $2) RETURNING organization_id`, [LOC_B, C_A2])
    expect(g.organization_id).toBe(ORG1)
  })

  it('contacts_select, the studio helper and the studio_contacts view are untouched (765)', async () => {
    const { rows: [p] } = await db.query(`SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contacts' AND policyname = 'contacts_select'`)
    expect(p.qual).toBe(QUAL_765)
    expect(await md5Of(db, STUDIO_HELPER)).toBe(MD5_765_STUDIO)
    expect(await tableExists(db, 'public.studio_contacts')).toBe(true)
    // the staff member holding Contacts at B still reads A's contact through the row at B (ended included)
    expect((await asUser(db, IDS.STAFF_B, `SELECT count(*)::int AS n FROM public.contacts WHERE id = '${C_C3}'`))[0].n).toBe(1)
  })

  it('derive_contact_studio no longer names the link table, and the reconcile keeps the sibling Glofox row (source glofox at a non-home studio)', async () => {
    const { rows: [d] } = await db.query(`SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)`, [DERIVE])
    expect(d.prosrc).not.toMatch(/glofox_crossover_members/)
    expect(d.prosrc).toMatch(/contact_memberships/) // the table stays (Task 24 ruling)
    const before = await glofoxRowAtB(db)
    const { rows: [r] } = await db.query(`SELECT * FROM public.reconcile_contact_studios($1)`, [LOC_B])
    expect(r.ended).toBe(0)
    expect(await glofoxRowAtB(db)).toEqual(before)
    expect(await glofoxRowAtB(db)).toMatchObject({ source: 'glofox', status: 'active' })
    expect(derive768).toMatch(/^[0-9a-f]{32}$/)
    expect(reconcile768).toMatch(/^[0-9a-f]{32}$/)
  })

  it('idempotent: a second run passes and changes nothing', async () => {
    await signedOut(db)
    await expect(db['exec'](MIG_768)).resolves.toBeDefined()
    expect(await md5Of(db, DERIVE)).toBe(derive768)
    expect(await md5Of(db, RECONCILE)).toBe(reconcile768)
    expect(await nullable(db, 'location_id')).toBe('YES')
  })
})

describe('the file aborts as a whole', () => {
  afterEach(async () => { await db?.close() })
  it('while a view still depends on a dropped function', async () => {
    db = await boot({ before: `CREATE VIEW public.synth_dependent AS SELECT * FROM public.crossover_contact_ids('${LOC_B}')` })
    await signedOut(db)
    expect(await abortMessage(db, MIG_768)).toMatch(/mig 768: .*depend/)
    expect(await tableExists(db, 'public.glofox_crossover_members')).toBe(true)
    expect(await exists(db, OLD_HELPER)).toBe(true)
  }, 90_000)
  it('before 767 (person_groups has no organization_id)', async () => {
    db = await boot({ before: `ALTER TABLE public.person_groups DROP COLUMN organization_id` })
    await signedOut(db)
    expect(await abortMessage(db, MIG_768)).toMatch(/mig 768: apply 767_person_groups_organization first/)
  }, 90_000)
})
