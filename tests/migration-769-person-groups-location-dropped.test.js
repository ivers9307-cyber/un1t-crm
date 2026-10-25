// 769 — ORGCONTACTS.6: person_groups.location_id (DEPRECATED since mig 767,
// nullable since 768) and the 767 fill trigger go. createGroup stopped
// writing the column in the same PR; the file is applied AFTER that deploys.
// PGlite over mig 270's shape as 681 left it, then the real 767 and 768
// person_groups statements, then this file.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const mig = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_767 = mig('767_person_groups_organization.sql')
const MIG_769 = mig('769_person_groups_location_dropped.sql')

const ORG1 = 'f0000000-0000-0000-0000-000000000001'
const ORG2 = 'f0000000-0000-0000-0000-000000000002'
const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_D = 'd0000000-0000-0000-0000-00000000000d'
const C1 = '30000000-0000-0000-0000-000000000001'
const C3 = '30000000-0000-0000-0000-000000000003'
const G_A = '40000000-0000-0000-0000-00000000000a'

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
  -- mig 334's primary-flag sync trigger lives on the table in prod (read 25 Oct 2026); 769 must leave it alone.
  CREATE FUNCTION private.sync_group_primary_flags() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  CREATE TRIGGER trg_sync_group_primary_flags AFTER INSERT OR UPDATE ON public.person_groups FOR EACH ROW EXECUTE FUNCTION private.sync_group_primary_flags();
`
const SEED = `
  INSERT INTO public.organizations VALUES ('${ORG1}'), ('${ORG2}');
  INSERT INTO public.locations VALUES ('${LOC_A}', '${ORG1}'), ('${LOC_D}', '${ORG2}');
  INSERT INTO public.contacts (id, location_id, organization_id) VALUES ('${C1}', '${LOC_A}', '${ORG1}'), ('${C3}', '${LOC_D}', '${ORG2}');
  INSERT INTO public.person_groups (id, location_id, primary_contact_id) VALUES ('${G_A}', '${LOC_A}', '${C1}');
`
// mig 768's person_groups statement (the rest of 768 needs the whole contacts world).
const MIG_768_PERSON_GROUPS = `ALTER TABLE public.person_groups ALTER COLUMN location_id DROP NOT NULL;`

let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const exec = (sql) => db.exec(sql)
async function abortMessage(sql) { try { await exec(sql); return null } catch (e) { await exec('ROLLBACK').catch(() => {}); return String(e.message || e) } }
async function boot({ through768 = true } = {}) {
  db = new PGlite(); await exec(SCHEMA); await exec(SEED); await exec(MIG_767)
  if (through768) await exec(MIG_768_PERSON_GROUPS)
}
const hasColumn = () => q(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = 'location_id'`)
const triggers = () => q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.person_groups'::regclass AND NOT tgisinternal ORDER BY 1`)

describe('after 769', () => {
  beforeAll(async () => { await boot(); await exec(MIG_769) }, 60_000)
  afterAll(() => db?.close())

  it('location_id, its index, the 767 fill trigger and its function are gone; organization_id stays NOT NULL', async () => {
    expect(await hasColumn()).toEqual([])
    expect(await q(`SELECT to_regclass('public.idx_person_groups_location') AS r`)).toEqual([{ r: null }])
    expect((await triggers()).map((t) => t.tgname)).toEqual(['trg_sync_group_primary_flags']) // 334's stays
    expect(await q(`SELECT to_regprocedure('private.person_groups_set_org()') IS NULL AS gone`)).toEqual([{ gone: true }])
    expect(await q(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'person_groups' AND column_name = 'organization_id'`)).toEqual([{ is_nullable: 'NO' }])
  })

  it('a group is created with its organisation and nothing else (createGroup’s write); without one it is refused by the column, not a trigger', async () => {
    await exec(`INSERT INTO public.person_groups (organization_id, primary_contact_id) VALUES ('${ORG2}', '${C3}')`)
    expect(await q(`SELECT count(*)::int AS n FROM public.person_groups WHERE organization_id = '${ORG2}'`)).toEqual([{ n: 1 }])
    expect(await abortMessage(`INSERT INTO public.person_groups (primary_contact_id) VALUES ('${C1}')`)).toMatch(/organization_id/)
  })

  it('still closed to clients: no privilege, RLS on, no policy', async () => {
    expect(await q(`SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE table_schema = 'public' AND table_name = 'person_groups' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`)).toEqual([{ n: 0 }])
    expect(await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.person_groups'::regclass`)).toEqual([{ relrowsecurity: true }])
    expect(await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'person_groups'`)).toEqual([{ n: 0 }])
  })

  it('idempotent: a second run passes and changes nothing', async () => {
    expect(await abortMessage(MIG_769)).toBeNull()
    expect(await hasColumn()).toEqual([])
  })
})

describe('the file aborts as a whole', () => {
  afterAll(() => db?.close())
  it('before 768 (location_id still NOT NULL: the code may still write it)', async () => {
    await boot({ through768: false })
    expect(await abortMessage(MIG_769)).toMatch(/mig 769: apply 768/)
    expect(await hasColumn()).toHaveLength(1)
    expect((await triggers()).map((t) => t.tgname)).toEqual(['person_groups_set_org', 'trg_sync_group_primary_flags'])
  })
})
