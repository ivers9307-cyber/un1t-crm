// WAMSGCLIENTWRITE.1 — behavioural test for migration 656.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite with Supabase's DEFAULT PRIVILEGES (every table in
// public gets ALL for anon, authenticated and service_role — the source of
// whatsapp_messages' arwdDxtm), whatsapp_messages in PROD column order (27
// columns, 29 Sep 2026), the four live policies verbatim, the verbatim INVOKER
// timeline trigger, contacts in its post-653 state (clients read only), and
// whatsapp_conversations with the live ON DELETE CASCADE. private.auth_mobile_can
// is a STAND-IN (prod: permission bundles + per-location permissions JSON):
// "active member at the location with a synthetic whatsapp grant". It proves:
//
//   * BEFORE: a manager with the WhatsApp permission rewrites a customer's
//     inbound message, inserts a forged one (no contact: the trigger returns
//     early) and deletes one — all from their own session;
//   * AFTER: every write refused for anon and authenticated (masters too); one
//     SELECT policy left; the inbox's read shapes return the same rows; a
//     conversation delete still cascades (RI runs as the table owner); the
//     service role's insert still fires the timeline trigger;
//   * the self-check aborts the WHOLE file on another grantor's grant, an
//     inherited grant and a leftover write policy; a second run passes; the
//     plan's rollback record restores the before-state exactly.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_656 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/656_whatsapp_messages_client_writes_off.sql'), 'utf8')

// The rollback record from the C55 plan (Task 5 Step 7), verbatim.
const ROLLBACK_656 = `
BEGIN;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.whatsapp_messages TO anon, authenticated;
CREATE POLICY wa_msg_insert ON public.whatsapp_messages FOR INSERT TO authenticated
  WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
CREATE POLICY wa_msg_update ON public.whatsapp_messages FOR UPDATE TO authenticated
  USING (private.auth_mobile_can(location_id, 'whatsapp'::text))
  WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
CREATE POLICY wa_msg_delete ON public.whatsapp_messages FOR DELETE TO authenticated
  USING (private.auth_is_manager_at(location_id));
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const MANAGER_A = '10000000-0000-0000-0000-000000000001' // manager at A, WhatsApp permission
const STAFF_A = '10000000-0000-0000-0000-000000000002'   // plain staff at A, no permission
const MASTER = '10000000-0000-0000-0000-000000000003'
const C_A = '30000000-0000-0000-0000-000000000001'
const CONV_A = '50000000-0000-0000-0000-000000000001'
const CONV_B = '50000000-0000-0000-0000-000000000002'
const M_IN = '60000000-0000-0000-0000-000000000001'      // inbound, customer's words
const M_OUT = '60000000-0000-0000-0000-000000000002'
const M_B = '60000000-0000-0000-0000-000000000003'       // studio B

const DENIED = /permission denied for (table|relation) whatsapp_messages/
const WRITE_PRIVS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

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

  CREATE TABLE public.contacts (
    id uuid PRIMARY KEY, name text, location_id uuid,
    total_wa_sent integer NOT NULL DEFAULT 0, total_wa_received integer NOT NULL DEFAULT 0,
    last_wa_message_at timestamptz
  );
  -- mig 653 (applied before this one in prod): contacts is read-only for clients.
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.contacts FROM anon, authenticated, PUBLIC;
  CREATE TABLE public.activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, type text, subject text, note text,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.whatsapp_conversations (id uuid PRIMARY KEY, location_id uuid, contact_id uuid);

  -- whatsapp_messages: PROD column order and defaults (pg_attribute, 29 Sep 2026).
  CREATE TABLE public.whatsapp_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
    contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
    location_id uuid,
    wa_message_id text,
    direction text NOT NULL,
    message_type text DEFAULT 'text',
    body text, media_url text, media_mime_type text, template_name text, template_variables jsonb,
    status text DEFAULT 'pending', error_code text, error_message text,
    sent_by uuid,
    sent_at timestamptz DEFAULT now(), delivered_at timestamptz, read_at timestamptz,
    broadcast_id uuid,
    created_at timestamptz DEFAULT now(),
    source text NOT NULL DEFAULT 'api',
    media_external_id text, media_storage_path text,
    pricing_category text, pricing_type text, billable boolean
  );

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

  -- log_wa_message_to_timeline, verbatim (INVOKER, owner postgres, search_path '').
  CREATE FUNCTION public.log_wa_message_to_timeline() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
  BEGIN
    IF NEW.contact_id IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.direction = 'outbound' THEN
      INSERT INTO public.activities (contact_id, type, subject, note, created_at)
      VALUES (NEW.contact_id, 'whatsapp_sent', 'WhatsApp sent',
        COALESCE('WhatsApp: ' || LEFT(NEW.body, 100), 'WhatsApp template: ' || NEW.template_name),
        NEW.created_at);
      UPDATE public.contacts SET last_wa_message_at = NEW.sent_at, total_wa_sent = total_wa_sent + 1
      WHERE id = NEW.contact_id;
    ELSIF NEW.direction = 'inbound' THEN
      INSERT INTO public.activities (contact_id, type, subject, note, created_at)
      VALUES (NEW.contact_id, 'whatsapp_received', 'WhatsApp received',
        'WhatsApp: ' || LEFT(NEW.body, 100), NEW.created_at);
      UPDATE public.contacts SET last_wa_message_at = NEW.sent_at, total_wa_received = total_wa_received + 1
      WHERE id = NEW.contact_id;
    END IF;
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER trg_wa_message_timeline AFTER INSERT ON public.whatsapp_messages
    FOR EACH ROW EXECUTE FUNCTION public.log_wa_message_to_timeline();

  -- Live: whatsapp_messages is one of the 10 tables in supabase_realtime.
  CREATE PUBLICATION supabase_realtime FOR TABLE public.whatsapp_messages, public.whatsapp_conversations;
`

const PROD_POLICIES = `
  ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
  CREATE POLICY wa_msg_select ON public.whatsapp_messages FOR SELECT TO authenticated
    USING (private.auth_mobile_can(location_id, 'whatsapp'::text));
  CREATE POLICY wa_msg_insert ON public.whatsapp_messages FOR INSERT TO authenticated
    WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
  CREATE POLICY wa_msg_update ON public.whatsapp_messages FOR UPDATE TO authenticated
    USING (private.auth_mobile_can(location_id, 'whatsapp'::text))
    WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
  CREATE POLICY wa_msg_delete ON public.whatsapp_messages FOR DELETE TO authenticated
    USING (private.auth_is_manager_at(location_id));

  ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY wa_conv_select ON public.whatsapp_conversations FOR SELECT TO authenticated
    USING (private.auth_mobile_can(location_id, 'whatsapp'::text));
  CREATE POLICY wa_conv_delete ON public.whatsapp_conversations FOR DELETE TO authenticated
    USING (private.auth_is_manager_at(location_id));

  ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public
    USING (private.auth_is_in_location(location_id));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles (id, role) VALUES ('${MANAGER_A}', 'staff'), ('${STAFF_A}', 'staff'), ('${MASTER}', 'master');
  INSERT INTO public.profile_locations VALUES ('${MANAGER_A}', '${LOC_A}', 'manager'), ('${STAFF_A}', '${LOC_A}', 'staff');
  INSERT INTO private.synth_whatsapp_perm VALUES ('${MANAGER_A}', '${LOC_A}');
  INSERT INTO public.contacts (id, name, location_id) VALUES ('${C_A}', 'Synth Customer', '${LOC_A}');
  INSERT INTO public.whatsapp_conversations VALUES ('${CONV_A}', '${LOC_A}', '${C_A}'), ('${CONV_B}', '${LOC_B}', NULL);
  INSERT INTO public.whatsapp_messages (id, conversation_id, contact_id, location_id, direction, body, status, created_at) VALUES
    ('${M_IN}', '${CONV_A}', '${C_A}', '${LOC_A}', 'inbound', 'synthetic inbound', 'received', '2026-09-01'),
    ('${M_OUT}', '${CONV_A}', '${C_A}', '${LOC_A}', 'outbound', 'synthetic reply', 'delivered', '2026-09-02'),
    ('${M_B}', '${CONV_B}', NULL, '${LOC_B}', 'inbound', 'synthetic elsewhere', 'received', '2026-09-03');
`

// The old phone bundle's direct thread read (3eeef77e, mobile/lib/whatsapp-api.js listMessages)
// and the row a realtime INSERT event is authorised through (wa_msg_select).
const THREAD_READ_SQL = `
  SELECT id, direction, message_type, body, media_url, media_mime_type, status, sent_at, delivered_at,
         read_at, sent_by, template_name, created_at
    FROM public.whatsapp_messages WHERE conversation_id = '${CONV_A}' ORDER BY created_at ASC LIMIT 50`

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
    `SELECT policyname, cmd, roles::text AS roles FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'whatsapp_messages' ORDER BY policyname`)
  return rows
}

async function clientAcl() {
  const { rows } = await db.query(`
    SELECT r.rolname AS grantee, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privs
      FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = 'public.whatsapp_messages'::regclass)) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE r.rolname IN ('anon', 'authenticated')
     GROUP BY r.rolname ORDER BY r.rolname`)
  return rows
}

async function boot({ migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_656)
}

describe('before 656 — the hole (prod on 29 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('the default privileges gave both client roles every table privilege (arwdDxtm, PG 17)', async () => {
    expect(await clientAcl()).toEqual([
      { grantee: 'anon', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
      { grantee: 'authenticated', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
    ])
  })

  it("a manager with the WhatsApp permission rewrites a customer's inbound message", async () => {
    expect(await asUser(MANAGER_A,
      `UPDATE public.whatsapp_messages SET body = 'forged', direction = 'outbound', billable = false WHERE id = '${M_IN}' RETURNING id`))
      .toEqual([{ id: M_IN }])
  })

  it('…inserts a forged message (no contact: the timeline trigger returns early) and deletes one', async () => {
    expect(await asUser(MANAGER_A, `INSERT INTO public.whatsapp_messages (conversation_id, location_id, direction, body)
      VALUES ('${CONV_A}', '${LOC_A}', 'inbound', 'forged') RETURNING location_id`)).toEqual([{ location_id: LOC_A }])
    expect(await asUser(MANAGER_A, `DELETE FROM public.whatsapp_messages WHERE id = '${M_OUT}' RETURNING id`)).toEqual([{ id: M_OUT }])
  })

  it('a direct insert WITH a contact already fails in the INVOKER trigger (mig 653 made contacts read-only)', async () => {
    await expect(asUser(MANAGER_A, `INSERT INTO public.whatsapp_messages (conversation_id, contact_id, location_id, direction, body)
      VALUES ('${CONV_A}', '${C_A}', '${LOC_A}', 'outbound', 'x')`)).rejects.toThrow(/permission denied for (table|relation) contacts/)
  })

  it('a plain staff member (no WhatsApp permission) sees and changes nothing', async () => {
    expect(await asUser(STAFF_A, `UPDATE public.whatsapp_messages SET body = 'x' RETURNING id`)).toEqual([])
  })
})

describe('after 656 — the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each(['anon', 'authenticated', 'public'])('%s holds no write privilege on whatsapp_messages', async (role) => {
    for (const p of WRITE_PRIVS) {
      const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, 'public.whatsapp_messages', $2) AS held`, [role, p])
      expect(r.held, `${role} ${p}`).toBe(false)
    }
  })

  it('no column-level write privilege; SELECT unchanged; service_role still inserts and updates', async () => {
    const { rows: [r] } = await db.query(`SELECT
      has_any_column_privilege('authenticated', 'public.whatsapp_messages', 'INSERT,UPDATE,REFERENCES') AS a_col,
      has_any_column_privilege('anon', 'public.whatsapp_messages', 'INSERT,UPDATE,REFERENCES') AS n_col,
      has_table_privilege('authenticated', 'public.whatsapp_messages', 'SELECT') AS a_sel,
      has_table_privilege('anon', 'public.whatsapp_messages', 'SELECT') AS n_sel,
      has_table_privilege('service_role', 'public.whatsapp_messages', 'INSERT') AS svc_ins,
      has_table_privilege('service_role', 'public.whatsapp_messages', 'UPDATE') AS svc_upd`)
    expect(r).toEqual({ a_col: false, n_col: false, a_sel: true, n_sel: true, svc_ins: true, svc_upd: true })
    expect(await clientAcl()).toEqual([
      { grantee: 'anon', privs: 'MAINTAIN,SELECT' },
      { grantee: 'authenticated', privs: 'MAINTAIN,SELECT' },
    ])
  })

  it('exactly one policy is left: wa_msg_select, FOR SELECT, unchanged', async () => {
    expect(await policies()).toEqual([{ policyname: 'wa_msg_select', cmd: 'SELECT', roles: '{authenticated}' }])
  })

  it('per privilege, the client roles hold exactly SELECT + MAINTAIN (MAINTAIN kept by design: no data write)', async () => {
    const held = []
    for (const role of ['anon', 'authenticated', 'public']) {
      for (const p of ['SELECT', ...WRITE_PRIVS, 'MAINTAIN']) {
        const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, 'public.whatsapp_messages', $2) AS held`, [role, p])
        if (r.held) held.push(`${role}:${p}`)
      }
    }
    expect(held).toEqual(['anon:SELECT', 'anon:MAINTAIN', 'authenticated:SELECT', 'authenticated:MAINTAIN'])
  })

  it('the table stays in the realtime publication and keeps its INVOKER timeline trigger', async () => {
    const { rows: [r] } = await db.query(`SELECT
      (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.whatsapp_messages'::regclass AND NOT tgisinternal) AS triggers,
      (SELECT prosecdef FROM pg_proc WHERE oid = 'public.log_wa_message_to_timeline()'::regprocedure) AS definer,
      EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
                AND schemaname = 'public' AND tablename = 'whatsapp_messages') AS published`)
    expect(r).toEqual({ triggers: 1, definer: false, published: true })
  })

  it('takes a short lock_timeout inside its transaction, before the first DDL (the webhook writes this table)', () => {
    const begin = MIG_656.search(/^BEGIN;$/m)
    const lock = MIG_656.search(/^SET LOCAL lock_timeout = '5s';$/m)
    const firstDdl = MIG_656.search(/^(DROP|CREATE|REVOKE|ALTER|GRANT) /m)
    expect(begin).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(begin)
    expect(firstDdl).toBeGreaterThan(lock)
  })
})

describe('after 656 — people', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each([['manager', MANAGER_A], ['master', MASTER]])('%s: INSERT, UPDATE, UPSERT, DELETE and TRUNCATE are refused', async (_l, uid) => {
    await expect(asUser(uid, `INSERT INTO public.whatsapp_messages (conversation_id, location_id, direction, body)
      VALUES ('${CONV_A}', '${LOC_A}', 'inbound', 'forged')`)).rejects.toThrow(DENIED)
    await expect(asUser(uid, `UPDATE public.whatsapp_messages SET body = 'forged' WHERE id = '${M_IN}'`)).rejects.toThrow(DENIED)
    await expect(asUser(uid, `INSERT INTO public.whatsapp_messages (id, conversation_id, location_id, direction)
      VALUES ('${M_IN}', '${CONV_A}', '${LOC_A}', 'inbound') ON CONFLICT (id) DO UPDATE SET body = 'x'`)).rejects.toThrow(DENIED)
    await expect(asUser(uid, `DELETE FROM public.whatsapp_messages WHERE id = '${M_OUT}'`)).rejects.toThrow(DENIED)
    await expect(asUser(uid, 'TRUNCATE public.whatsapp_messages')).rejects.toThrow(DENIED)
  })

  it("manager: the thread read (and so realtime's SELECT authorisation) returns the same rows", async () => {
    expect((await asUser(MANAGER_A, THREAD_READ_SQL)).map((r) => r.id)).toEqual([M_IN, M_OUT])
    expect(await asUser(MANAGER_A, 'SELECT count(*)::int AS n FROM public.whatsapp_messages')).toEqual([{ n: 2 }])
  })

  it('plain staff: still reads nothing (policy unchanged)', async () => {
    expect(await asUser(STAFF_A, 'SELECT count(*)::int AS n FROM public.whatsapp_messages')).toEqual([{ n: 0 }])
  })

  it("manager: deleting a conversation still cascades to its messages (RI runs as the table's owner)", async () => {
    const rows = await asUser(MANAGER_A,
      `DELETE FROM public.whatsapp_conversations WHERE id = '${CONV_A}'`,
      `SELECT count(*)::int AS n FROM public.whatsapp_messages WHERE conversation_id = '${CONV_A}'`)
    expect(rows).toEqual([{ n: 0 }])
  })

  it('service_role: an inbound insert still fires the timeline trigger; a status update still lands', async () => {
    const rows = await asRole('service_role',
      `INSERT INTO public.whatsapp_messages (conversation_id, contact_id, location_id, direction, body)
         VALUES ('${CONV_A}', '${C_A}', '${LOC_A}', 'inbound', 'synthetic')`,
      `UPDATE public.whatsapp_messages SET status = 'read' WHERE id = '${M_OUT}'`,
      `SELECT (SELECT total_wa_received FROM public.contacts WHERE id = '${C_A}') AS recv,
              (SELECT status FROM public.whatsapp_messages WHERE id = '${M_OUT}') AS st,
              (SELECT count(*)::int FROM public.activities WHERE contact_id = '${C_A}') AS acts`)
    // SEED's two messages (inserted as the superuser) already fired the trigger
    // once each: received 1 → 2, activities 2 → 3.
    expect(rows).toEqual([{ recv: 2, st: 'read', acts: 3 }])
  })

  it('anon: a write is refused by the grant itself; a read is an empty set (no anon policy)', async () => {
    await expect(asRole('anon', `UPDATE public.whatsapp_messages SET body = body`)).rejects.toThrow(DENIED)
    expect(await asRole('anon', 'SELECT count(*)::int AS n FROM public.whatsapp_messages')).toEqual([{ n: 0 }])
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message) {
    await boot({ before })
    await expect(runSql(MIG_656)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    expect((await policies()).map((p) => p.policyname))
      .toEqual(expect.arrayContaining(['wa_msg_delete', 'wa_msg_insert', 'wa_msg_select', 'wa_msg_update']))
    expect((await clientAcl()).find((r) => r.grantee === 'authenticated').privs).toContain('INSERT')
  }

  it("when another grantor's INSERT grant survives the REVOKE", () => expectAbort(
    `GRANT INSERT ON public.whatsapp_messages TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT INSERT ON public.whatsapp_messages TO authenticated; RESET ROLE;`,
    /mig 656: anon\/authenticated\/PUBLIC still hold write privileges on public\.whatsapp_messages: authenticated:INSERT/,
  ), 60_000)

  it('when UPDATE is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT UPDATE ON public.whatsapp_messages TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 656: authenticated still holds UPDATE on public\.whatsapp_messages/,
  ), 60_000)

  it('when a write policy the file does not know about is left', () => expectAbort(
    `CREATE POLICY wa_msg_update_own ON public.whatsapp_messages FOR UPDATE TO authenticated
       USING (sent_by = (SELECT auth.uid())) WITH CHECK (sent_by = (SELECT auth.uid()));`,
    /mig 656: write policies remain on public\.whatsapp_messages: wa_msg_update_own UPDATE/,
  ), 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_656)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the 29 Sep grants and policies exactly (and so the hole)', async () => {
    await boot()
    const aclBefore = await clientAcl()
    const policiesBefore = await policies()
    await runSql(MIG_656)
    await runSql(ROLLBACK_656)
    expect(await clientAcl()).toEqual(aclBefore)
    expect(await policies()).toEqual(policiesBefore)
    expect(await asUser(MANAGER_A, `UPDATE public.whatsapp_messages SET body = 'x' WHERE id = '${M_IN}' RETURNING id`))
      .toEqual([{ id: M_IN }])
  }, 60_000)
})
