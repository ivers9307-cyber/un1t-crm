// ORGCONTACTS.2 — behavioural test for migration 765: contacts_select reads
// contact_studios, one branch for every relationship (decision 2: any row,
// active or ended), and the studio_contacts view the lists read.
//
// Builds prod's state the way the 762 test does (the shared fixture in
// tests/helpers/contacts-resolvers-699-fixture.js: post-677 privileges, the
// REAL 690 and 691 files; then the REAL 699, 731, 732, 758 and 762 files with
// the side-channel tables as their migrations left them), adds what mig 764
// reads, applies the REAL 764 and 765 files. Then:
//   * staff holding Contacts at B read every contact with a contact_studios
//     row at B, an ENDED one included; a row at a studio where they lack
//     Contacts grants nothing; a contact whose only row is at C is invisible;
//   * the policy is this file's; both helpers are InitPlans; the old helper
//     delegates; crossover_contact_ids reads the table; the view is
//     security_invoker and closed to clients; idempotent; abort cases; the
//     rollback record.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { asUser, asRole, IDS, abortMessage, policiesOf } from './helpers/member-write-sweep.js'
import { mig, LOC_A, LOC_B, LOC_C, ORG1, signedOut, bootProd } from './helpers/contacts-resolvers-699-fixture.js'

const MIG_251 = mig('251_crossover_contact_ids_rpc.sql')
const MIG_699 = mig('699_org_admins_in_resolvers_uid_resolver_closed.sql')
const MIG_731 = mig('731_contacts_read_by_studio_membership.sql')
const MIG_732 = mig('732_contacts_read_by_studio_client.sql')
const MIG_758 = mig('758_glofox_crossover_members.sql')
const MIG_762 = mig('762_contacts_read_by_studio_deal.sql')
const MIG_764 = mig('764_contact_studios.sql')
const MIG_765 = mig('765_contacts_read_by_contact_studios.sql')

const QUAL_731 = '((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))'
const QUAL_765 = '((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_studio_contact_ids() AS auth_contact_studio_contact_ids)::uuid[])))'
const OLD_HELPER = 'private.auth_contact_membership_contact_ids()'
const NEW_HELPER = 'private.auth_contact_studio_contact_ids()'
const CROSS = 'public.crossover_contact_ids(uuid)'
const MD5_762_HELPER = '65daa4835035bf30cad782fdd7bc6e4e'
const MD5_758_CROSS = 'b9489caf0954b06c3102d802133013e8'
const MD5_765_STUDIO = 'c4464ab057b9a175dc94037ced7e39b5'
const MD5_765_DELEGATE = '8bc82349c4385c345d30f37f9599634b'
const MD5_765_CROSS = 'bc2fe2d317a3240b98862c34dbfbd5b7'
const md5Of = async (db, fn) => (await db.query(`SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g')) AS h
  FROM pg_proc WHERE oid = to_regprocedure($1)`, [fn])).rows[0]?.h

const section = (sql, from, to) => {
  const i = sql.indexOf(from)
  const j = sql.indexOf(to, i)
  if (i < 0 || j < 0) throw new Error(`section not found: ${from}`)
  return sql.slice(i, j + to.length)
}
// The rollback record in 765's header.
const ROLLBACK_765 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
${section(MIG_762, 'CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids()',
    'GRANT EXECUTE ON FUNCTION private.auth_contact_membership_contact_ids() TO authenticated, service_role;')}
ALTER POLICY contacts_select ON public.contacts USING (
  location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
  OR user_id = (SELECT auth.uid())
  OR id = ANY ((SELECT private.auth_contact_membership_contact_ids())::uuid[]));
${section(MIG_758, 'CREATE OR REPLACE FUNCTION public.crossover_contact_ids(loc uuid)',
    'GRANT EXECUTE ON FUNCTION public.crossover_contact_ids(uuid) TO service_role;')}
DROP VIEW public.studio_contacts;
DROP FUNCTION private.auth_contact_studio_contact_ids();
COMMIT;
`

const C_A = IDS.C_MEMBER        // lives at A: a deal at B
const C_A2 = IDS.C_MEMBER2      // lives at A: a Glofox crossover member at B
const C_B = IDS.C_B             // lives at B
const C_C1 = '30000000-0000-0000-0000-0000000000c1'   // lives at C (ORG1, inactive): active member at B
const C_D1 = '30000000-0000-0000-0000-0000000000d1'   // moved to C below: un1t client at B
const C_C2 = '30000000-0000-0000-0000-0000000000c2'   // lives at C: a relationship at C only
const C_C3 = '30000000-0000-0000-0000-0000000000c3'   // lives at C: an ENDED relationship at B
const ORG_ROW = 'f0000000-0000-0000-0000-000000000001'

// 731 + 732 + 758's fixture (as the 762 test builds it) with the ORG2 contact
// moved into ORG1 (mig 764 refuses a cross-organisation pair, rightly), plus
// what mig 764 reads: organisations, the contacts and locations columns, the
// deal/pipeline columns, un1t_subscriptions, class_bookings, the WhatsApp
// thread columns and cron_heartbeats.
const BEFORE2 = `
  CREATE TABLE IF NOT EXISTS public.organizations (id uuid PRIMARY KEY);
  INSERT INTO public.organizations VALUES ('${ORG1}'), ('f0000000-0000-0000-0000-000000000002') ON CONFLICT DO NOTHING;
  ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS is_host_anchor boolean NOT NULL DEFAULT false;
  ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS membership_source text;
  ALTER TABLE public.contacts ADD COLUMN organization_id uuid, ADD COLUMN glofox_member_id text, ADD COLUMN glofox_membership_status text,
    ADD COLUMN glofox_membership_state text, ADD COLUMN created_via_import_id uuid, ADD COLUMN last_attended_at timestamptz,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  INSERT INTO public.contacts (id, location_id, user_id) VALUES
    ('${C_C2}', '${LOC_C}', NULL), ('${C_C3}', '${LOC_C}', NULL) ON CONFLICT (id) DO NOTHING;
  UPDATE public.contacts SET location_id = '${LOC_C}' WHERE id = '${C_D1}';
  UPDATE public.contacts c SET organization_id = l.organization_id FROM public.locations l WHERE l.id = c.location_id;
  ALTER TABLE public.deals ADD COLUMN contact_id uuid, ADD COLUMN stage_id uuid, ADD COLUMN status text DEFAULT 'open',
    ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN updated_at timestamptz DEFAULT now();
  CREATE TABLE public.pipelines (id uuid PRIMARY KEY, location_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT true, is_primary boolean NOT NULL DEFAULT false);
  CREATE TABLE public.pipeline_stages (id uuid PRIMARY KEY, pipeline_id uuid NOT NULL, slug text NOT NULL);
  CREATE TABLE public.contact_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL,
    contact_id uuid NOT NULL, source text NOT NULL, plan_name text NOT NULL DEFAULT 'Plan',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz);
  ALTER TABLE public.contact_memberships ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.contact_memberships FROM anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_memberships TO service_role;
  ${MIG_251}
  INSERT INTO public.contact_memberships (organization_id, location_id, contact_id, source, status) VALUES
    ('${ORG1}', '${LOC_B}', '${C_C1}', 'un1t_online_api', 'active'),
    ('${ORG1}', '${LOC_A}', '${C_D1}', 'un1t_online_export', 'active');
  INSERT INTO public.deals (location_id, contact_id) VALUES ('${LOC_B}', '${C_A}');
  CREATE TABLE public.un1t_clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, un1t_user_id text NOT NULL,
    contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL, status text, credit_balance integer, credit_unlimited boolean,
    remote_created_at timestamptz, synced_at timestamptz NOT NULL DEFAULT now(), UNIQUE (location_id, un1t_user_id));
  ALTER TABLE public.un1t_clients ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.un1t_clients FROM anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_clients TO service_role;
  INSERT INTO public.un1t_clients (location_id, un1t_user_id, contact_id, status) VALUES ('${LOC_B}', 'u-b-1', '${C_D1}', 'inactive');
  CREATE TABLE public.un1t_subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, un1t_id text NOT NULL,
    un1t_user_id text, contact_id uuid, status text, UNIQUE (location_id, un1t_id));
  CREATE TABLE public.contact_location_preferences (contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    location_id uuid NOT NULL, email_marketing boolean NOT NULL DEFAULT true, subscribed_at timestamptz NOT NULL DEFAULT now(),
    source text NOT NULL, PRIMARY KEY (contact_id, location_id));
  CREATE TABLE public.class_bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, contact_id uuid, starts_at timestamptz);
  ALTER TABLE public.whatsapp_conversations ADD COLUMN contact_id uuid;
  ALTER TABLE public.whatsapp_messages ADD COLUMN conversation_id uuid, ADD COLUMN direction text, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  CREATE TABLE public.cron_heartbeats (name text PRIMARY KEY, expected_interval_seconds integer NOT NULL, grace_seconds integer NOT NULL DEFAULT 60,
    last_ok_at timestamptz, notes text);
`
// Rows the Glofox sync would write once 758 exists (B's crossover member).
const GLOFOX_ROWS = `
  INSERT INTO public.glofox_crossover_members (location_id, glofox_member_id, contact_id) VALUES ('${LOC_B}', 'gf-b-1', '${C_A2}');
`
// After 764's backfill: an ENDED relationship at B for C_C3 (decision 2: still visible).
const ENDED_ROW = `
  INSERT INTO public.contact_studios (contact_id, location_id, organization_id, kind, status, source, ended_at)
  VALUES ('${C_C3}', '${LOC_B}', '${ORG1}', 'lead', 'ended', 'deal', now());
`

const boot = async (migrate, { withEnded = true } = {}) => {
  const db = await bootProd({ before2: BEFORE2, migrate: migrate.slice(0, 4) })
  await db['exec'](GLOFOX_ROWS)
  for (const sql of migrate.slice(4)) { await signedOut(db); await db['exec'](sql) }
  if (withEnded && migrate.includes(MIG_764)) await db['exec'](ENDED_ROW)
  return db
}
const PRE = [MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764]
const boot765 = () => boot([...PRE, MIG_765])
const count = async (db, uid) => (await asUser(db, uid, 'SELECT count(*)::int AS n FROM public.contacts'))[0].n
const sees = async (db, uid, id) => (await asUser(db, uid, `SELECT count(*)::int AS n FROM public.contacts WHERE id = '${id}'`))[0].n === 1

describe('before 765: prod with 690 … 764 applied', () => {
  let db
  beforeAll(async () => { db = await boot(PRE) }, 90_000)
  afterAll(() => db?.close())

  it("the helper is 762's; an ENDED relationship at B is invisible to STAFF_B", async () => {
    expect(await md5Of(db, OLD_HELPER)).toBe(MD5_762_HELPER)
    expect(await sees(db, IDS.STAFF_B, C_C3)).toBe(false)
    expect(await count(db, IDS.STAFF_B)).toBe(5)   // C_B, C_C1 (member), C_D1 (un1t client), C_A2 (Glofox), C_A (deal)
  })
})

describe('after 765', () => {
  let db
  beforeAll(async () => { db = await boot765() }, 90_000)
  afterAll(() => db?.close())

  it('STAFF_B sees every contact with a contact_studios row at B, the ENDED one included; count is 6', async () => {
    for (const id of [C_B, C_C1, C_D1, C_A2, C_A, C_C3]) expect(await sees(db, IDS.STAFF_B, id), id).toBe(true)
    expect(await count(db, IDS.STAFF_B)).toBe(6)
  })

  it('a contact whose only relationship is at C (where nobody here holds Contacts) is invisible', async () => {
    expect(await sees(db, IDS.STAFF_B, C_C2)).toBe(false)
    expect(await sees(db, IDS.STAFF_A, C_C2)).toBe(false)
  })

  it('no Contacts at B: not readable (override, deactivated profile)', async () => {
    await db.query(`UPDATE public.profile_locations SET permissions = '{"contacts": false, "mobile": {"contacts": false}}'
      WHERE profile_id = $1 AND location_id = $2`, [IDS.STAFF_B, LOC_B])
    expect(await sees(db, IDS.STAFF_B, C_C3)).toBe(false)
    await db.query(`UPDATE public.profile_locations SET permissions = '{}' WHERE profile_id = $1`, [IDS.STAFF_B])
    await db.query(`UPDATE public.profiles SET active = false WHERE id = $1`, [IDS.STAFF_B])
    expect(await sees(db, IDS.STAFF_B, C_C3)).toBe(false)
    await db.query(`UPDATE public.profiles SET active = true WHERE id = $1`, [IDS.STAFF_B])
    expect(await sees(db, IDS.STAFF_B, C_C3)).toBe(true)
  })

  it('members see their own row only; the view and the table stay closed to every client session', async () => {
    expect(await count(db, IDS.MEMBER_UID)).toBe(1)
    for (const sql of ['SELECT id FROM public.studio_contacts', 'SELECT contact_id FROM public.contact_studios']) {
      await expect(asUser(db, IDS.STAFF_B, sql)).rejects.toThrow(/permission denied/)
      await expect(asRole(db, 'anon', sql)).rejects.toThrow(/permission denied/)
    }
  })

  it('studio_contacts: one row per relationship, security_invoker, studio_is_crossover = primary elsewhere', async () => {
    const rows = await asRole(db, 'service_role', `SELECT id, studio_location_id, studio_kind, studio_status, studio_is_crossover
      FROM public.studio_contacts WHERE studio_location_id = '${LOC_B}' ORDER BY id`)
    expect(rows.map((r) => r.id).sort()).toEqual([C_A, C_A2, C_B, C_C1, C_C3, C_D1].sort())
    expect(rows.find((r) => r.id === C_B).studio_is_crossover).toBe(false)
    expect(rows.find((r) => r.id === C_A).studio_is_crossover).toBe(true)
    expect(rows.find((r) => r.id === C_C3)).toMatchObject({ studio_status: 'ended', studio_kind: 'lead' })
    const { rows: [v] } = await db.query(`SELECT array_to_string(reloptions, ',') AS o FROM pg_class WHERE oid = 'public.studio_contacts'::regclass`)
    expect(v.o).toMatch(/security_invoker=on/)
  })

  it('the helpers: 765 bodies, DEFINER, STABLE, search_path pinned; authenticated + service_role only; the old one delegates', async () => {
    expect(await md5Of(db, NEW_HELPER)).toBe(MD5_765_STUDIO)
    expect(await md5Of(db, OLD_HELPER)).toBe(MD5_765_DELEGATE)
    for (const fn of [NEW_HELPER, OLD_HELPER]) {
      const { rows: [r] } = await db.query(`SELECT prosecdef d, provolatile v, proconfig c,
          has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') a,
          has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') n
        FROM pg_proc WHERE oid = to_regprocedure($1)`, [fn])
      expect(r, fn).toEqual({ d: true, v: 's', c: ['search_path=""'], a: true, n: false })
    }
  })

  it('crossover_contact_ids reads contact_studios (primary elsewhere), service_role only', async () => {
    expect(await md5Of(db, CROSS)).toBe(MD5_765_CROSS)
    const ids = (await asRole(db, 'service_role', `SELECT contact_id::text AS id FROM public.crossover_contact_ids('${LOC_B}') ORDER BY 1`)).map((r) => r.id)
    expect(ids).toEqual([C_A, C_A2, C_C1, C_C3, C_D1].sort())
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(db, role, `SELECT * FROM public.crossover_contact_ids('${LOC_B}')`)).rejects.toThrow(/permission denied for function crossover_contact_ids/)
    }
  })

  it('the new helper is an InitPlan, run once per statement, never a per-row SubPlan', async () => {
    const rows = await asUser(db, IDS.STAFF_B, 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) SELECT id FROM public.contacts')
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(plan).not.toMatch(/SubPlan/)
    const ids = plan.match(/\bid = ANY \(\(InitPlan (\d+)\)\.col1\)/)?.[1]
    expect(ids, plan).toBeTruthy()
    const lines = plan.split('\n')
    const i = lines.findIndex((l) => l.trim() === `InitPlan ${ids}`)
    expect(lines[i + 1], plan).toMatch(/\bloops=1\b/)
  })

  it("the policy is this file's", async () => {
    expect(await policiesOf(db, ['contacts'])).toEqual([{ tablename: 'contacts', policyname: 'contacts_select', permissive: 'PERMISSIVE',
      cmd: 'SELECT', roles: '{public}', qual: QUAL_765, with_check: null }])
  })

  it('a second run passes and changes nothing', async () => {
    await signedOut(db)
    await expect(db['exec'](MIG_765)).resolves.toBeDefined()
    expect(await md5Of(db, NEW_HELPER)).toBe(MD5_765_STUDIO)
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(QUAL_765)
    expect(await count(db, IDS.STAFF_B)).toBe(6)
  })
})

describe('the file aborts as a whole', () => {
  let db
  afterEach(async () => { await db?.close() })
  const noView = async () => expect((await db.query(`SELECT to_regclass('public.studio_contacts') AS t`)).rows[0].t).toBeNull()

  it('when 764 was never applied', async () => {
    db = await boot(PRE.slice(0, 5))
    await signedOut(db)
    expect(await abortMessage(db, MIG_765)).toMatch(/mig 765: public\.contact_studios is missing/)
    await noView()
  }, 90_000)

  it('when the old helper was edited by hand', async () => {
    db = await boot(PRE)
    await db['exec'](`CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids() RETURNS uuid[]
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $f$ SELECT '{}'::uuid[] $f$;`)
    await signedOut(db)
    expect(await abortMessage(db, MIG_765)).toMatch(/mig 765: private\.auth_contact_membership_contact_ids\(\) is not the mig 762 body/)
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(QUAL_731)
    await noView()
  }, 90_000)

  it('when contacts_select was changed by hand', async () => {
    db = await boot(PRE)
    await db['exec'](`ALTER POLICY contacts_select ON public.contacts USING (true);`)
    await signedOut(db)
    expect(await abortMessage(db, MIG_765)).toMatch(/mig 765: public\.contacts does not have exactly the mig 731/)
    await noView()
  }, 90_000)
})

describe('the file carries no placeholder', () => {
  it('ends with the self-check and COMMIT and carries no unfilled md5', () => {
    expect(MIG_765).toMatch(/END \$\$;\s*COMMIT;\s*$/)
    expect(MIG_765).not.toMatch(/@@/)
    for (const h of [MD5_765_STUDIO, MD5_765_DELEGATE, MD5_765_CROSS]) expect(h).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe("the header's rollback record", () => {
  let db
  afterAll(() => db?.close())

  it("restores 762's helper, 731's policy and 758's RPC, drops the view; 765 applies again", async () => {
    db = await boot765()
    await db['exec'](ROLLBACK_765)
    expect(await md5Of(db, OLD_HELPER)).toBe(MD5_762_HELPER)
    expect(await md5Of(db, CROSS)).toBe(MD5_758_CROSS)
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(QUAL_731)
    expect((await db.query(`SELECT to_regclass('public.studio_contacts') AS t`)).rows[0].t).toBeNull()
    expect(await sees(db, IDS.STAFF_B, C_C3)).toBe(false)
    expect(await sees(db, IDS.STAFF_B, C_A)).toBe(true)   // 762's deal branch
    await signedOut(db)
    await db['exec'](MIG_765)
    expect(await sees(db, IDS.STAFF_B, C_C3)).toBe(true)
  }, 90_000)
})
