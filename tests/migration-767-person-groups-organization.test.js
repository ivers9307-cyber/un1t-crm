// ORGCONTACTS.4 — behavioural test for migration 767: person groups follow the
// organisation (spec §2.4). A person is one contact per organisation, and a
// group links the accounts a person holds across its studios, so the group's
// scope is the organisation, not one studio.
//
// Models person_groups as mig 270 made it and mig 681 closed it (RLS on, no
// policy, no client privilege), with locations in two organisations, then runs
// the REAL 767 file and proves: organization_id is backfilled from the
// location and NOT NULL; an insert that names only location_id gets its
// organisation from the fill trigger (the old code path keeps working until
// deploy); an insert whose organisation disagrees with its location is
// refused; location_id stays, commented DEPRECATED; the table stays closed to
// clients; a second run passes. Fictional ids only.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_767 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/767_person_groups_organization.sql'), 'utf8')

const ORG1 = 'f0000000-0000-0000-0000-000000000001'
const ORG2 = 'f0000000-0000-0000-0000-000000000002'
const LOC_A = 'a0000000-0000-0000-0000-00000000000a' // ORG1
const LOC_B = 'b0000000-0000-0000-0000-00000000000b' // ORG1
const LOC_D = 'd0000000-0000-0000-0000-00000000000d' // ORG2
const C1 = '30000000-0000-0000-0000-000000000001'
const C2 = '30000000-0000-0000-0000-000000000002'
const C3 = '30000000-0000-0000-0000-000000000003'
const G_A = '40000000-0000-0000-0000-00000000000a'
const G_D = '40000000-0000-0000-0000-00000000000d'

const SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA public, private TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
  CREATE TABLE public.organizations (id uuid PRIMARY KEY);
  CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id));
  CREATE TABLE public.profiles (id uuid PRIMARY KEY);
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, location_id uuid REFERENCES public.locations(id), organization_id uuid, person_group_id uuid);
  -- mig 270, as 681 left it: RLS on, no policy, no client privilege.
  CREATE TABLE public.person_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    primary_contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
    note text, created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_person_groups_location ON public.person_groups(location_id);
  CREATE TABLE public.person_group_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL REFERENCES public.person_groups(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL UNIQUE REFERENCES public.contacts(id) ON DELETE CASCADE,
    match_method text NOT NULL, confidence text NOT NULL, added_by uuid, added_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE public.person_groups ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.person_group_members ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.person_groups, public.person_group_members FROM anon, authenticated, PUBLIC;
`
const SEED = `
  INSERT INTO public.organizations VALUES ('${ORG1}'), ('${ORG2}');
  INSERT INTO public.locations VALUES ('${LOC_A}', '${ORG1}'), ('${LOC_B}', '${ORG1}'), ('${LOC_D}', '${ORG2}');
  INSERT INTO public.contacts (id, location_id, organization_id) VALUES
    ('${C1}', '${LOC_A}', '${ORG1}'), ('${C2}', '${LOC_B}', '${ORG1}'), ('${C3}', '${LOC_D}', '${ORG2}');
  INSERT INTO public.person_groups (id, location_id, primary_contact_id) VALUES ('${G_A}', '${LOC_A}', '${C1}'), ('${G_D}', '${LOC_D}', '${C3}');
  INSERT INTO public.person_group_members (group_id, contact_id, match_method, confidence) VALUES
    ('${G_A}', '${C1}', 'manual', 'manual'), ('${G_A}', '${C2}', 'manual', 'manual'), ('${G_D}', '${C3}', 'manual', 'manual');
`

let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const exec = (sql) => db.exec(sql)
async function abortMessage(sql) { try { await exec(sql); return null } catch (e) { await exec('ROLLBACK').catch(() => {}); return String(e.message || e) } }
async function asRole(role, sql) {
  await exec('BEGIN')
  try { await exec(`SET LOCAL ROLE ${role}`); return (await db.query(sql)).rows } finally { await exec('ROLLBACK') }
}
async function boot(before = '') { db = new PGlite(); await exec(SCHEMA); await exec(SEED); if (before) await exec(before) }
const colInfo = (col) => q(`SELECT is_nullable, col_description('public.person_groups'::regclass, ordinal_position) AS comment
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = $1`, [col])

describe('after 767', () => {
  beforeAll(async () => { await boot(); await exec(MIG_767) }, 60_000)
  afterAll(() => db?.close())

  it('organization_id is backfilled from each group’s location and NOT NULL, indexed; location_id stays, DEPRECATED', async () => {
    expect(await q(`SELECT id, organization_id FROM public.person_groups ORDER BY id`)).toEqual([
      { id: G_A, organization_id: ORG1 }, { id: G_D, organization_id: ORG2 },
    ])
    expect((await colInfo('organization_id'))[0].is_nullable).toBe('NO')
    expect((await colInfo('location_id'))[0].is_nullable).toBe('NO')
    expect((await colInfo('location_id'))[0].comment).toMatch(/DEPRECATED \(mig 767\)/)
    expect(await q(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_person_groups_organization'`)).toHaveLength(1)
    const fk = await q(`SELECT confrelid::regclass::text AS ref FROM pg_constraint WHERE conrelid = 'public.person_groups'::regclass AND contype = 'f'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.person_groups'::regclass AND attname = 'organization_id')]`)
    expect(fk).toEqual([{ ref: 'organizations' }])
  })

  it('the fill trigger: an insert naming only location_id (the old code path) gets its organisation; one naming both keeps it', async () => {
    const [g] = await q(`INSERT INTO public.person_groups (location_id, primary_contact_id) VALUES ($1, $2) RETURNING organization_id`, [LOC_B, C2])
    expect(g.organization_id).toBe(ORG1)
    const [h] = await q(`INSERT INTO public.person_groups (location_id, organization_id, primary_contact_id) VALUES ($1, $2, $3) RETURNING organization_id`, [LOC_D, ORG2, C3])
    expect(h.organization_id).toBe(ORG2)
  })

  it('an insert whose organisation disagrees with its location is refused', async () => {
    const msg = await abortMessage(`INSERT INTO public.person_groups (location_id, organization_id, primary_contact_id) VALUES ('${LOC_A}', '${ORG2}', '${C1}')`)
    expect(msg).toMatch(/person_groups: organization_id .* does not match the location/)
  })

  it('closed to clients as mig 681 left it: no privilege, RLS on, no policy; service_role reads', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const t of ['person_groups', 'person_group_members']) {
        expect((await q(`SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [role, `public.${t}`]))[0].ok).toBe(false)
      }
    }
    expect(await q(`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('person_groups', 'person_group_members')`)).toEqual([])
    expect((await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.person_groups'::regclass`))[0].relrowsecurity).toBe(true)
    expect(await asRole('service_role', `SELECT count(*)::int AS n FROM public.person_groups`)).toEqual([{ n: 4 }])
  })

  it('idempotent: a second run passes and changes nothing', async () => {
    const before = await q(`SELECT id, organization_id, location_id FROM public.person_groups ORDER BY id`)
    await expect(exec(MIG_767)).resolves.toBeDefined()
    expect(await q(`SELECT id, organization_id, location_id FROM public.person_groups ORDER BY id`)).toEqual(before)
  })
})

describe('the file aborts as a whole', () => {
  afterEach(async () => { await db?.close() })
  it('when a group’s location has no organisation to backfill from', async () => {
    await boot(`UPDATE public.locations SET organization_id = NULL WHERE id = '${LOC_D}'`.replace('SET organization_id = NULL', 'SET organization_id = organization_id'))
    // locations.organization_id is NOT NULL in this model; simulate an orphan by a group whose location is gone from the join
    await exec(`ALTER TABLE public.locations ALTER COLUMN organization_id DROP NOT NULL; UPDATE public.locations SET organization_id = NULL WHERE id = '${LOC_D}'`)
    expect(await abortMessage(MIG_767)).toMatch(/mig 767: .* person_groups rows? (have|has) no organisation/)
    expect(await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'person_groups' AND column_name = 'organization_id'`)).toEqual([])
  }, 60_000)
})
