// ORGCONTACTS.1 — behavioural test for migration 764: contact_studios, the one
// table that answers "which studios is this person at" (spec §2.1), its three
// triggers, derive_contact_studio / reconcile_contact_studios, the backfill
// and the nightly reconcile's heartbeat row.
//
// Loads the live shapes of every table the migration reads (as their own
// migrations left them) into PGlite, then the REAL 764 file. The default
// privileges mimic a database BEFORE mig 667/677/678, so a closed grant in the
// result is the migration's own REVOKE, not the sandbox. Fictional ids only:
// the repo is public.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { MEMBERSHIP_ACTIVE_STATUSES } from '../src/lib/un1t-online-map.js'

const MIG_764 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/764_contact_studios.sql'), 'utf8')

const ORG = 'd0000000-0000-0000-0000-000000000001'
const ORG2 = 'd0000000-0000-0000-0000-000000000002'
const STILL = 'a0000000-0000-0000-0000-000000000001'   // Glofox studio
const HATCH = 'a0000000-0000-0000-0000-000000000002'   // un1t.online studio
const DEAD = 'a0000000-0000-0000-0000-000000000003'    // inactive studio, ORG
const OTHER = 'a0000000-0000-0000-0000-000000000004'   // ORG2
const C_GLOFOX = 'c0000000-0000-0000-0000-000000000001'  // Stillorgan Glofox member
const C_UN1T = 'c0000000-0000-0000-0000-000000000002'    // Hatch un1t client, lapsed
const C_DEAL = 'c0000000-0000-0000-0000-000000000003'    // Stillorgan contact with a Hatch deal
const C_PREFS = 'c0000000-0000-0000-0000-000000000004'   // Stillorgan contact on Hatch's list only
const C_CROSS = 'c0000000-0000-0000-0000-000000000005'   // Hatch contact, Glofox member at Stillorgan (crossover)
const C_NOHOME = 'c0000000-0000-0000-0000-000000000006'  // NULL location_id
const C_OTHER = 'c0000000-0000-0000-0000-000000000007'   // ORG2 contact
const P_STILL = 'e0000000-0000-0000-0000-000000000001'
const P_HATCH = 'e0000000-0000-0000-0000-000000000002'
const S_STILL_LEAD = 'e0000000-0000-0000-0000-000000000011'
const S_HATCH_WAIT = 'e0000000-0000-0000-0000-000000000012'
const S_HATCH_TRIAL = 'e0000000-0000-0000-0000-000000000013'
const D_HATCH = 'f0000000-0000-0000-0000-000000000001'
const WA_CONV = 'f0000000-0000-0000-0000-000000000010'

const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA private;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
  CREATE TABLE public.organizations (id uuid PRIMARY KEY);
  CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id),
    active boolean NOT NULL DEFAULT true, is_host_anchor boolean NOT NULL DEFAULT false, membership_source text);
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, location_id uuid REFERENCES public.locations(id), organization_id uuid,
    glofox_member_id text, glofox_membership_status text, glofox_membership_state text, created_via_import_id uuid,
    last_attended_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), pipeline_stage_slug text);
  CREATE TABLE public.pipelines (id uuid PRIMARY KEY, location_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT true, is_primary boolean NOT NULL DEFAULT false);
  CREATE TABLE public.pipeline_stages (id uuid PRIMARY KEY, pipeline_id uuid NOT NULL REFERENCES public.pipelines(id), slug text NOT NULL);
  CREATE TABLE public.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
    location_id uuid, stage_id uuid REFERENCES public.pipeline_stages(id), status text DEFAULT 'open',
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE public.contact_memberships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL,
    contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE, source text NOT NULL, plan_name text NOT NULL DEFAULT 'Plan',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')), first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz);
  CREATE TABLE public.un1t_clients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, un1t_user_id text NOT NULL,
    contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL, status text, credit_balance integer, credit_unlimited boolean,
    last_attended_at timestamptz, remote_created_at timestamptz, synced_at timestamptz NOT NULL DEFAULT now(), UNIQUE (location_id, un1t_user_id));
  CREATE TABLE public.un1t_subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, un1t_id text NOT NULL,
    un1t_user_id text, contact_id uuid, status text, UNIQUE (location_id, un1t_id));
  CREATE TABLE public.glofox_crossover_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, glofox_member_id text NOT NULL,
    contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, glofox_member_id));
  CREATE TABLE public.contact_location_preferences (contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES public.locations(id), email_marketing boolean NOT NULL DEFAULT true,
    subscribed_at timestamptz NOT NULL DEFAULT now(), source text NOT NULL, PRIMARY KEY (contact_id, location_id));
  CREATE TABLE public.class_bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, contact_id uuid,
    starts_at timestamptz, attended boolean NOT NULL DEFAULT false, status text);
  CREATE TABLE public.whatsapp_conversations (id uuid PRIMARY KEY, location_id uuid NOT NULL, contact_id uuid);
  CREATE TABLE public.whatsapp_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id),
    direction text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.cron_heartbeats (name text PRIMARY KEY, expected_interval_seconds integer NOT NULL, grace_seconds integer NOT NULL DEFAULT 60,
    last_ok_at timestamptz, notes text);

  INSERT INTO public.organizations VALUES ('${ORG}'), ('${ORG2}');
  INSERT INTO public.locations (id, organization_id, active, membership_source) VALUES
    ('${STILL}', '${ORG}', true, 'glofox'), ('${HATCH}', '${ORG}', true, 'un1t_online'), ('${DEAD}', '${ORG}', false, 'none'), ('${OTHER}', '${ORG2}', true, 'none');
  INSERT INTO public.pipelines (id, location_id, enabled, is_primary) VALUES ('${P_STILL}', '${STILL}', true, true), ('${P_HATCH}', '${HATCH}', true, true);
  INSERT INTO public.pipeline_stages (id, pipeline_id, slug) VALUES
    ('${S_STILL_LEAD}', '${P_STILL}', 'new_lead'), ('${S_HATCH_WAIT}', '${P_HATCH}', 'waitlist'), ('${S_HATCH_TRIAL}', '${P_HATCH}', 'trial_done');

  INSERT INTO public.contacts (id, location_id, organization_id, glofox_member_id, glofox_membership_status, glofox_membership_state, created_at, last_attended_at) VALUES
    ('${C_GLOFOX}', '${STILL}', '${ORG}', 'gf-1', 'member', 'active', '2026-01-01', '2026-10-01'),
    ('${C_UN1T}', '${HATCH}', '${ORG}', NULL, NULL, NULL, '2026-02-01', NULL),
    ('${C_DEAL}', '${STILL}', '${ORG}', NULL, 'lead', NULL, '2026-03-01', NULL),
    ('${C_PREFS}', '${STILL}', '${ORG}', NULL, NULL, NULL, '2026-04-01', NULL),
    ('${C_CROSS}', '${HATCH}', '${ORG}', 'gf-5', 'member', 'active', '2026-05-01', NULL),
    ('${C_NOHOME}', NULL, NULL, NULL, NULL, NULL, '2026-06-01', NULL),
    ('${C_OTHER}', '${OTHER}', '${ORG2}', NULL, NULL, NULL, '2026-07-01', NULL);
  INSERT INTO public.un1t_clients (location_id, un1t_user_id, contact_id, status, credit_balance, credit_unlimited, remote_created_at) VALUES
    ('${HATCH}', 'u-2', '${C_UN1T}', 'inactive', 0, false, '2026-02-02');
  INSERT INTO public.deals (id, contact_id, location_id, stage_id, status, created_at, updated_at) VALUES
    ('${D_HATCH}', '${C_DEAL}', '${HATCH}', '${S_HATCH_WAIT}', 'open', '2026-03-05', '2026-03-06');
  INSERT INTO public.contact_location_preferences (contact_id, location_id, source, subscribed_at) VALUES
    ('${C_PREFS}', '${HATCH}', 'waitlist_form', '2026-04-04'),
    ('${C_GLOFOX}', '${STILL}', 'system', '2026-01-01');
  INSERT INTO public.glofox_crossover_members (location_id, glofox_member_id, contact_id, created_at) VALUES ('${STILL}', 'gf-5', '${C_CROSS}', '2026-05-05');
  INSERT INTO public.whatsapp_conversations (id, location_id, contact_id) VALUES ('${WA_CONV}', '${HATCH}', '${C_DEAL}');
  INSERT INTO public.whatsapp_messages (conversation_id, direction, created_at) VALUES ('${WA_CONV}', 'inbound', '2026-03-20');
`
const boot = async ({ before = '', apply = true } = {}) => {
  const db = new PGlite()
  await db.exec(SCHEMA)
  if (before) await db.exec(before)
  if (apply) await db.exec(MIG_764)
  return db
}
const rows = async (db, sql, params) => (await db.query(sql, params)).rows
const one = async (db, sql, params) => (await rows(db, sql, params))[0]
const row = (db, contact, loc) => one(db, `SELECT kind, status, source, stage_slug, first_seen_at::text AS first, last_seen_at::text AS last, ended_at IS NOT NULL AS ended, organization_id
  FROM public.contact_studios WHERE contact_id = $1 AND location_id = $2`, [contact, loc])
const reconcile = (db, loc = null) => one(db, `SELECT * FROM public.reconcile_contact_studios($1)`, [loc])
const asRole = async (db, role, sql) => {
  await db.exec(`SET ROLE ${role}`)
  try { return await db.query(sql) } finally { await db.exec('RESET ROLE') }
}

describe('764 contact_studios', () => {
  let db
  beforeAll(async () => { db = await boot() }, 60_000)
  afterAll(() => db?.close())

  it('backfill: one row per (contact, studio) in the union of the sources; the NULL-home contact is skipped and counted', async () => {
    const pairs = await rows(db, `SELECT contact_id, location_id FROM public.contact_studios ORDER BY 1, 2`)
    expect(pairs).toEqual([
      { contact_id: C_GLOFOX, location_id: STILL },
      { contact_id: C_UN1T, location_id: HATCH },
      { contact_id: C_DEAL, location_id: STILL }, { contact_id: C_DEAL, location_id: HATCH },
      { contact_id: C_PREFS, location_id: STILL }, { contact_id: C_PREFS, location_id: HATCH },
      { contact_id: C_CROSS, location_id: STILL }, { contact_id: C_CROSS, location_id: HATCH },
      { contact_id: C_OTHER, location_id: OTHER },
    ].sort((a, b) => a.contact_id.localeCompare(b.contact_id) || a.location_id.localeCompare(b.location_id)))
    expect(await rows(db, `SELECT 1 FROM public.contact_studios WHERE contact_id = $1`, [C_NOHOME])).toEqual([])
  })

  it('kind: member > client > lead; status and source per the lifecycle rules', async () => {
    expect(await row(db, C_GLOFOX, STILL)).toMatchObject({ kind: 'member', status: 'active', source: 'glofox', ended: false, organization_id: ORG })
    expect(await row(db, C_UN1T, HATCH)).toMatchObject({ kind: 'client', status: 'active', source: 'un1t_online', ended: false })
    expect(await row(db, C_DEAL, HATCH)).toMatchObject({ kind: 'lead', status: 'active', source: 'deal', stage_slug: 'waitlist' })
    expect(await row(db, C_DEAL, STILL)).toMatchObject({ kind: 'lead', status: 'active', source: 'manual', stage_slug: null })
    expect(await row(db, C_PREFS, HATCH)).toMatchObject({ kind: 'lead', status: 'active', source: 'lead_form', stage_slug: null })
    expect(await row(db, C_CROSS, STILL)).toMatchObject({ kind: 'member', status: 'active', source: 'glofox' })
    expect(await row(db, C_CROSS, HATCH)).toMatchObject({ kind: 'lead', status: 'active', source: 'manual' })
  })

  it('first_seen_at is the earliest source stamp; last_seen_at is activity (a deal touch, a message), never a sync stamp', async () => {
    expect((await row(db, C_DEAL, HATCH)).first).toMatch(/^2026-03-05/)
    expect((await row(db, C_DEAL, HATCH)).last).toMatch(/^2026-03-20/)   // the WhatsApp message beats the deal touch
    expect((await row(db, C_GLOFOX, STILL)).first).toMatch(/^2026-01-01/)
    expect((await row(db, C_GLOFOX, STILL)).last).toMatch(/^2026-10-01/) // contacts.last_attended_at at the primary studio
    expect((await row(db, C_PREFS, HATCH)).first).toMatch(/^2026-04-04/)
    expect((await row(db, C_PREFS, HATCH)).last).toBeNull()
  })

  it('status ends when the last open deal closes and nothing else holds, and comes back on re-open; kind moves down and up', async () => {
    await db.query(`UPDATE public.deals SET status = 'lost' WHERE id = $1`, [D_HATCH])
    // the preferences-less, deal-only relationship at Hatch ends; the WhatsApp thread is not a relationship
    expect(await row(db, C_DEAL, HATCH)).toMatchObject({ status: 'ended', ended: true, kind: 'lead' })
    await db.query(`UPDATE public.deals SET status = 'open' WHERE id = $1`, [D_HATCH])
    expect(await row(db, C_DEAL, HATCH)).toMatchObject({ status: 'active', ended: false })
    // a membership ending demotes member → client while the client row stays; a reconcile agrees
    await db.query(`UPDATE public.contacts SET glofox_membership_status = 'ex_member' WHERE id = $1`, [C_GLOFOX])
    await reconcile(db, STILL)
    expect(await row(db, C_GLOFOX, STILL)).toMatchObject({ kind: 'client', status: 'active' })
    await db.query(`UPDATE public.contacts SET glofox_membership_status = 'member' WHERE id = $1`, [C_GLOFOX])
    await reconcile(db, STILL)
    expect(await row(db, C_GLOFOX, STILL)).toMatchObject({ kind: 'member', status: 'active' })
  })

  it('a deal touch stamps last_seen_at forward; a reconcile never moves first_seen_at later or last_seen_at earlier', async () => {
    await db.query(`UPDATE public.deals SET updated_at = '2026-10-10' WHERE id = $1`, [D_HATCH])
    expect((await row(db, C_DEAL, HATCH)).last).toMatch(/^2026-10-10/)
    await db.query(`UPDATE public.contact_studios SET first_seen_at = '2025-01-01', last_seen_at = '2027-01-01' WHERE contact_id = $1 AND location_id = $2`, [C_DEAL, HATCH])
    await reconcile(db, HATCH)
    expect((await row(db, C_DEAL, HATCH)).first).toMatch(/^2025-01-01/)
    expect((await row(db, C_DEAL, HATCH)).last).toMatch(/^2027-01-01/)
    await db.query(`UPDATE public.contact_studios SET last_seen_at = '2026-03-20' WHERE contact_id = $1 AND location_id = $2`, [C_DEAL, HATCH])
  })

  it('a deal moved to another board: the old studio row is re-derived and the new studio gains a row (Review Focus 5)', async () => {
    const dealId = (await one(db, `INSERT INTO public.deals (contact_id, location_id, stage_id, status) VALUES ($1, $2, $3, 'open') RETURNING id`, [C_UN1T, STILL, S_STILL_LEAD])).id
    expect(await row(db, C_UN1T, STILL)).toMatchObject({ kind: 'lead', status: 'active', source: 'deal', stage_slug: 'new_lead' })
    await db.query(`UPDATE public.deals SET location_id = $2, stage_id = $3 WHERE id = $1`, [dealId, HATCH, S_HATCH_TRIAL])
    expect(await row(db, C_UN1T, STILL)).toMatchObject({ status: 'ended', ended: true })
    expect(await row(db, C_UN1T, HATCH)).toMatchObject({ kind: 'client', status: 'active', stage_slug: 'trial_done' })
    await db.query(`DELETE FROM public.deals WHERE id = $1`, [dealId])
    expect(await row(db, C_UN1T, HATCH)).toMatchObject({ kind: 'client', stage_slug: null })
  })

  it('a preferences row creates a lead row at that studio; a contact insert creates the primary row', async () => {
    await db.query(`INSERT INTO public.contact_location_preferences (contact_id, location_id, source) VALUES ($1, $2, 'lead_form')`, [C_UN1T, STILL])
    expect(await row(db, C_UN1T, STILL)).toMatchObject({ kind: 'lead', status: 'active', source: 'lead_form' })
    const fresh = 'c0000000-0000-0000-0000-0000000000f1'
    await db.query(`INSERT INTO public.contacts (id, location_id, organization_id) VALUES ($1, $2, $3)`, [fresh, HATCH, ORG])
    expect(await row(db, fresh, HATCH)).toMatchObject({ kind: 'lead', status: 'active', source: 'manual' })
  })

  it('a pair across organisations raises 23514 and the statement rolls back; contact_id / location_id never change', async () => {
    await expect(db.query(`INSERT INTO public.contact_studios (contact_id, location_id, kind, status, source) VALUES ($1, $2, 'lead', 'active', 'manual')`, [C_GLOFOX, OTHER]))
      .rejects.toThrow(/different organisations/)
    await expect(db.query(`UPDATE public.contact_studios SET location_id = $2 WHERE contact_id = $1 AND location_id = $3`, [C_GLOFOX, HATCH, STILL]))
      .rejects.toThrow(/never moves/)
    expect(await rows(db, `SELECT 1 FROM public.contact_studios WHERE location_id = $1 AND contact_id = $2`, [OTHER, C_GLOFOX])).toEqual([])
  })

  it('rows are never deleted by a reconcile; a vanished relationship ends', async () => {
    await db.query(`DELETE FROM public.contact_location_preferences WHERE contact_id = $1 AND location_id = $2`, [C_PREFS, HATCH])
    const r = await reconcile(db, HATCH)
    expect(r.ended).toBeGreaterThanOrEqual(1)
    expect(await row(db, C_PREFS, HATCH)).toMatchObject({ status: 'ended', ended: true })
  })

  it('closed to every client session: RLS on, no policy, no privilege; the two public functions are service_role only; trigger functions closed', async () => {
    const { rows: [t] } = await db.query(`SELECT relrowsecurity rls, (SELECT count(*)::int FROM pg_policies WHERE tablename = 'contact_studios') policies,
        has_any_column_privilege('anon', 'public.contact_studios', 'SELECT') a_sel, has_any_column_privilege('authenticated', 'public.contact_studios', 'SELECT') u_sel,
        has_table_privilege('authenticated', 'public.contact_studios', 'INSERT') u_ins, has_table_privilege('service_role', 'public.contact_studios', 'INSERT') s_ins
      FROM pg_class WHERE oid = 'public.contact_studios'::regclass`)
    expect(t).toEqual({ rls: true, policies: 0, a_sel: false, u_sel: false, u_ins: false, s_ins: true })
    for (const fn of ['public.derive_contact_studio(uuid,uuid)', 'public.reconcile_contact_studios(uuid)']) {
      const { rows: [p] } = await db.query(`SELECT has_function_privilege('anon', $1, 'EXECUTE') a, has_function_privilege('authenticated', $1, 'EXECUTE') u,
        has_function_privilege('service_role', $1, 'EXECUTE') s`, [fn])
      expect(p, fn).toEqual({ a: false, u: false, s: true })
    }
    for (const fn of ['private.contact_studios_set_org()', 'private.contact_studios_freeze_keys()', 'private.contact_studios_from_contact()', 'private.contact_studios_from_deal()', 'private.contact_studios_from_preferences()']) {
      const { rows: [p] } = await db.query(`SELECT has_function_privilege('anon', $1, 'EXECUTE') a, has_function_privilege('authenticated', $1, 'EXECUTE') u`, [fn])
      expect(p, fn).toEqual({ a: false, u: false })
    }
    await expect(asRole(db, 'authenticated', 'SELECT 1 FROM public.contact_studios')).rejects.toThrow(/permission denied for table contact_studios/)
  })

  it('the inline list of live un1t subscription statuses equals MEMBERSHIP_ACTIVE_STATUSES', () => {
    const m = MIG_764.match(/us\.status\s+IN\s*\(([^)]*)\)/)
    expect(m, 'the subscription branch names its statuses inline').toBeTruthy()
    const inline = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort()
    expect(inline).toEqual([...MEMBERSHIP_ACTIVE_STATUSES].sort())
  })

  it('the heartbeat row exists: daily, two hours of grace', async () => {
    expect(await one(db, `SELECT expected_interval_seconds i, grace_seconds g FROM public.cron_heartbeats WHERE name = 'contact-studios-reconcile'`)).toEqual({ i: 86400, g: 7200 })
  })

  it('a second run is a no-op', async () => {
    const before = await rows(db, `SELECT contact_id, location_id, kind, status FROM public.contact_studios ORDER BY 1, 2`)
    await db.exec(MIG_764)
    expect(await rows(db, `SELECT contact_id, location_id, kind, status FROM public.contact_studios ORDER BY 1, 2`)).toEqual(before)
  })
})

describe('764 abort cases and file text', () => {
  it('aborts as a whole when a source table is missing', async () => {
    const db = new PGlite()
    await db.exec(SCHEMA)
    await db.exec('DROP TABLE public.glofox_crossover_members')
    await expect(db.exec(MIG_764)).rejects.toThrow(/mig 764/)
    await db.exec('ROLLBACK')
    expect((await db.query(`SELECT to_regclass('public.contact_studios') AS t`)).rows[0].t).toBeNull()
    await db.close()
  }, 60_000)

  it('ends with the self-check and COMMIT, states the client decision for the table, and carries no placeholder', () => {
    expect(MIG_764).toMatch(/END \$\$;\s*COMMIT;\s*$/)
    expect(MIG_764).toMatch(/REVOKE ALL ON public\.contact_studios FROM PUBLIC, anon, authenticated/)
    expect(MIG_764).not.toMatch(/@@/)
  })
})
