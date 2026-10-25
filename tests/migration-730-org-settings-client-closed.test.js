// ORGSETCLIENTWRITE.1 — behavioural test for migration 730.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17, prod is 17.6) with org_settings in
// PROD column order (17 Oct 2026) with its CHECKs and FKs, prod's ACL
// (authenticated arwd, service_role all, no anon: mig 677's posture), the
// four live policies verbatim, the touch_updated_at trigger, mig 729's
// customer_agent fence verbatim, and private.auth_is_master,
// auth_is_active_staff and auth_is_in_organization verbatim with their prod
// EXECUTE. locations, profiles, profile_locations and profile_organizations
// are reduced to what the policies and helpers read (profile_locations with
// the own-row read, which the write policies' inline EXISTS reads as the
// caller). It proves:
//
//   * BEFORE: an OWNER AT ONE STUDIO (not an organisation admin) lifts the
//     org's AI and email caps, rewrites the legal identity, the ops alert
//     recipients and the brand, deletes the row, and creates the row for an
//     org that has none; a plain staff member reads every column (ops alert
//     emails included); mig 729 already refuses a customer_agent change;
//   * AFTER: every read and write (and LOCK … ACCESS EXCLUSIVE, i.e.
//     MAINTAIN) refused for authenticated, masters included, and anon, by the
//     grant itself; no policy left; RLS on; both triggers kept; every
//     service-role path (org-branding and org-usage upserts, the usage-rollup
//     notice month, the Mia org route's customer_agent write, the org
//     delete cascade) still works and still touches updated_at;
//   * it runs on main's schema too (no customer_agent column, so no fence:
//     728/729 were unmerged when it was written);
//   * the self-check aborts the WHOLE file on another grantor's privilege
//     (table or column level), an inherited privilege, a policy the file does
//     not know, RLS off, and a missing or disabled 729 fence; a second run
//     passes; ROLLBACK_730 restores the before-state.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_730 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/730_org_settings_client_closed.sql'), 'utf8')

// The rollback record: the 17 Oct grant, the four policies (mig 320 with
// 626's active-staff gate, as pg_policies deparses them) and both comments.
const ROLLBACK_730 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_settings TO authenticated;
CREATE POLICY org_settings_select ON public.org_settings FOR SELECT TO authenticated
  USING (private.auth_is_master() OR (EXISTS ( SELECT 1
     FROM (public.locations l JOIN public.profile_locations pl ON ((pl.location_id = l.id)))
    WHERE ((l.organization_id = org_settings.organization_id) AND (pl.profile_id = ( SELECT auth.uid() AS uid)) AND (pl.role = 'owner'::text) AND ( SELECT private.auth_is_active_staff() AS auth_is_active_staff))))
    OR private.auth_is_in_organization(organization_id));
CREATE POLICY org_settings_ins ON public.org_settings FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_master() OR (EXISTS ( SELECT 1
     FROM (public.locations l JOIN public.profile_locations pl ON ((pl.location_id = l.id)))
    WHERE ((l.organization_id = org_settings.organization_id) AND (pl.profile_id = ( SELECT auth.uid() AS uid)) AND (pl.role = 'owner'::text) AND ( SELECT private.auth_is_active_staff() AS auth_is_active_staff)))));
CREATE POLICY org_settings_upd ON public.org_settings FOR UPDATE TO authenticated
  USING (private.auth_is_master() OR (EXISTS ( SELECT 1
     FROM (public.locations l JOIN public.profile_locations pl ON ((pl.location_id = l.id)))
    WHERE ((l.organization_id = org_settings.organization_id) AND (pl.profile_id = ( SELECT auth.uid() AS uid)) AND (pl.role = 'owner'::text) AND ( SELECT private.auth_is_active_staff() AS auth_is_active_staff)))))
  WITH CHECK (private.auth_is_master() OR (EXISTS ( SELECT 1
     FROM (public.locations l JOIN public.profile_locations pl ON ((pl.location_id = l.id)))
    WHERE ((l.organization_id = org_settings.organization_id) AND (pl.profile_id = ( SELECT auth.uid() AS uid)) AND (pl.role = 'owner'::text) AND ( SELECT private.auth_is_active_staff() AS auth_is_active_staff)))));
CREATE POLICY org_settings_del ON public.org_settings FOR DELETE TO authenticated
  USING (private.auth_is_master() OR (EXISTS ( SELECT 1
     FROM (public.locations l JOIN public.profile_locations pl ON ((pl.location_id = l.id)))
    WHERE ((l.organization_id = org_settings.organization_id) AND (pl.profile_id = ( SELECT auth.uid() AS uid)) AND (pl.role = 'owner'::text) AND ( SELECT private.auth_is_active_staff() AS auth_is_active_staff)))));
COMMENT ON TABLE public.org_settings IS ${pgText(TABLE_COMMENT_BEFORE())};
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.org_settings'::regclass AND attname = 'customer_agent' AND NOT attisdropped) THEN
    EXECUTE 'COMMENT ON COLUMN public.org_settings.customer_agent IS ' || quote_literal(${pgText(CA_COMMENT_BEFORE())});
  END IF;
END $$;
COMMIT;
`
function pgText(s) { return `'${s.replace(/'/g, "''")}'` }
function TABLE_COMMENT_BEFORE() {
  return 'Per-organisation branding defaults inherited by every location in the org that has not set its own (mig 317). Resolved by getLocationBranding per field: location company_settings -> org org_settings -> hard UN1T default. One row per organisation.'
}
function CA_COMMENT_BEFORE() {
  return 'MIAORG.1 (mig 729): organisation-level Mia defaults, same shape as locations.settings.customer_agent; studio-only keys are never read from here. NULL = none set. Readable by every org member through org_settings_select, so copy and tuning only, no secrets. Written only by the server (service_role): org_settings_customer_agent_fence refuses a client write.'
}

const ORG_1 = 'a1000000-0000-0000-0000-000000000001'   // two studios, one settings row
const ORG_2 = 'a2000000-0000-0000-0000-000000000002'   // one studio, no settings row
const LOC_A = 'b1000000-0000-0000-0000-00000000000a'
const LOC_B = 'b1000000-0000-0000-0000-00000000000b'
const LOC_X = 'b2000000-0000-0000-0000-00000000000c'
const OWNER_A = '10000000-0000-0000-0000-000000000001'  // owner at studio A only; not an org admin
const STAFF_B = '10000000-0000-0000-0000-000000000002'  // plain staff at studio B
const MASTER = '10000000-0000-0000-0000-000000000003'
const OWNER_X = '10000000-0000-0000-0000-000000000004'  // owner at org 2's one studio
const ORG_ADMIN = '10000000-0000-0000-0000-000000000005' // org admin of org 1 (profile_organizations)

const OS = 'org_settings'
const ALL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
const POLICY_NAMES = ['org_settings_del', 'org_settings_ins', 'org_settings_select', 'org_settings_upd']
const denied = new RegExp(`permission denied for (table|relation) ${OS}\\b`)

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_grantor NOLOGIN;
  CREATE ROLE sneaky NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public, private TO anon, authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.organizations (id uuid PRIMARY KEY);
  CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid REFERENCES public.organizations(id));
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  CREATE TABLE public.profile_organizations (profile_id uuid, organization_id uuid, role text NOT NULL DEFAULT 'org_admin', PRIMARY KEY (profile_id, organization_id));
  -- Reduced client access: the write policies' inline EXISTS reads locations
  -- and profile_locations AS THE CALLER (prod: mig 648's column SELECT on
  -- locations, the own-row branch of profile_locations_read).
  REVOKE ALL ON public.organizations, public.locations, public.profiles, public.profile_locations, public.profile_organizations FROM anon, authenticated;
  GRANT SELECT ON public.locations, public.profile_locations TO authenticated;
  GRANT ALL ON public.organizations, public.locations, public.profiles, public.profile_locations, public.profile_organizations TO service_role;
  ALTER TABLE public.profile_locations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profile_locations_read ON public.profile_locations FOR SELECT TO authenticated
    USING (profile_id = (SELECT auth.uid()));

  -- org_settings: PROD column order, defaults, keys and CHECKs (pg_attribute/pg_constraint, 17 Oct 2026).
  CREATE TABLE public.org_settings (
    organization_id uuid NOT NULL CONSTRAINT org_settings_pkey PRIMARY KEY
      CONSTRAINT org_settings_organization_id_fkey REFERENCES public.organizations(id) ON DELETE CASCADE,
    logo_url text, favicon_url text, company_name text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid CONSTRAINT org_settings_updated_by_fkey REFERENCES public.profiles(id),
    ai_hard_cap_cents numeric CONSTRAINT org_settings_ai_hard_cap_cents_check CHECK ((ai_hard_cap_cents IS NULL) OR (ai_hard_cap_cents > (0)::numeric)),
    email_hard_cap_sends integer CONSTRAINT org_settings_email_hard_cap_sends_check CHECK ((email_hard_cap_sends IS NULL) OR (email_hard_cap_sends > 0)),
    ai_cap_notice_month text CONSTRAINT org_settings_ai_cap_notice_month_check CHECK ((ai_cap_notice_month IS NULL) OR (ai_cap_notice_month ~ '^\\d{4}-\\d{2}$'::text)),
    email_cap_notice_month text CONSTRAINT org_settings_email_cap_notice_month_check CHECK ((email_cap_notice_month IS NULL) OR (email_cap_notice_month ~ '^\\d{4}-\\d{2}$'::text)),
    ops_alert_emails text[],
    legal_entity_name text, legal_trading_name text, legal_address text, privacy_contact_email text,
    short_name text CONSTRAINT org_settings_short_name_check CHECK ((short_name IS NULL) OR ((length(short_name) >= 1) AND (length(short_name) <= 40)))
  );
  -- Prod ACL: {postgres=arwdDxtm, authenticated=arwd, service_role=arwdDxtm}; no anon.
  REVOKE ALL ON public.org_settings FROM anon, authenticated, PUBLIC;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_settings TO authenticated;
  GRANT ALL ON public.org_settings TO service_role;
  COMMENT ON TABLE public.org_settings IS ${pgText(TABLE_COMMENT_BEFORE())};

  -- touch_updated_at, verbatim (pg_proc, 17 Oct 2026).
  CREATE FUNCTION private.touch_org_settings_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
  BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER org_settings_touch_updated_at BEFORE UPDATE ON public.org_settings
    FOR EACH ROW EXECUTE FUNCTION private.touch_org_settings_updated_at();

  -- Helpers, verbatim (pg_proc, 17 Oct 2026), prod EXECUTE.
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = (SELECT auth.uid())
        AND role = 'master'
        AND active IS NOT FALSE
        AND deleted_at IS NULL
    )
  $$;
  CREATE FUNCTION private.auth_is_active_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = (SELECT auth.uid())
        AND active IS NOT FALSE
        AND deleted_at IS NULL
    )
  $$;
  CREATE FUNCTION private.auth_is_in_organization(org_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT org_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.active IS NOT FALSE
          AND p.deleted_at IS NULL
          AND (
            p.role = 'master'
            OR EXISTS (
              SELECT 1
                FROM public.locations l
                JOIN public.profile_locations pl ON pl.location_id = l.id
               WHERE l.organization_id = org_id
                 AND pl.profile_id = (SELECT auth.uid())
            )
            OR EXISTS (
              SELECT 1
                FROM public.profile_organizations po
               WHERE po.organization_id = org_id
                 AND po.profile_id = (SELECT auth.uid())
            )
          )
      )
  $$;
  REVOKE EXECUTE ON FUNCTION private.auth_is_master(), private.auth_is_active_staff(), private.auth_is_in_organization(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION private.auth_is_master(), private.auth_is_in_organization(uuid) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION private.auth_is_active_staff() TO authenticated;

  ALTER TABLE public.org_settings ENABLE ROW LEVEL SECURITY;
`

// Mig 729 (MIAORG.1), as applied on prod 17 Oct 08:28 UTC: the column, its
// comment, and the fence, verbatim.
const MIG_729 = `
  ALTER TABLE public.org_settings ADD COLUMN IF NOT EXISTS customer_agent jsonb;
  COMMENT ON COLUMN public.org_settings.customer_agent IS ${pgText(CA_COMMENT_BEFORE())};
  CREATE OR REPLACE FUNCTION private.org_settings_customer_agent_fence()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = ''
  AS $$
  BEGIN
    IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' AND NEW.customer_agent IS NOT NULL THEN
      RAISE EXCEPTION 'org_settings_customer_agent_fence: org_settings.customer_agent (Mia organisation defaults) is written only by the server; role % cannot set it', current_user
        USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.customer_agent IS DISTINCT FROM OLD.customer_agent THEN
      RAISE EXCEPTION 'org_settings_customer_agent_fence: org_settings.customer_agent (Mia organisation defaults) is written only by the server; role % cannot change it', current_user
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END;
  $$;
  REVOKE EXECUTE ON FUNCTION private.org_settings_customer_agent_fence() FROM PUBLIC, anon, authenticated;
  CREATE TRIGGER org_settings_customer_agent_fence
    BEFORE INSERT OR UPDATE ON public.org_settings
    FOR EACH ROW
    EXECUTE FUNCTION private.org_settings_customer_agent_fence();
`

// pg_policies on prod, 17 Oct 2026 (policyname → [cmd, roles, qual, with_check]), verbatim.
const OWNER_TEST = "(private.auth_is_master() OR (EXISTS ( SELECT 1\n   FROM (locations l\n     JOIN profile_locations pl ON ((pl.location_id = l.id)))\n  WHERE ((l.organization_id = org_settings.organization_id) AND (pl.profile_id = ( SELECT auth.uid() AS uid)) AND (pl.role = 'owner'::text) AND ( SELECT private.auth_is_active_staff() AS auth_is_active_staff)))))"
const PROD_TEXT = {
  org_settings_del: ['DELETE', '{authenticated}', OWNER_TEST, null],
  org_settings_ins: ['INSERT', '{authenticated}', null, OWNER_TEST],
  org_settings_select: ['SELECT', '{authenticated}', "(private.auth_is_master() OR (EXISTS ( SELECT 1\n   FROM (locations l\n     JOIN profile_locations pl ON ((pl.location_id = l.id)))\n  WHERE ((l.organization_id = org_settings.organization_id) AND (pl.profile_id = ( SELECT auth.uid() AS uid)) AND (pl.role = 'owner'::text) AND ( SELECT private.auth_is_active_staff() AS auth_is_active_staff)))) OR private.auth_is_in_organization(organization_id))", null],
  org_settings_upd: ['UPDATE', '{authenticated}', OWNER_TEST, OWNER_TEST],
}

const SEED = `
  INSERT INTO public.organizations VALUES ('${ORG_1}'), ('${ORG_2}');
  INSERT INTO public.locations VALUES ('${LOC_A}', '${ORG_1}'), ('${LOC_B}', '${ORG_1}'), ('${LOC_X}', '${ORG_2}');
  INSERT INTO public.profiles (id, role) VALUES
    ('${OWNER_A}', 'owner'), ('${STAFF_B}', 'staff'), ('${MASTER}', 'master'), ('${OWNER_X}', 'owner'), ('${ORG_ADMIN}', 'owner');
  INSERT INTO public.profile_locations VALUES
    ('${OWNER_A}', '${LOC_A}', 'owner'), ('${STAFF_B}', '${LOC_B}', 'staff'), ('${OWNER_X}', '${LOC_X}', 'owner');
  INSERT INTO public.profile_organizations (profile_id, organization_id) VALUES ('${ORG_ADMIN}', '${ORG_1}');
  INSERT INTO public.org_settings (organization_id, company_name, short_name, ai_hard_cap_cents, email_hard_cap_sends,
                                   ops_alert_emails, legal_entity_name, privacy_contact_email, updated_at) VALUES
    ('${ORG_1}', 'Synthetic Group', 'SYN', 5000, 20000, ARRAY['ops@example.invalid'], 'Synthetic Ltd',
     'privacy@example.invalid', now() - interval '1 day');
`

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)

/** Run statements as an authenticated JWT for `uid` in a rolled-back tx; returns the LAST statement's rows. */
async function asUser(uid, ...statements) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    let rows = []
    for (const s of statements) rows = (await db.query(s)).rows
    return rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function asRole(role, ...statements) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role })])
    await runSql(`SET LOCAL ROLE ${role}`)
    let rows = []
    for (const s of statements) rows = (await db.query(s)).rows
    return rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function policies() {
  const { rows } = await db.query(
    `SELECT policyname, permissive, cmd, roles::text AS roles, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`, [OS])
  return rows
}

async function clientAcl() {
  const { rows } = await db.query(`
    SELECT r.rolname AS grantee, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privs
      FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = 'public.org_settings'::regclass)) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE r.rolname IN ('anon', 'authenticated')
     GROUP BY r.rolname ORDER BY r.rolname`)
  return rows
}

async function comments() {
  const { rows } = await db.query(`
    SELECT obj_description('public.org_settings'::regclass, 'pg_class') AS tbl,
           (SELECT col_description(attrelid, attnum) FROM pg_attribute
             WHERE attrelid = 'public.org_settings'::regclass AND attname = 'customer_agent') AS ca`)
  return rows[0]
}

async function triggers() {
  const { rows } = await db.query(
    `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.org_settings'::regclass AND NOT tgisinternal ORDER BY tgname`)
  return rows
}

async function boot({ migrate = false, with729 = true, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  if (with729) await runSql(MIG_729)
  await runSql(`
    CREATE POLICY org_settings_select ON public.org_settings FOR SELECT TO authenticated USING (${PROD_TEXT.org_settings_select[2]});
    CREATE POLICY org_settings_ins ON public.org_settings FOR INSERT TO authenticated WITH CHECK (${OWNER_TEST});
    CREATE POLICY org_settings_upd ON public.org_settings FOR UPDATE TO authenticated USING (${OWNER_TEST}) WITH CHECK (${OWNER_TEST});
    CREATE POLICY org_settings_del ON public.org_settings FOR DELETE TO authenticated USING (${OWNER_TEST});`)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_730)
}

describe('before 730 — the hole (prod on 17 Oct 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('authenticated holds SELECT/INSERT/UPDATE/DELETE on org_settings; anon nothing', async () => {
    expect(await clientAcl()).toEqual([{ grantee: 'authenticated', privs: 'DELETE,INSERT,SELECT,UPDATE' }])
  })

  it("the replay's four policies read exactly as prod's pg_policies", async () => {
    const got = Object.fromEntries((await policies()).map((p) => [p.policyname, [p.cmd, p.roles, p.qual, p.with_check]]))
    expect(got).toEqual(PROD_TEXT)
    expect((await policies()).every((p) => p.permissive === 'PERMISSIVE')).toBe(true)
  })

  it("an owner at ONE studio (not an org admin) lifts the org's caps and rewrites its legal identity, alerts and brand", async () => {
    expect(await asUser(OWNER_A,
      `UPDATE public.org_settings
          SET ai_hard_cap_cents = NULL, email_hard_cap_sends = NULL, ai_cap_notice_month = '2026-10',
              legal_entity_name = 'Someone Else Ltd', privacy_contact_email = 'x@example.invalid',
              ops_alert_emails = ARRAY['x@example.invalid'], company_name = 'Renamed', short_name = 'RN'
        WHERE organization_id = '${ORG_1}'
        RETURNING ai_hard_cap_cents, legal_entity_name, ops_alert_emails, (updated_at > now() - interval '1 minute') AS touched`))
      .toEqual([{ ai_hard_cap_cents: null, legal_entity_name: 'Someone Else Ltd', ops_alert_emails: ['x@example.invalid'], touched: true }])
  })

  it('…deletes the row, and an owner creates the row for an org that has none', async () => {
    expect(await asUser(OWNER_A, `DELETE FROM public.org_settings WHERE organization_id = '${ORG_1}' RETURNING organization_id`))
      .toEqual([{ organization_id: ORG_1 }])
    expect(await asUser(OWNER_X,
      `INSERT INTO public.org_settings (organization_id, company_name, legal_entity_name) VALUES ('${ORG_2}', 'Mine', 'Mine Ltd')
        RETURNING organization_id`)).toEqual([{ organization_id: ORG_2 }])
  })

  it('a plain staff member reads every column, the ops alert recipients included', async () => {
    expect(await asUser(STAFF_B, `SELECT ops_alert_emails, ai_hard_cap_cents FROM public.org_settings`))
      .toEqual([{ ops_alert_emails: ['ops@example.invalid'], ai_hard_cap_cents: '5000' }])
  })

  it("mig 729's fence already refuses a client change to customer_agent (the only column it covered)", async () => {
    await expect(asUser(OWNER_A, `UPDATE public.org_settings SET customer_agent = '{"x":1}' WHERE organization_id = '${ORG_1}'`))
      .rejects.toThrow(/org_settings_customer_agent_fence/)
  })
})

describe('after 730', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it('no client privilege at all, RLS still on, no policy left', async () => {
    expect(await clientAcl()).toEqual([])
    for (const role of ['anon', 'authenticated', 'public']) {
      for (const priv of ALL_PRIVS) {
        const { rows } = await db.query(`SELECT has_table_privilege($1, 'public.org_settings', $2) AS has`, [role, priv])
        expect(rows[0].has, `${role} ${priv}`).toBe(false)
      }
    }
    const { rows } = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.org_settings'::regclass`)
    expect(rows[0].relrowsecurity).toBe(true)
    expect(await policies()).toEqual([])
  })

  it.each([['owner at one studio', OWNER_A], ['plain staff', STAFF_B], ['an org admin', ORG_ADMIN], ['a master', MASTER]])(
    '%s: every read and write is refused by the grant', async (_label, uid) => {
      await expect(asUser(uid, `SELECT count(*) FROM public.org_settings`)).rejects.toThrow(denied)
      await expect(asUser(uid, `UPDATE public.org_settings SET ai_hard_cap_cents = NULL`)).rejects.toThrow(denied)
      await expect(asUser(uid, `INSERT INTO public.org_settings (organization_id) VALUES ('${ORG_2}')`)).rejects.toThrow(denied)
      await expect(asUser(uid, `DELETE FROM public.org_settings`)).rejects.toThrow(denied)
      await expect(asUser(uid, `LOCK TABLE public.org_settings IN ACCESS EXCLUSIVE MODE`)).rejects.toThrow(denied)
    })

  it('anon: refused too', async () => {
    await expect(asRole('anon', `SELECT count(*) FROM public.org_settings`)).rejects.toThrow(denied)
    await expect(asRole('anon', `UPDATE public.org_settings SET company_name = 'x'`)).rejects.toThrow(denied)
  })

  it('both triggers kept; the table and customer_agent comments say service role only', async () => {
    expect(await triggers()).toEqual([
      { tgname: 'org_settings_customer_agent_fence', tgenabled: 'O' },
      { tgname: 'org_settings_touch_updated_at', tgenabled: 'O' },
    ])
    const c = await comments()
    expect(c.tbl).toMatch(/Service role only \(ORGSETCLIENTWRITE\.1, mig 730\)/)
    expect(c.ca).toMatch(/^MIAORG\.1 \(mig 729\)/)
    expect(c.ca).toMatch(/No client session reads or writes it since mig 730/)
    expect(c.ca).not.toMatch(/Readable by every org member/)
  })

  it('service_role: org-branding and org-usage upserts, the rollup notice month, the Mia org write, an org delete cascade', async () => {
    expect(await asRole('service_role',
      `INSERT INTO public.org_settings (organization_id, company_name, short_name, legal_entity_name, updated_by)
         VALUES ('${ORG_1}', 'Synthetic Group 2', 'SY2', 'Synthetic Ltd', '${ORG_ADMIN}')
         ON CONFLICT (organization_id) DO UPDATE SET company_name = EXCLUDED.company_name, short_name = EXCLUDED.short_name,
           legal_entity_name = EXCLUDED.legal_entity_name, updated_by = EXCLUDED.updated_by`,
      `INSERT INTO public.org_settings (organization_id, ai_hard_cap_cents, email_hard_cap_sends)
         VALUES ('${ORG_2}', 1200, 500)
         ON CONFLICT (organization_id) DO UPDATE SET ai_hard_cap_cents = EXCLUDED.ai_hard_cap_cents`,
      `UPDATE public.org_settings SET ai_cap_notice_month = '2026-10' WHERE organization_id = '${ORG_1}'`,
      `UPDATE public.org_settings SET customer_agent = '{"tone":"warm"}' WHERE organization_id = '${ORG_1}'`,
      `SELECT company_name, ai_cap_notice_month, customer_agent->>'tone' AS tone,
              (updated_at > now() - interval '1 minute') AS touched,
              (SELECT count(*)::int FROM public.org_settings) AS rows
         FROM public.org_settings WHERE organization_id = '${ORG_1}'`))
      .toEqual([{ company_name: 'Synthetic Group 2', ai_cap_notice_month: '2026-10', tone: 'warm', touched: true, rows: 2 }])
  })

  it('the org delete cascade still runs as the table owner', async () => {
    expect(await asRole('service_role',
      `INSERT INTO public.org_settings (organization_id) VALUES ('${ORG_2}')`,
      `DELETE FROM public.locations WHERE organization_id = '${ORG_2}'`, // the reduced FK has no cascade
      `DELETE FROM public.organizations WHERE id = '${ORG_2}'`,
      `SELECT count(*)::int AS n FROM public.org_settings WHERE organization_id = '${ORG_2}'`)).toEqual([{ n: 0 }])
  })

  it('the CHECKs still hold for the server (validation is not the grant)', async () => {
    await expect(asRole('service_role', `UPDATE public.org_settings SET ai_hard_cap_cents = 0`))
      .rejects.toThrow(/org_settings_ai_hard_cap_cents_check/)
  })
})

describe("on main's schema (no customer_agent column, no 729 fence)", () => {
  afterAll(() => db?.close())

  it('applies, closes the table, leaves the comment alone and needs no fence', async () => {
    await boot({ migrate: true, with729: false })
    expect(await clientAcl()).toEqual([])
    expect(await policies()).toEqual([])
    expect(await triggers()).toEqual([{ tgname: 'org_settings_touch_updated_at', tgenabled: 'O' }])
    expect((await comments()).ca).toBeNull()
  }, 60_000)
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, opts = {}) {
    await boot({ before, ...opts })
    await expect(runSql(MIG_730)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    expect((await policies()).map((p) => p.policyname)).toEqual(expect.arrayContaining(POLICY_NAMES))
    expect((await clientAcl()).find((r) => r.grantee === 'authenticated').privs).toContain('UPDATE')
    expect((await comments()).tbl).toBe(TABLE_COMMENT_BEFORE())
  }

  it("when another grantor's SELECT to authenticated survives the REVOKE", () => expectAbort(
    `GRANT SELECT ON public.org_settings TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT SELECT ON public.org_settings TO authenticated; RESET ROLE;`,
    /mig 730: client roles still hold privileges on public\.org_settings: authenticated:SELECT/,
  ), 60_000)

  it("when another grantor's UPDATE to anon survives", () => expectAbort(
    `GRANT UPDATE ON public.org_settings TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE ON public.org_settings TO anon; RESET ROLE;`,
    /mig 730: client roles still hold privileges on public\.org_settings: anon:UPDATE/,
  ), 60_000)

  it("when another grantor's column-level UPDATE (ai_hard_cap_cents) survives", () => expectAbort(
    `GRANT UPDATE (ai_hard_cap_cents) ON public.org_settings TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE (ai_hard_cap_cents) ON public.org_settings TO authenticated; RESET ROLE;`,
    /mig 730: client roles still hold privileges on public\.org_settings: authenticated:UPDATE/,
  ), 60_000)

  it('when INSERT is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT INSERT ON public.org_settings TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 730: authenticated still holds INSERT on public\.org_settings/,
  ), 60_000)

  it('when a policy the file does not know about is left', () => expectAbort(
    `CREATE POLICY org_settings_extra ON public.org_settings FOR SELECT TO authenticated USING (true);`,
    /mig 730: public\.org_settings should have no policy left: org_settings_extra SELECT/,
  ), 60_000)

  it('when RLS is off (the grant would then be its only fence)', () => expectAbort(
    `ALTER TABLE public.org_settings DISABLE ROW LEVEL SECURITY;`,
    /mig 730: row level security is off on public\.org_settings/,
  ), 60_000)

  it("when mig 729's fence is gone while its column exists", () => expectAbort(
    `DROP TRIGGER org_settings_customer_agent_fence ON public.org_settings;`,
    /mig 730: customer_agent exists but org_settings_customer_agent_fence \(mig 729\) is missing or disabled/,
  ), 60_000)

  it("when mig 729's fence is disabled", () => expectAbort(
    `ALTER TABLE public.org_settings DISABLE TRIGGER org_settings_customer_agent_fence;`,
    /mig 730: customer_agent exists but org_settings_customer_agent_fence \(mig 729\) is missing or disabled/,
  ), 60_000)

  it('when the updated_at trigger is gone', () => expectAbort(
    `DROP TRIGGER org_settings_touch_updated_at ON public.org_settings;`,
    /mig 730: org_settings_touch_updated_at is missing/,
  ), 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_730)).resolves.toBeDefined()
  }, 60_000)
})

describe('the rollback record', () => {
  afterAll(() => db?.close())

  it('restores the 17 Oct grant, policies and comments exactly (and so the hole)', async () => {
    await boot()
    const aclBefore = await clientAcl()
    const policiesBefore = await policies()
    const commentsBefore = await comments()
    await runSql(MIG_730)
    await runSql(ROLLBACK_730)
    expect(await clientAcl()).toEqual(aclBefore)
    expect(await policies()).toEqual(policiesBefore)
    expect(await comments()).toEqual(commentsBefore)
    expect(await asUser(OWNER_A, `UPDATE public.org_settings SET ai_hard_cap_cents = NULL RETURNING ai_hard_cap_cents`))
      .toEqual([{ ai_hard_cap_cents: null }])
  }, 60_000)
})
