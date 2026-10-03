// WACONVCLIENTWRITE.1 — behavioural test for migration 661.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) with Supabase's DEFAULT PRIVILEGES
// (every table in public gets ALL for anon, authenticated and service_role —
// the source of the three tables' arwdDxtm), whatsapp_conversations,
// whatsapp_broadcasts and whatsapp_broadcast_recipients in PROD column order
// (29 Sep 2026) with their FKs and CHECKs, the six live policies verbatim, the
// two INVOKER counter RPCs verbatim, the update_updated_at triggers, and
// whatsapp_messages (a column subset) in its post-656 state with the live
// ON DELETE CASCADE from conversations. private.auth_is_in_location and
// private.auth_is_manager_at are verbatim; private.auth_mobile_can is a
// STAND-IN (prod: permission bundles + per-location permissions JSON):
// "active member at the location with a synthetic whatsapp grant". It proves:
//
//   * BEFORE: a WhatsApp-permitted manager rewrites the member identity Mia
//     acts for, pauses Mia, resolves and deletes a thread (and its messages)
//     and bumps unread through the RPC; a plain staff member WITHOUT the
//     WhatsApp permission inserts a due scheduled broadcast (the cron would
//     send it) and marks a pending recipient sent — all from their own session;
//   * AFTER: every write (and LOCK … ACCESS EXCLUSIVE, i.e. MAINTAIN) refused
//     for anon and authenticated, masters included; the counter RPC refused
//     for a client; one SELECT policy per table with the SAME expression; the
//     phone's reads and realtime's SELECT return the same rows; the service
//     role's inbox, webhook, broadcast and cascade paths all still work;
//   * the self-check aborts the WHOLE file on another grantor's write, an
//     inherited write, a leftover write policy, an extra read policy and a
//     changed read rule; a second run passes; the plan's rollback record
//     restores the before-state exactly.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_661 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/661_whatsapp_conversations_broadcasts_client_writes_off.sql'), 'utf8')

// The rollback record from the C66 plan (Task 5 Step 7), verbatim.
const ROLLBACK_661 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.whatsapp_conversations, public.whatsapp_broadcasts, public.whatsapp_broadcast_recipients
  TO anon, authenticated;
CREATE POLICY wa_conv_insert ON public.whatsapp_conversations FOR INSERT TO authenticated
  WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
CREATE POLICY wa_conv_update ON public.whatsapp_conversations FOR UPDATE TO authenticated
  USING (private.auth_mobile_can(location_id, 'whatsapp'::text))
  WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
CREATE POLICY wa_conv_delete ON public.whatsapp_conversations FOR DELETE TO authenticated
  USING (private.auth_is_manager_at(location_id));
DROP POLICY IF EXISTS whatsapp_broadcasts_select ON public.whatsapp_broadcasts;
CREATE POLICY whatsapp_broadcasts_location_scoped ON public.whatsapp_broadcasts FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_in_location(location_id));
DROP POLICY IF EXISTS whatsapp_broadcast_recipients_select ON public.whatsapp_broadcast_recipients;
CREATE POLICY whatsapp_broadcast_recipients_via_broadcast ON public.whatsapp_broadcast_recipients FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.whatsapp_broadcasts b
                  WHERE b.id = whatsapp_broadcast_recipients.broadcast_id AND private.auth_is_in_location(b.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.whatsapp_broadcasts b
                  WHERE b.id = whatsapp_broadcast_recipients.broadcast_id AND private.auth_is_in_location(b.location_id)));
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const MANAGER_A = '10000000-0000-0000-0000-000000000001' // manager at A, WhatsApp permission
const STAFF_A = '10000000-0000-0000-0000-000000000002'   // plain staff at A, NO WhatsApp permission
const MASTER = '10000000-0000-0000-0000-000000000003'
const C_A = '30000000-0000-0000-0000-000000000001'
const C_OTHER = '30000000-0000-0000-0000-000000000002'
const TPL = '40000000-0000-0000-0000-000000000001'
const CONV_A = '50000000-0000-0000-0000-000000000001'
const CONV_B = '50000000-0000-0000-0000-000000000002'
const M_A = '60000000-0000-0000-0000-000000000001'
const BC_A = '70000000-0000-0000-0000-000000000001'
const BC_B = '70000000-0000-0000-0000-000000000002'
const R_SENT = '80000000-0000-0000-0000-000000000001'
const R_PENDING = '80000000-0000-0000-0000-000000000002'

const CONV = 'whatsapp_conversations'
const BC = 'whatsapp_broadcasts'
const RC = 'whatsapp_broadcast_recipients'
const TABLES = [RC, BC, CONV]
const WRITE_PRIVS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
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

  CREATE TABLE public.contacts (id uuid PRIMARY KEY, name text, location_id uuid);
  -- mig 653 (applied 28 Sep): contacts is read-only for clients.
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.contacts FROM anon, authenticated, PUBLIC;
  CREATE TABLE public.whatsapp_templates (id uuid PRIMARY KEY, name text);

  -- The three tables: PROD column order, defaults, keys and CHECKs (pg_attribute/pg_constraint, 29 Sep 2026).
  CREATE TABLE public.whatsapp_conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid REFERENCES public.locations(id),
    contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
    wa_phone text,
    window_open_at timestamptz,
    window_expires_at timestamptz,
    status text DEFAULT 'active',
    last_message_at timestamptz,
    last_message_direction text,
    last_message_preview text,
    unread_count integer DEFAULT 0,
    assigned_to uuid REFERENCES public.profiles(id),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    wa_profile_name text,
    agent_active boolean NOT NULL DEFAULT true,
    agent_handed_off_at timestamptz,
    agent_last_reply_at timestamptz,
    agent_verified_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
    agent_verified_at timestamptz,
    agent_processing_at timestamptz,
    resolved_at timestamptz,
    agent_followup_stage smallint NOT NULL DEFAULT 0,
    agent_followup_sent_at timestamptz,
    ctwa_clid text,
    is_blocked boolean NOT NULL DEFAULT false,
    handoff_escalated_at timestamptz,
    wa_bsuid text,
    agent_activity_notified_at timestamptz,
    agent_verify_attempts smallint NOT NULL DEFAULT 0,
    agent_paused_at timestamptz
  );
  CREATE TABLE public.whatsapp_broadcasts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid REFERENCES public.locations(id),
    name text NOT NULL,
    template_id uuid REFERENCES public.whatsapp_templates(id),
    variable_mapping jsonb DEFAULT '{}'::jsonb,
    header_media_url text,
    audience_filter jsonb DEFAULT '{"logic": "and", "filters": []}'::jsonb,
    status text DEFAULT 'draft',
    scheduled_at timestamptz,
    sent_at timestamptz,
    total_recipients integer DEFAULT 0,
    total_sent integer DEFAULT 0,
    total_delivered integer DEFAULT 0,
    total_read integer DEFAULT 0,
    total_failed integer DEFAULT 0,
    created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    delivery_mode text NOT NULL DEFAULT 'blast',
    daily_cap integer NOT NULL DEFAULT 500,
    send_window_start time NOT NULL DEFAULT '09:00:00',
    send_window_end time NOT NULL DEFAULT '20:00:00',
    send_window_tz text NOT NULL DEFAULT 'Europe/Dublin',
    paused_at timestamptz,
    delivery_summary jsonb,
    per_tick_max integer,
    handle_replies_manually boolean NOT NULL DEFAULT false,
    CONSTRAINT whatsapp_broadcasts_daily_cap_chk CHECK (daily_cap > 0),
    CONSTRAINT whatsapp_broadcasts_delivery_mode_chk CHECK (delivery_mode = ANY (ARRAY['blast'::text, 'drip'::text])),
    CONSTRAINT whatsapp_broadcasts_per_tick_max_check CHECK (per_tick_max IS NULL OR (per_tick_max > 0 AND per_tick_max <= 5000))
  );
  CREATE TABLE public.whatsapp_broadcast_recipients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    broadcast_id uuid NOT NULL REFERENCES public.whatsapp_broadcasts(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    wa_message_id text,
    status text DEFAULT 'pending',
    error_message text,
    sent_at timestamptz,
    delivered_at timestamptz,
    read_at timestamptz,
    failed_at timestamptz,
    created_at timestamptz DEFAULT now(),
    UNIQUE (broadcast_id, contact_id)
  );
  -- whatsapp_messages: a column SUBSET; the two FKs that matter here are live.
  CREATE TABLE public.whatsapp_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
    location_id uuid,
    direction text NOT NULL,
    body text,
    broadcast_id uuid REFERENCES public.whatsapp_broadcasts(id),
    created_at timestamptz DEFAULT now()
  );
  -- mig 656 (C55; applies before or after this one, no case here depends on it).
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.whatsapp_messages FROM anon, authenticated, PUBLIC;

  -- Helpers. auth_is_in_location and auth_is_manager_at verbatim (pg_proc, 29 Sep; mig 626).
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

  -- update_updated_at and its two triggers, verbatim (INVOKER, touches NEW only).
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER set_wa_conversations_updated_at BEFORE UPDATE ON public.whatsapp_conversations
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
  CREATE TRIGGER set_wa_broadcasts_updated_at BEFORE UPDATE ON public.whatsapp_broadcasts
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

  -- The two counter RPCs, verbatim (INVOKER, search_path ''; EXECUTE stays with
  -- PUBLIC as in prod — C67's scope). Only the service-role webhook calls them.
  CREATE FUNCTION public.increment_whatsapp_conversation_unread(p_conversation_id uuid) RETURNS void
    LANGUAGE sql SET search_path = '' AS $$
    update public.whatsapp_conversations set unread_count = coalesce(unread_count,0) + 1 where id = p_conversation_id;
  $$;
  CREATE FUNCTION public.increment_whatsapp_broadcast_metric(p_broadcast_id uuid, p_metric text, p_delta integer DEFAULT 1) RETURNS void
    LANGUAGE plpgsql SET search_path = '' AS $$
  begin
    if p_metric not in ('total_sent','total_delivered','total_read','total_failed') then
      raise exception 'increment_whatsapp_broadcast_metric: unknown metric %', p_metric;
    end if;
    update public.whatsapp_broadcasts set
      total_sent      = coalesce(total_sent,0)      + (case when p_metric='total_sent'      then p_delta else 0 end),
      total_delivered = coalesce(total_delivered,0) + (case when p_metric='total_delivered' then p_delta else 0 end),
      total_read      = coalesce(total_read,0)      + (case when p_metric='total_read'      then p_delta else 0 end),
      total_failed    = coalesce(total_failed,0)    + (case when p_metric='total_failed'    then p_delta else 0 end)
    where id = p_broadcast_id;
  end
  $$;
`

// The live policies (pg_policies, 29 Sep 2026; migs 014 and 219), plus wa_msg_select.
const PROD_POLICIES = `
  ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY wa_conv_select ON public.whatsapp_conversations FOR SELECT TO authenticated
    USING (private.auth_mobile_can(location_id, 'whatsapp'::text));
  CREATE POLICY wa_conv_insert ON public.whatsapp_conversations FOR INSERT TO authenticated
    WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
  CREATE POLICY wa_conv_update ON public.whatsapp_conversations FOR UPDATE TO authenticated
    USING (private.auth_mobile_can(location_id, 'whatsapp'::text))
    WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
  CREATE POLICY wa_conv_delete ON public.whatsapp_conversations FOR DELETE TO authenticated
    USING (private.auth_is_manager_at(location_id));

  ALTER TABLE public.whatsapp_broadcasts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY whatsapp_broadcasts_location_scoped ON public.whatsapp_broadcasts FOR ALL TO authenticated
    USING (private.auth_is_in_location(location_id))
    WITH CHECK (private.auth_is_in_location(location_id));

  ALTER TABLE public.whatsapp_broadcast_recipients ENABLE ROW LEVEL SECURITY;
  CREATE POLICY whatsapp_broadcast_recipients_via_broadcast ON public.whatsapp_broadcast_recipients FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.whatsapp_broadcasts b
                    WHERE b.id = whatsapp_broadcast_recipients.broadcast_id AND private.auth_is_in_location(b.location_id)))
    WITH CHECK (EXISTS (SELECT 1 FROM public.whatsapp_broadcasts b
                    WHERE b.id = whatsapp_broadcast_recipients.broadcast_id AND private.auth_is_in_location(b.location_id)));

  ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
  CREATE POLICY wa_msg_select ON public.whatsapp_messages FOR SELECT TO authenticated
    USING (private.auth_mobile_can(location_id, 'whatsapp'::text));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles (id, role) VALUES ('${MANAGER_A}', 'staff'), ('${STAFF_A}', 'staff'), ('${MASTER}', 'master');
  INSERT INTO public.profile_locations VALUES ('${MANAGER_A}', '${LOC_A}', 'manager'), ('${STAFF_A}', '${LOC_A}', 'staff');
  INSERT INTO private.synth_whatsapp_perm VALUES ('${MANAGER_A}', '${LOC_A}');
  INSERT INTO public.contacts VALUES ('${C_A}', 'Synth Customer', '${LOC_A}'), ('${C_OTHER}', 'Synth Other', '${LOC_A}');
  INSERT INTO public.whatsapp_templates VALUES ('${TPL}', 'synthetic_template');
  INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone, last_message_at, unread_count, assigned_to) VALUES
    ('${CONV_A}', '${LOC_A}', '${C_A}', 'synthetic-1', '2026-09-02', 1, '${MANAGER_A}'),
    ('${CONV_B}', '${LOC_B}', NULL, 'synthetic-2', '2026-09-03', 2, NULL);
  INSERT INTO public.whatsapp_messages (id, conversation_id, location_id, direction, body) VALUES
    ('${M_A}', '${CONV_A}', '${LOC_A}', 'inbound', 'synthetic');
  INSERT INTO public.whatsapp_broadcasts (id, location_id, name, template_id, status, created_by, total_sent) VALUES
    ('${BC_A}', '${LOC_A}', 'Synth A', '${TPL}', 'sent', '${MANAGER_A}', 1),
    ('${BC_B}', '${LOC_B}', 'Synth B', '${TPL}', 'sent', '${MASTER}', 0);
  INSERT INTO public.whatsapp_broadcast_recipients (id, broadcast_id, contact_id, status) VALUES
    ('${R_SENT}', '${BC_A}', '${C_A}', 'sent'), ('${R_PENDING}', '${BC_A}', '${C_OTHER}', 'pending');
`

// The phone's direct reads (mobile/lib/whatsapp-api.js listConversations,
// shared/dashboard-data.js "my unread" + studio unread), minus the contacts embed.
const PHONE_LIST_SQL = `
  SELECT id, location_id, contact_id, wa_phone, wa_profile_name, status, last_message_at, last_message_direction,
         last_message_preview, unread_count, window_expires_at, assigned_to, created_at, resolved_at,
         agent_handed_off_at, agent_active, is_blocked
    FROM public.whatsapp_conversations WHERE location_id = '${LOC_A}'
   ORDER BY last_message_at DESC NULLS LAST LIMIT 100`
const MY_UNREAD_SQL = `SELECT id, unread_count FROM public.whatsapp_conversations
                        WHERE assigned_to = '${MANAGER_A}' AND unread_count > 0`

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
  if (migrate) await runSql(MIG_661)
}

describe('before 661 — the hole (prod on 29 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it.each(TABLES)('the default privileges gave both client roles every privilege on %s (arwdDxtm, PG 17)', async (t) => {
    expect(await clientAcl(t)).toEqual([
      { grantee: 'anon', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
      { grantee: 'authenticated', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
    ])
  })

  it('a WhatsApp-permitted manager re-points the member Mia acts for, pauses Mia and resolves the thread', async () => {
    expect(await asUser(MANAGER_A,
      `UPDATE public.whatsapp_conversations
          SET agent_verified_contact_id = '${C_OTHER}', agent_verified_at = now(), agent_verify_attempts = 0,
              agent_paused_at = now(), resolved_at = now(), is_blocked = true
        WHERE id = '${CONV_A}' RETURNING id`)).toEqual([{ id: CONV_A }])
  })

  it('…deletes a thread (its messages cascade) and bumps unread through the INVOKER RPC', async () => {
    expect(await asUser(MANAGER_A, `DELETE FROM public.whatsapp_conversations WHERE id = '${CONV_A}' RETURNING id`))
      .toEqual([{ id: CONV_A }])
    expect(await asUser(MANAGER_A,
      `SELECT public.increment_whatsapp_conversation_unread('${CONV_A}')`,
      `SELECT unread_count FROM public.whatsapp_conversations WHERE id = '${CONV_A}'`)).toEqual([{ unread_count: 2 }])
  })

  it('a plain staff member WITHOUT the WhatsApp permission inserts a due scheduled broadcast (the cron would send it)', async () => {
    expect(await asUser(STAFF_A,
      `INSERT INTO public.whatsapp_broadcasts (location_id, name, template_id, status, scheduled_at)
       VALUES ('${LOC_A}', 'forged', '${TPL}', 'scheduled', now() - interval '1 minute') RETURNING status`))
      .toEqual([{ status: 'scheduled' }])
  })

  it('…marks a pending recipient as already sent (the drip skips them) and deletes another', async () => {
    expect(await asUser(STAFF_A,
      `UPDATE public.whatsapp_broadcast_recipients SET status = 'sent' WHERE id = '${R_PENDING}' RETURNING id`))
      .toEqual([{ id: R_PENDING }])
    expect(await asUser(STAFF_A,
      `DELETE FROM public.whatsapp_broadcast_recipients WHERE id = '${R_SENT}' RETURNING id`)).toEqual([{ id: R_SENT }])
  })

  it('the same plain staff member sees no conversation (wa_conv_select needs the permission)', async () => {
    expect(await asUser(STAFF_A, 'SELECT count(*)::int AS n FROM public.whatsapp_conversations')).toEqual([{ n: 0 }])
  })
})

describe('after 661 — the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each(TABLES)('anon, authenticated and public hold no write privilege (MAINTAIN included) on %s', async (t) => {
    for (const role of ['anon', 'authenticated', 'public']) {
      for (const p of WRITE_PRIVS) {
        const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, $2, $3) AS held`, [role, `public.${t}`, p])
        expect(r.held, `${role} ${p} ${t}`).toBe(false)
      }
    }
  })

  it.each(TABLES)('%s: no column-level write; SELECT unchanged; service_role still reads and writes', async (t) => {
    const rel = `public.${t}`
    const { rows: [r] } = await db.query(`SELECT
      has_any_column_privilege('authenticated', $1, 'INSERT') OR has_any_column_privilege('authenticated', $1, 'UPDATE')
        OR has_any_column_privilege('authenticated', $1, 'REFERENCES') AS a_col,
      has_any_column_privilege('anon', $1, 'INSERT') OR has_any_column_privilege('anon', $1, 'UPDATE') AS n_col,
      has_table_privilege('authenticated', $1, 'SELECT') AS a_sel,
      has_table_privilege('anon', $1, 'SELECT') AS n_sel,
      has_table_privilege('service_role', $1, 'INSERT') AND has_table_privilege('service_role', $1, 'UPDATE')
        AND has_table_privilege('service_role', $1, 'DELETE') AS svc`, [rel])
    expect(r).toEqual({ a_col: false, n_col: false, a_sel: true, n_sel: true, svc: true })
    expect(await clientAcl(t)).toEqual([
      { grantee: 'anon', privs: 'SELECT' },
      { grantee: 'authenticated', privs: 'SELECT' },
    ])
  })

  it('exactly one SELECT policy per table, TO authenticated', async () => {
    expect((await policies()).map(({ qual: _qual, ...p }) => p)).toEqual([
      { tablename: RC, policyname: 'whatsapp_broadcast_recipients_select', permissive: 'PERMISSIVE', cmd: 'SELECT', roles: '{authenticated}' },
      { tablename: BC, policyname: 'whatsapp_broadcasts_select', permissive: 'PERMISSIVE', cmd: 'SELECT', roles: '{authenticated}' },
      { tablename: CONV, policyname: 'wa_conv_select', permissive: 'PERMISSIVE', cmd: 'SELECT', roles: '{authenticated}' },
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

describe('after 661 — people', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each([['manager', MANAGER_A], ['master', MASTER], ['plain staff', STAFF_A]])(
    '%s: INSERT, UPDATE, UPSERT, DELETE, TRUNCATE and LOCK are refused on every table', async (_l, uid) => {
      await expect(asUser(uid, `INSERT INTO public.whatsapp_conversations (location_id, wa_phone) VALUES ('${LOC_A}', 'x')`))
        .rejects.toThrow(denied(CONV))
      await expect(asUser(uid, `UPDATE public.whatsapp_conversations SET agent_verified_contact_id = '${C_OTHER}' WHERE id = '${CONV_A}'`))
        .rejects.toThrow(denied(CONV))
      await expect(asUser(uid, `DELETE FROM public.whatsapp_conversations WHERE id = '${CONV_A}'`)).rejects.toThrow(denied(CONV))
      await expect(asUser(uid, `INSERT INTO public.whatsapp_broadcasts (location_id, name, template_id, status, scheduled_at)
        VALUES ('${LOC_A}', 'forged', '${TPL}', 'scheduled', now())`)).rejects.toThrow(denied(BC))
      await expect(asUser(uid, `INSERT INTO public.whatsapp_broadcasts (id, location_id, name) VALUES ('${BC_A}', '${LOC_A}', 'x')
        ON CONFLICT (id) DO UPDATE SET status = 'scheduled'`)).rejects.toThrow(denied(BC))
      await expect(asUser(uid, `UPDATE public.whatsapp_broadcasts SET status = 'scheduled' WHERE id = '${BC_A}'`)).rejects.toThrow(denied(BC))
      await expect(asUser(uid, `DELETE FROM public.whatsapp_broadcasts WHERE id = '${BC_A}'`)).rejects.toThrow(denied(BC))
      await expect(asUser(uid, `UPDATE public.whatsapp_broadcast_recipients SET status = 'sent' WHERE id = '${R_PENDING}'`))
        .rejects.toThrow(denied(RC))
      await expect(asUser(uid, `INSERT INTO public.whatsapp_broadcast_recipients (broadcast_id, contact_id) VALUES ('${BC_A}', '${C_OTHER}')`))
        .rejects.toThrow(denied(RC))
      await expect(asUser(uid, `DELETE FROM public.whatsapp_broadcast_recipients WHERE id = '${R_SENT}'`)).rejects.toThrow(denied(RC))
      for (const t of TABLES) {
        await expect(asUser(uid, `TRUNCATE public.${t} CASCADE`)).rejects.toThrow(/permission denied/)
        await expect(asUser(uid, `LOCK TABLE public.${t} IN ACCESS EXCLUSIVE MODE`)).rejects.toThrow(denied(t))
      }
    })

  it('manager: the counter RPC is refused (it writes as the caller)', async () => {
    await expect(asUser(MANAGER_A, `SELECT public.increment_whatsapp_conversation_unread('${CONV_A}')`)).rejects.toThrow(denied(CONV))
    await expect(asUser(MANAGER_A, `SELECT public.increment_whatsapp_broadcast_metric('${BC_A}', 'total_sent')`)).rejects.toThrow(denied(BC))
  })

  it("manager: the phone's list, the dashboard's 'my unread' and realtime's SELECT return the same rows", async () => {
    expect((await asUser(MANAGER_A, PHONE_LIST_SQL)).map((r) => r.id)).toEqual([CONV_A])
    expect(await asUser(MANAGER_A, MY_UNREAD_SQL)).toEqual([{ id: CONV_A, unread_count: 1 }])
    expect(await asUser(MANAGER_A, 'SELECT count(*)::int AS n FROM public.whatsapp_conversations')).toEqual([{ n: 1 }])
  })

  it('plain staff: broadcast and recipient reads unchanged (policy expression unchanged)', async () => {
    expect(await asUser(STAFF_A, 'SELECT id FROM public.whatsapp_broadcasts ORDER BY id')).toEqual([{ id: BC_A }])
    expect(await asUser(STAFF_A, 'SELECT count(*)::int AS n FROM public.whatsapp_broadcast_recipients')).toEqual([{ n: 2 }])
    expect(await asUser(STAFF_A, 'SELECT count(*)::int AS n FROM public.whatsapp_conversations')).toEqual([{ n: 0 }])
  })

  it('service_role: the inbox, webhook and broadcast paths still write; a thread delete still cascades', async () => {
    const rows = await asRole('service_role',
      `INSERT INTO public.whatsapp_conversations (location_id, contact_id, wa_phone) VALUES ('${LOC_A}', '${C_OTHER}', 'synthetic-3')`,
      `UPDATE public.whatsapp_conversations SET agent_paused_at = now(), resolved_at = now(), unread_count = 0 WHERE id = '${CONV_B}'`,
      `SELECT public.increment_whatsapp_conversation_unread('${CONV_A}')`,
      `SELECT public.increment_whatsapp_broadcast_metric('${BC_A}', 'total_sent')`,
      `INSERT INTO public.whatsapp_broadcasts (location_id, name, template_id) VALUES ('${LOC_A}', 'Synth draft', '${TPL}')`,
      `INSERT INTO public.whatsapp_broadcast_recipients (broadcast_id, contact_id) VALUES ('${BC_B}', '${C_A}')`,
      `UPDATE public.whatsapp_broadcast_recipients SET status = 'delivered' WHERE id = '${R_SENT}'`,
      `DELETE FROM public.whatsapp_conversations WHERE id = '${CONV_A}'`,
      `SELECT (SELECT total_sent FROM public.whatsapp_broadcasts WHERE id = '${BC_A}') AS sent,
              (SELECT count(*)::int FROM public.whatsapp_conversations) AS convs,
              (SELECT count(*)::int FROM public.whatsapp_messages WHERE conversation_id = '${CONV_A}') AS msgs,
              (SELECT count(*)::int FROM public.whatsapp_broadcasts) AS bcs,
              (SELECT count(*)::int FROM public.whatsapp_broadcast_recipients) AS recips`)
    expect(rows).toEqual([{ sent: 2, convs: 2, msgs: 0, bcs: 3, recips: 3 }])
  })

  it('anon: a write is refused by the grant itself; a read is an empty set (no anon policy)', async () => {
    for (const t of TABLES) {
      await expect(asRole('anon', `DELETE FROM public.${t}`)).rejects.toThrow(denied(t))
      expect(await asRole('anon', `SELECT count(*)::int AS n FROM public.${t}`)).toEqual([{ n: 0 }])
    }
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, sql = MIG_661) {
    await boot({ before })
    await expect(runSql(sql)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    const names = (await policies()).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['wa_conv_update', 'whatsapp_broadcasts_location_scoped',
      'whatsapp_broadcast_recipients_via_broadcast']))
    expect((await clientAcl(BC)).find((r) => r.grantee === 'authenticated').privs).toContain('INSERT')
  }

  it("when another grantor's INSERT on conversations survives the REVOKE", () => expectAbort(
    `GRANT INSERT ON public.whatsapp_conversations TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT INSERT ON public.whatsapp_conversations TO authenticated; RESET ROLE;`,
    /mig 661: anon\/authenticated\/PUBLIC still hold write privileges on public\.whatsapp_conversations: authenticated:INSERT/,
  ), 60_000)

  it('when UPDATE on broadcasts is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT UPDATE ON public.whatsapp_broadcasts TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 661: authenticated still holds UPDATE on public\.whatsapp_broadcasts/,
  ), 60_000)

  it('when a write policy the file does not know about is left on recipients', () => expectAbort(
    `CREATE POLICY recips_update_own ON public.whatsapp_broadcast_recipients FOR UPDATE TO authenticated
       USING (true) WITH CHECK (true);`,
    /mig 661: write policies remain on public\.whatsapp_broadcast_recipients: recips_update_own UPDATE/,
  ), 60_000)

  it('when an extra read policy sits on broadcasts', () => expectAbort(
    `CREATE POLICY bc_read_all ON public.whatsapp_broadcasts FOR SELECT TO authenticated USING (true);`,
    /mig 661: public\.whatsapp_broadcasts should keep exactly one policy, whatsapp_broadcasts_select FOR SELECT/,
  ), 60_000)

  it('when the new broadcasts SELECT policy would read different rows (self-check 6)', () => {
    const NEEDLE = 'USING (private.auth_is_in_location(location_id));'
    expect(MIG_661.split(NEEDLE).length).toBe(2)   // exactly one occurrence: the broadcasts policy
    return expectAbort('', /mig 661: whatsapp_broadcasts_select does not read the same rows as the policy it replaces/,
      MIG_661.replace(NEEDLE, 'USING (location_id IS NOT NULL);'))
  }, 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_661)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the 29 Sep grants and policies exactly (and so the hole)', async () => {
    await boot()
    const aclBefore = await Promise.all(TABLES.map(clientAcl))
    const policiesBefore = await policies()
    await runSql(MIG_661)
    await runSql(ROLLBACK_661)
    expect(await Promise.all(TABLES.map(clientAcl))).toEqual(aclBefore)
    expect(await policies()).toEqual(policiesBefore)
    expect(await asUser(STAFF_A, `UPDATE public.whatsapp_broadcasts SET status = 'scheduled' WHERE id = '${BC_A}' RETURNING id`))
      .toEqual([{ id: BC_A }])
  }, 60_000)
})
