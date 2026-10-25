// WATPLCLIENTWRITE.1 — behavioural test for migration 669.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) with Supabase's DEFAULT PRIVILEGES
// (every table in public gets ALL for anon, authenticated and service_role —
// the source of both tables' arwdDxtm), whatsapp_templates and
// whatsapp_template_events in PROD column order (30 Sep 2026) with their FKs
// and CHECK, the five live policies verbatim, the update_updated_at trigger,
// and increment_whatsapp_template_sent verbatim with its post-667 EXECUTE
// (postgres + service_role). private.auth_is_in_location and
// private.auth_is_manager_at are verbatim; private.auth_mobile_can is a
// STAND-IN (prod: permission bundles + per-location permissions JSON):
// "active member at the location with a synthetic whatsapp grant". It proves:
//
//   * BEFORE: a WhatsApp-permitted head coach repoints an APPROVED template's
//     header media and rewrites its components, inserts a local APPROVED
//     template, forges a status event and deletes a template (its events
//     cascade), all from their own session; anon reads an empty set;
//   * AFTER: every write (and LOCK … ACCESS EXCLUSIVE, i.e. MAINTAIN) refused
//     for authenticated, masters included; anon refused even a read; one
//     SELECT policy per table with the SAME expression; the phone's picker
//     read and realtime's SELECT return the same rows; the service role's
//     sync, webhook, send-counter and delete paths all still work;
//   * the self-check aborts the WHOLE file on another grantor's write, an
//     inherited write, a surviving anon read, a leftover write policy, an
//     extra read policy and a changed read rule; a second run passes; the
//     plan's rollback record restores the before-state exactly.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_669 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/669_whatsapp_templates_client_writes_off.sql'), 'utf8')

// The rollback record from the C89 plan (Task 5 Step 7), verbatim.
const ROLLBACK_669 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.whatsapp_templates, public.whatsapp_template_events
  TO anon;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.whatsapp_templates, public.whatsapp_template_events
  TO authenticated;
CREATE POLICY wa_tmpl_insert ON public.whatsapp_templates FOR INSERT TO authenticated
  WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
CREATE POLICY wa_tmpl_update ON public.whatsapp_templates FOR UPDATE TO authenticated
  USING (private.auth_mobile_can(location_id, 'whatsapp'::text))
  WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
CREATE POLICY wa_tmpl_delete ON public.whatsapp_templates FOR DELETE TO authenticated
  USING (private.auth_is_manager_at(location_id));
DROP POLICY IF EXISTS whatsapp_template_events_select ON public.whatsapp_template_events;
CREATE POLICY whatsapp_template_events_via_template ON public.whatsapp_template_events FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.whatsapp_templates t
                  WHERE t.id = whatsapp_template_events.template_id AND private.auth_is_in_location(t.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.whatsapp_templates t
                  WHERE t.id = whatsapp_template_events.template_id AND private.auth_is_in_location(t.location_id)));
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const COACH_A = '10000000-0000-0000-0000-000000000001' // head coach at A, WhatsApp permission
const STAFF_A = '10000000-0000-0000-0000-000000000002' // plain staff at A, NO WhatsApp permission
const MASTER = '10000000-0000-0000-0000-000000000003'
const TPL_A = '40000000-0000-0000-0000-000000000001'
const TPL_A2 = '40000000-0000-0000-0000-000000000002'
const TPL_B = '40000000-0000-0000-0000-000000000003'
const EV_A = '90000000-0000-0000-0000-000000000001'

const TPL = 'whatsapp_templates'
const EV = 'whatsapp_template_events'
const TABLES = [EV, TPL]
const ALL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
const denied = (t) => new RegExp(`permission denied for (table|relation) ${t}\\b`)

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_grantor NOLOGIN;
  CREATE ROLE sneaky NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated, service_role;   -- live: anon has none

  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  REVOKE SELECT ON public.profiles FROM anon, authenticated;   -- mig 153b
  CREATE TABLE private.synth_whatsapp_perm (profile_id uuid, location_id uuid);   -- stand-in data

  -- The two tables: PROD column order, defaults, keys and CHECK (pg_attribute/pg_constraint, 30 Sep 2026).
  CREATE TABLE public.whatsapp_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid REFERENCES public.locations(id),
    name text NOT NULL,
    meta_template_id text,
    language text DEFAULT 'en',
    category text NOT NULL DEFAULT 'MARKETING',
    components jsonb DEFAULT '[]'::jsonb,
    example_values jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'draft',
    rejection_reason text,
    total_sent integer DEFAULT 0,
    total_delivered integer DEFAULT 0,
    total_read integer DEFAULT 0,
    created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    header_media_handle text,
    header_media_url text,
    header_media_path text,
    quality_rating text,
    display_group text
  );
  CREATE TABLE public.whatsapp_template_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id uuid NOT NULL REFERENCES public.whatsapp_templates(id) ON DELETE CASCADE,
    location_id uuid REFERENCES public.locations(id),
    kind text NOT NULL CONSTRAINT whatsapp_template_events_kind_check CHECK (kind = ANY (ARRAY['status'::text, 'quality'::text, 'category'::text])),
    from_value text,
    to_value text NOT NULL,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Helpers. auth_is_in_location and auth_is_manager_at verbatim (pg_proc; mig 626).
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations
               WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
  $$;
  CREATE FUNCTION private.auth_is_manager_at(p_location_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (
          SELECT 1 FROM public.profile_locations pl
          WHERE pl.profile_id = (SELECT auth.uid()) AND pl.location_id = p_location_id
            AND pl.role IN ('owner','manager','head_coach')))
    )
  $$;
  -- STAND-IN for private.auth_mobile_can (prod: mobile_can_for + permission bundles).
  CREATE FUNCTION private.auth_mobile_can(loc_id uuid, perm_key text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT private.auth_is_in_location(loc_id) AND (
      EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role = 'master')
      OR (perm_key = 'whatsapp' AND EXISTS (SELECT 1 FROM private.synth_whatsapp_perm
            WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
  $$;
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated, service_role;

  -- update_updated_at and its trigger, verbatim (INVOKER, touches NEW only).
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER set_wa_templates_updated_at BEFORE UPDATE ON public.whatsapp_templates
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

  -- The send counter, verbatim (INVOKER, search_path ''); EXECUTE as prod
  -- since mig 667: postgres + service_role only.
  CREATE FUNCTION public.increment_whatsapp_template_sent(p_template_id uuid, p_delta integer DEFAULT 1) RETURNS void
    LANGUAGE sql SET search_path = '' AS $$
    update public.whatsapp_templates set total_sent = coalesce(total_sent,0) + p_delta where id = p_template_id;
  $$;
  REVOKE EXECUTE ON FUNCTION public.increment_whatsapp_template_sent(uuid, integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.increment_whatsapp_template_sent(uuid, integer) TO service_role;
`

// The live policies (pg_policies, 30 Sep 2026; migs 219 and 254).
const PROD_POLICIES = `
  ALTER TABLE public.whatsapp_templates ENABLE ROW LEVEL SECURITY;
  CREATE POLICY wa_tmpl_select ON public.whatsapp_templates FOR SELECT TO authenticated
    USING (private.auth_mobile_can(location_id, 'whatsapp'::text));
  CREATE POLICY wa_tmpl_insert ON public.whatsapp_templates FOR INSERT TO authenticated
    WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
  CREATE POLICY wa_tmpl_update ON public.whatsapp_templates FOR UPDATE TO authenticated
    USING (private.auth_mobile_can(location_id, 'whatsapp'::text))
    WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
  CREATE POLICY wa_tmpl_delete ON public.whatsapp_templates FOR DELETE TO authenticated
    USING (private.auth_is_manager_at(location_id));

  ALTER TABLE public.whatsapp_template_events ENABLE ROW LEVEL SECURITY;
  CREATE POLICY whatsapp_template_events_via_template ON public.whatsapp_template_events FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.whatsapp_templates t
                    WHERE t.id = whatsapp_template_events.template_id AND private.auth_is_in_location(t.location_id)))
    WITH CHECK (EXISTS (SELECT 1 FROM public.whatsapp_templates t
                    WHERE t.id = whatsapp_template_events.template_id AND private.auth_is_in_location(t.location_id)));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles (id, role) VALUES ('${COACH_A}', 'staff'), ('${STAFF_A}', 'staff'), ('${MASTER}', 'master');
  INSERT INTO public.profile_locations VALUES ('${COACH_A}', '${LOC_A}', 'head_coach'), ('${STAFF_A}', '${LOC_A}', 'staff');
  INSERT INTO private.synth_whatsapp_perm VALUES ('${COACH_A}', '${LOC_A}');
  INSERT INTO public.whatsapp_templates (id, location_id, name, language, category, components, status, header_media_url, display_group) VALUES
    ('${TPL_A}', '${LOC_A}', 'synthetic_promo', 'en_US', 'MARKETING',
     '[{"type":"HEADER","format":"IMAGE"},{"type":"BODY","text":"Hi {{1}}"}]', 'APPROVED', 'https://example.invalid/synthetic-a.jpg', 'Promos'),
    ('${TPL_A2}', '${LOC_A}', 'synthetic_draft', 'en_US', 'UTILITY', '[{"type":"BODY","text":"Hello"}]', 'REJECTED', NULL, NULL),
    ('${TPL_B}', '${LOC_B}', 'synthetic_other', 'en_US', 'UTILITY', '[{"type":"BODY","text":"Hello"}]', 'APPROVED', NULL, NULL);
  INSERT INTO public.whatsapp_template_events (id, template_id, location_id, kind, from_value, to_value) VALUES
    ('${EV_A}', '${TPL_A}', '${LOC_A}', 'status', 'PENDING', 'APPROVED');
`

// The phone's direct read (mobile/lib/whatsapp-api.js listTemplates).
const PHONE_PICKER_SQL = `
  SELECT id, name, status, category, language, components, header_media_url, display_group
    FROM public.whatsapp_templates WHERE status = 'APPROVED' AND location_id = '${LOC_A}' ORDER BY name`

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
    `SELECT tablename, policyname, permissive, cmd, roles::text AS roles, qual FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY tablename, policyname`, [TABLES])
  return rows
}

async function clientAcl(table) {
  const { rows } = await db.query(`
    SELECT r.rolname AS grantee, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privs
      FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = ('public.' || $1)::regclass)) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE r.rolname IN ('anon', 'authenticated')
     GROUP BY r.rolname ORDER BY r.rolname`, [table])
  return rows
}

async function boot({ migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_669)
}

describe('before 669 — the hole (prod on 30 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it.each(TABLES)('the default privileges gave both client roles every privilege on %s (arwdDxtm, PG 17)', async (t) => {
    expect(await clientAcl(t)).toEqual([
      { grantee: 'anon', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
      { grantee: 'authenticated', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
    ])
  })

  it('a WhatsApp-permitted head coach repoints an APPROVED template’s header media and rewrites its components', async () => {
    expect(await asUser(COACH_A,
      `UPDATE public.whatsapp_templates
          SET header_media_url = 'https://example.invalid/forged.jpg',
              components = '[{"type":"HEADER","format":"IMAGE"},{"type":"BODY","text":"forged"}]'
        WHERE id = '${TPL_A}' RETURNING status, header_media_url`))
      .toEqual([{ status: 'APPROVED', header_media_url: 'https://example.invalid/forged.jpg' }])
  })

  it('…flips a REJECTED template to APPROVED and inserts a local APPROVED row', async () => {
    expect(await asUser(COACH_A,
      `UPDATE public.whatsapp_templates SET status = 'APPROVED' WHERE id = '${TPL_A2}' RETURNING status`))
      .toEqual([{ status: 'APPROVED' }])
    expect(await asUser(COACH_A,
      `INSERT INTO public.whatsapp_templates (location_id, name, status) VALUES ('${LOC_A}', 'forged', 'APPROVED') RETURNING status`))
      .toEqual([{ status: 'APPROVED' }])
  })

  it('…forges a status event and deletes a template (its events cascade)', async () => {
    expect(await asUser(COACH_A,
      `INSERT INTO public.whatsapp_template_events (template_id, location_id, kind, to_value)
       VALUES ('${TPL_A2}', '${LOC_A}', 'status', 'APPROVED') RETURNING to_value`)).toEqual([{ to_value: 'APPROVED' }])
    expect(await asUser(COACH_A,
      `DELETE FROM public.whatsapp_templates WHERE id = '${TPL_A}' RETURNING id`,
      `SELECT count(*)::int AS n FROM public.whatsapp_template_events`)).toEqual([{ n: 0 }])
  })

  it('a plain staff member without the permission sees no template and no event; anon reads an empty set', async () => {
    expect(await asUser(STAFF_A, `SELECT count(*)::int AS n FROM public.whatsapp_templates`)).toEqual([{ n: 0 }])
    expect(await asUser(STAFF_A, `SELECT count(*)::int AS n FROM public.whatsapp_template_events`)).toEqual([{ n: 0 }])
    expect(await asRole('anon', `SELECT count(*)::int AS n FROM public.whatsapp_templates`)).toEqual([{ n: 0 }])
  })
})

describe('after 669 — the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each(TABLES)('anon and public hold nothing; authenticated holds only SELECT (MAINTAIN checked) on %s', async (t) => {
    for (const role of ['anon', 'authenticated', 'public']) {
      for (const p of ALL_PRIVS) {
        const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, $2, $3) AS held`, [role, `public.${t}`, p])
        expect(r.held, `${role} ${p} ${t}`).toBe(role === 'authenticated' && p === 'SELECT')
      }
    }
  })

  it.each(TABLES)('%s: no column-level privilege for a client role; service_role still reads and writes', async (t) => {
    const rel = `public.${t}`
    const { rows: [r] } = await db.query(`SELECT
      has_any_column_privilege('authenticated', $1, 'INSERT') OR has_any_column_privilege('authenticated', $1, 'UPDATE')
        OR has_any_column_privilege('authenticated', $1, 'REFERENCES') AS a_col,
      has_any_column_privilege('anon', $1, 'SELECT') OR has_any_column_privilege('anon', $1, 'INSERT')
        OR has_any_column_privilege('anon', $1, 'UPDATE') AS n_col,
      has_table_privilege('service_role', $1, 'SELECT') AND has_table_privilege('service_role', $1, 'INSERT')
        AND has_table_privilege('service_role', $1, 'UPDATE') AND has_table_privilege('service_role', $1, 'DELETE') AS svc`, [rel])
    expect(r).toEqual({ a_col: false, n_col: false, svc: true })
    expect(await clientAcl(t)).toEqual([{ grantee: 'authenticated', privs: 'SELECT' }])
  })

  it('exactly one SELECT policy per table, TO authenticated', async () => {
    expect((await policies()).map(({ qual: _qual, ...p }) => p)).toEqual([
      { tablename: EV, policyname: 'whatsapp_template_events_select', permissive: 'PERMISSIVE', cmd: 'SELECT', roles: '{authenticated}' },
      { tablename: TPL, policyname: 'wa_tmpl_select', permissive: 'PERMISSIVE', cmd: 'SELECT', roles: '{authenticated}' },
    ])
  })

  it('each SELECT policy reads with the SAME expression as the read rule it replaces', async () => {
    const after = Object.fromEntries((await policies()).map((p) => [p.tablename, p.qual]))
    await db.close()
    await boot()
    const before = Object.fromEntries((await policies())
      .filter((p) => p.cmd === 'SELECT' || p.cmd === 'ALL').map((p) => [p.tablename, p.qual]))
    expect(after).toEqual(before)
  })
})

describe('after 669 — people', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each([['head coach', COACH_A], ['master', MASTER], ['plain staff', STAFF_A]])(
    '%s: INSERT, UPDATE, UPSERT, DELETE, TRUNCATE and LOCK are refused on both tables', async (_l, uid) => {
      await expect(asUser(uid, `UPDATE public.whatsapp_templates SET header_media_url = 'https://example.invalid/x.jpg' WHERE id = '${TPL_A}'`))
        .rejects.toThrow(denied(TPL))
      await expect(asUser(uid, `UPDATE public.whatsapp_templates SET components = '[]' WHERE id = '${TPL_A}'`)).rejects.toThrow(denied(TPL))
      await expect(asUser(uid, `UPDATE public.whatsapp_templates SET status = 'APPROVED' WHERE id = '${TPL_A2}'`)).rejects.toThrow(denied(TPL))
      await expect(asUser(uid, `INSERT INTO public.whatsapp_templates (location_id, name, status) VALUES ('${LOC_A}', 'forged', 'APPROVED')`))
        .rejects.toThrow(denied(TPL))
      await expect(asUser(uid, `INSERT INTO public.whatsapp_templates (id, location_id, name) VALUES ('${TPL_A}', '${LOC_A}', 'x')
        ON CONFLICT (id) DO UPDATE SET header_media_url = 'https://example.invalid/x.jpg'`)).rejects.toThrow(denied(TPL))
      await expect(asUser(uid, `DELETE FROM public.whatsapp_templates WHERE id = '${TPL_A}'`)).rejects.toThrow(denied(TPL))
      await expect(asUser(uid, `INSERT INTO public.whatsapp_template_events (template_id, location_id, kind, to_value)
        VALUES ('${TPL_A2}', '${LOC_A}', 'status', 'APPROVED')`)).rejects.toThrow(denied(EV))
      await expect(asUser(uid, `UPDATE public.whatsapp_template_events SET reason = 'x' WHERE id = '${EV_A}'`)).rejects.toThrow(denied(EV))
      await expect(asUser(uid, `DELETE FROM public.whatsapp_template_events WHERE id = '${EV_A}'`)).rejects.toThrow(denied(EV))
      for (const t of TABLES) {
        await expect(asUser(uid, `TRUNCATE public.${t} CASCADE`)).rejects.toThrow(/permission denied/)
        await expect(asUser(uid, `LOCK TABLE public.${t} IN ACCESS EXCLUSIVE MODE`)).rejects.toThrow(denied(t))
      }
    })

  it('head coach: the send counter RPC stays refused (EXECUTE closed since mig 667)', async () => {
    await expect(asUser(COACH_A, `SELECT public.increment_whatsapp_template_sent('${TPL_A}', 1)`))
      .rejects.toThrow(/permission denied for function increment_whatsapp_template_sent/)
  })

  it("head coach: the phone's picker, realtime's SELECT and the audit trail return the same rows", async () => {
    expect((await asUser(COACH_A, PHONE_PICKER_SQL)).map((r) => [r.id, r.header_media_url]))
      .toEqual([[TPL_A, 'https://example.invalid/synthetic-a.jpg']])
    expect(await asUser(COACH_A, 'SELECT count(*)::int AS n FROM public.whatsapp_templates')).toEqual([{ n: 2 }])
    expect(await asUser(COACH_A, 'SELECT id FROM public.whatsapp_template_events')).toEqual([{ id: EV_A }])
    expect(await asUser(MASTER, 'SELECT count(*)::int AS n FROM public.whatsapp_templates')).toEqual([{ n: 3 }])
  })

  it('plain staff: still no template and no event (policy expression unchanged)', async () => {
    expect(await asUser(STAFF_A, 'SELECT count(*)::int AS n FROM public.whatsapp_templates')).toEqual([{ n: 0 }])
    expect(await asUser(STAFF_A, 'SELECT count(*)::int AS n FROM public.whatsapp_template_events')).toEqual([{ n: 0 }])
  })

  it('service_role: Meta sync upsert, webhook status + event, send counter and delete (events cascade) still work', async () => {
    const rows = await asRole('service_role',
      `INSERT INTO public.whatsapp_templates (location_id, name, status, meta_template_id) VALUES ('${LOC_B}', 'synthetic_new', 'PENDING', 'm-1')`,
      `UPDATE public.whatsapp_templates SET status = 'APPROVED', quality_rating = 'GREEN', components = '[]' WHERE id = '${TPL_A2}'`,
      `INSERT INTO public.whatsapp_template_events (template_id, location_id, kind, from_value, to_value)
       VALUES ('${TPL_A2}', '${LOC_A}', 'status', 'REJECTED', 'APPROVED')`,
      `SELECT public.increment_whatsapp_template_sent('${TPL_A}', 3)`,
      `DELETE FROM public.whatsapp_templates WHERE id = '${TPL_A}'`,
      `SELECT (SELECT count(*)::int FROM public.whatsapp_templates) AS tpls,
              (SELECT status FROM public.whatsapp_templates WHERE id = '${TPL_A2}') AS a2,
              (SELECT count(*)::int FROM public.whatsapp_template_events) AS evs`)
    expect(rows).toEqual([{ tpls: 3, a2: 'APPROVED', evs: 1 }])
  })

  it('anon: every read and write is refused by the grant itself', async () => {
    for (const t of TABLES) {
      await expect(asRole('anon', `SELECT count(*) FROM public.${t}`)).rejects.toThrow(denied(t))
      await expect(asRole('anon', `DELETE FROM public.${t}`)).rejects.toThrow(denied(t))
    }
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, sql = MIG_669) {
    await boot({ before })
    await expect(runSql(sql)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    const names = (await policies()).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['wa_tmpl_update', 'whatsapp_template_events_via_template']))
    expect((await clientAcl(TPL)).find((r) => r.grantee === 'authenticated').privs).toContain('UPDATE')
  }

  it("when another grantor's UPDATE on templates survives the REVOKE", () => expectAbort(
    `GRANT UPDATE ON public.whatsapp_templates TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE ON public.whatsapp_templates TO authenticated; RESET ROLE;`,
    /mig 669: client roles still hold privileges on public\.whatsapp_templates: authenticated:UPDATE/,
  ), 60_000)

  it("when another grantor's SELECT to anon survives (anon must hold nothing)", () => expectAbort(
    `GRANT SELECT ON public.whatsapp_template_events TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT SELECT ON public.whatsapp_template_events TO anon; RESET ROLE;`,
    /mig 669: client roles still hold privileges on public\.whatsapp_template_events: anon:SELECT/,
  ), 60_000)

  it('when INSERT on templates is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT INSERT ON public.whatsapp_templates TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 669: authenticated still holds INSERT on public\.whatsapp_templates/,
  ), 60_000)

  it('when a write policy the file does not know about is left on templates', () => expectAbort(
    `CREATE POLICY wa_tmpl_update_media ON public.whatsapp_templates FOR UPDATE TO authenticated
       USING (true) WITH CHECK (true);`,
    /mig 669: write policies remain on public\.whatsapp_templates: wa_tmpl_update_media UPDATE/,
  ), 60_000)

  it('when an extra read policy sits on events', () => expectAbort(
    `CREATE POLICY ev_read_all ON public.whatsapp_template_events FOR SELECT TO authenticated USING (true);`,
    /mig 669: public\.whatsapp_template_events should keep exactly one policy, whatsapp_template_events_select FOR SELECT/,
  ), 60_000)

  it('when the new events SELECT policy would read different rows (self-check 6)', () => {
    const NEEDLE = 'AND private.auth_is_in_location(t.location_id)));'
    expect(MIG_669.split(NEEDLE).length).toBe(2)   // exactly one occurrence: the events policy
    return expectAbort('', /mig 669: whatsapp_template_events_select does not read the same rows as the policy it replaces/,
      MIG_669.replace(NEEDLE, 'AND t.location_id IS NOT NULL));'))
  }, 60_000)

  it('when wa_tmpl_select would read different rows (self-check 6 compares it with its captured copy)', () => {
    const NEEDLE = 'DROP POLICY IF EXISTS wa_tmpl_delete ON public.whatsapp_templates;\n'
    expect(MIG_669.split(NEEDLE).length).toBe(2)
    return expectAbort('', /mig 669: wa_tmpl_select does not read the same rows as the policy it replaces/,
      MIG_669.replace(NEEDLE, `${NEEDLE}DROP POLICY wa_tmpl_select ON public.whatsapp_templates;
CREATE POLICY wa_tmpl_select ON public.whatsapp_templates FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));
`))
  }, 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_669)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the 30 Sep grants and policies exactly (and so the hole)', async () => {
    await boot()
    const aclBefore = await Promise.all(TABLES.map(clientAcl))
    const policiesBefore = await policies()
    await runSql(MIG_669)
    await runSql(ROLLBACK_669)
    expect(await Promise.all(TABLES.map(clientAcl))).toEqual(aclBefore)
    expect(await policies()).toEqual(policiesBefore)
    expect(await asUser(COACH_A,
      `UPDATE public.whatsapp_templates SET header_media_url = 'https://example.invalid/forged.jpg' WHERE id = '${TPL_A}' RETURNING id`))
      .toEqual([{ id: TPL_A }])
  }, 60_000)
})
