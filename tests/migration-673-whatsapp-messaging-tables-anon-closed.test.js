// WAANONREAD.1 — behavioural test for migration 673.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) with Supabase's DEFAULT PRIVILEGES
// (every table in public gets ALL for anon, authenticated and service_role),
// the four WhatsApp tables (a column subset: ids, location, the FKs that
// cascade) put into their LIVE post-656/661 state by the same REVOKE
// statements those migrations ran, the four live SELECT policies verbatim,
// the supabase_realtime publication with the two tables prod publishes, and
// one counter RPC with the post-667 EXECUTE. private.auth_is_in_location is
// verbatim; private.auth_mobile_can is a STAND-IN (prod: permission bundles):
// "active member at the location with a synthetic whatsapp grant". It proves:
//
//   * BEFORE: the modelled ACLs equal prod's (30 Sep): anon=r (anon=rm on
//     whatsapp_messages); anon reads an EMPTY set (no anon policy), so the
//     grant fences nothing;
//   * AFTER: anon and PUBLIC hold nothing (all eight privileges, column level
//     too); a signed-out read is 42501; authenticated's privileges, every
//     policy, the publication and RLS are exactly as before; a WhatsApp-
//     permitted manager, a plain staff member and the service role see and do
//     exactly what they did;
//   * the self-check aborts the WHOLE file on another grantor's anon grant, an
//     anon grant inherited through a role, a policy that admits anon, an
//     anon-open policy elsewhere that reads the tables, an anon-executable
//     function that names them, a file that also changes authenticated, a
//     policy or the publication, and the pre-656 state; a second run passes;
//     the plan's rollback record restores the before-state exactly.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_673 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/673_whatsapp_messaging_tables_anon_closed.sql'), 'utf8')

// The rollback record from the C91 plan (Task 5 Step 7), verbatim.
const ROLLBACK_673 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT SELECT, MAINTAIN ON public.whatsapp_messages TO anon;
GRANT SELECT ON public.whatsapp_conversations, public.whatsapp_broadcasts, public.whatsapp_broadcast_recipients TO anon;
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const MANAGER_A = '10000000-0000-0000-0000-000000000001' // manager at A, WhatsApp permission
const STAFF_A = '10000000-0000-0000-0000-000000000002'   // plain staff at A, NO WhatsApp permission
const CONV_A = '50000000-0000-0000-0000-000000000001'
const CONV_B = '50000000-0000-0000-0000-000000000002'
const M_A = '60000000-0000-0000-0000-000000000001'
const M_B = '60000000-0000-0000-0000-000000000002'
const BC_A = '70000000-0000-0000-0000-000000000001'
const R_A = '80000000-0000-0000-0000-000000000001'

const MSG = 'whatsapp_messages'
const CONV = 'whatsapp_conversations'
const BC = 'whatsapp_broadcasts'
const RC = 'whatsapp_broadcast_recipients'
const TABLES = [RC, BC, CONV, MSG]
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
  -- A public table anon may read (the shape of a real anon policy), for the
  -- "anon-open policy elsewhere" abort case.
  CREATE TABLE public.public_things (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid);
  ALTER TABLE public.public_things ENABLE ROW LEVEL SECURITY;
  CREATE POLICY public_things_read ON public.public_things FOR SELECT TO anon, authenticated USING (true);

  -- The four tables: a column subset, the live keys and cascades.
  CREATE TABLE public.whatsapp_conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid REFERENCES public.locations(id),
    wa_phone text,
    unread_count integer DEFAULT 0,
    last_message_at timestamptz
  );
  CREATE TABLE public.whatsapp_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
    location_id uuid,
    direction text NOT NULL,
    body text,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.whatsapp_broadcasts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid REFERENCES public.locations(id),
    name text NOT NULL,
    status text DEFAULT 'draft',
    total_sent integer DEFAULT 0
  );
  CREATE TABLE public.whatsapp_broadcast_recipients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    broadcast_id uuid NOT NULL REFERENCES public.whatsapp_broadcasts(id) ON DELETE CASCADE,
    status text DEFAULT 'pending'
  );

  -- Helpers. auth_is_in_location verbatim (pg_proc, mig 626).
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations
               WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
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

  -- One of the four live functions that name the tables, verbatim, with its
  -- post-667 EXECUTE (postgres + service_role only).
  CREATE FUNCTION public.increment_whatsapp_conversation_unread(p_conversation_id uuid) RETURNS void
    LANGUAGE sql SET search_path = '' AS $$
    update public.whatsapp_conversations set unread_count = coalesce(unread_count,0) + 1 where id = p_conversation_id;
  $$;
  REVOKE EXECUTE ON FUNCTION public.increment_whatsapp_conversation_unread(uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.increment_whatsapp_conversation_unread(uuid) TO service_role;

  -- Realtime: prod publishes messages and conversations (30 Sep).
  CREATE PUBLICATION supabase_realtime;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_messages, public.whatsapp_conversations;
`

// The live state after migs 656 and 661 (applied 29 Sep), reached by the
// same statements those files ran, and the four live policies verbatim
// (pg_policies, 30 Sep).
const POST_656_661 = `
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.whatsapp_messages FROM anon, authenticated, PUBLIC;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
    ON public.whatsapp_conversations, public.whatsapp_broadcasts, public.whatsapp_broadcast_recipients
    FROM anon, authenticated, PUBLIC;

  ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
  CREATE POLICY wa_msg_select ON public.whatsapp_messages FOR SELECT TO authenticated
    USING (private.auth_mobile_can(location_id, 'whatsapp'::text));
  ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY wa_conv_select ON public.whatsapp_conversations FOR SELECT TO authenticated
    USING (private.auth_mobile_can(location_id, 'whatsapp'::text));
  ALTER TABLE public.whatsapp_broadcasts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY whatsapp_broadcasts_select ON public.whatsapp_broadcasts FOR SELECT TO authenticated
    USING (private.auth_is_in_location(location_id));
  ALTER TABLE public.whatsapp_broadcast_recipients ENABLE ROW LEVEL SECURITY;
  CREATE POLICY whatsapp_broadcast_recipients_select ON public.whatsapp_broadcast_recipients FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.whatsapp_broadcasts b
                    WHERE b.id = whatsapp_broadcast_recipients.broadcast_id AND private.auth_is_in_location(b.location_id)));
`

// The pre-656 write policy shape, for the "apply 656 and 661 first" case.
const PRE_656 = `
  GRANT INSERT, UPDATE, DELETE ON public.whatsapp_messages TO authenticated;
  CREATE POLICY wa_msg_update ON public.whatsapp_messages FOR UPDATE TO authenticated
    USING (private.auth_mobile_can(location_id, 'whatsapp'::text))
    WITH CHECK (private.auth_mobile_can(location_id, 'whatsapp'::text));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles (id, role) VALUES ('${MANAGER_A}', 'staff'), ('${STAFF_A}', 'staff');
  INSERT INTO public.profile_locations VALUES ('${MANAGER_A}', '${LOC_A}', 'manager'), ('${STAFF_A}', '${LOC_A}', 'staff');
  INSERT INTO private.synth_whatsapp_perm VALUES ('${MANAGER_A}', '${LOC_A}');
  INSERT INTO public.whatsapp_conversations (id, location_id, wa_phone, unread_count, last_message_at) VALUES
    ('${CONV_A}', '${LOC_A}', 'synthetic-1', 1, '2026-09-02'),
    ('${CONV_B}', '${LOC_B}', 'synthetic-2', 2, '2026-09-03');
  INSERT INTO public.whatsapp_messages (id, conversation_id, location_id, direction, body) VALUES
    ('${M_A}', '${CONV_A}', '${LOC_A}', 'inbound', 'synthetic'),
    ('${M_B}', '${CONV_B}', '${LOC_B}', 'inbound', 'synthetic');
  INSERT INTO public.whatsapp_broadcasts (id, location_id, name, status, total_sent) VALUES ('${BC_A}', '${LOC_A}', 'Synth A', 'sent', 1);
  INSERT INTO public.whatsapp_broadcast_recipients (id, broadcast_id, status) VALUES ('${R_A}', '${BC_A}', 'sent');
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

async function relacls() {
  const { rows } = await db.query(
    `SELECT relname, relacl::text AS acl FROM pg_class WHERE oid = ANY($1::regclass[]) ORDER BY relname`,
    [TABLES.map((t) => `public.${t}`)])
  return rows
}

/** Everything 673 must NOT move: authenticated/service_role privileges, policies, publication, RLS. */
async function untouched() {
  const privs = []
  for (const t of TABLES) {
    for (const r of ['authenticated', 'service_role']) {
      for (const p of ALL_PRIVS) {
        const { rows: [x] } = await db.query(`SELECT has_table_privilege($1, $2, $3) AS held`, [r, `public.${t}`, p])
        privs.push(`${t} ${r} ${p} ${x.held}`)
      }
    }
  }
  const { rows: policies } = await db.query(
    `SELECT tablename, policyname, permissive, cmd, roles::text AS roles, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY tablename, policyname`, [TABLES])
  const { rows: published } = await db.query(
    `SELECT pubname, tablename FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])
      ORDER BY 1, 2`, [TABLES])
  const { rows: rls } = await db.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ANY($1::regclass[]) ORDER BY 1`,
    [TABLES.map((t) => `public.${t}`)])
  return { privs, policies, published, rls }
}

async function boot({ migrate = false, before = '', post656 = true } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  if (post656) await runSql(POST_656_661)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_673)
}

const PROD_ACL_MSG = '{postgres=arwdDxtm/postgres,anon=rm/postgres,authenticated=rm/postgres,service_role=arwdDxtm/postgres}'
const PROD_ACL_R = '{postgres=arwdDxtm/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres}'

describe('before 673 — prod on 30 Sep 2026', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('the modelled ACLs are exactly the live ones (656 kept anon=rm, 661 kept anon=r)', async () => {
    expect(await relacls()).toEqual([
      { relname: RC, acl: PROD_ACL_R },
      { relname: BC, acl: PROD_ACL_R },
      { relname: CONV, acl: PROD_ACL_R },
      { relname: MSG, acl: PROD_ACL_MSG },
    ])
  })

  it.each(TABLES)('anon reads an EMPTY set from %s (no policy admits anon): the grant fences nothing', async (t) => {
    expect(await asRole('anon', `SELECT count(*)::int AS n FROM public.${t}`)).toEqual([{ n: 0 }])
  })
})

describe('after 673 — the catalog', () => {
  let before
  beforeAll(async () => {
    await boot()
    before = await untouched()
    await runSql(MIG_673)
  }, 60_000)
  afterAll(() => db?.close())

  it.each(TABLES)('anon and PUBLIC hold nothing on %s, table or column level', async (t) => {
    for (const role of ['anon', 'public']) {
      for (const p of ALL_PRIVS) {
        const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, $2, $3) AS held`, [role, `public.${t}`, p])
        expect(r.held, `${role} ${p} ${t}`).toBe(false)
      }
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
        const { rows: [r] } = await db.query(`SELECT has_any_column_privilege($1, $2, $3) AS held`, [role, `public.${t}`, p])
        expect(r.held, `${role} column ${p} ${t}`).toBe(false)
      }
    }
  })

  it('the ACLs lose exactly the anon entry', async () => {
    expect(await relacls()).toEqual([
      { relname: RC, acl: PROD_ACL_R.replace('anon=r/postgres,', '') },
      { relname: BC, acl: PROD_ACL_R.replace('anon=r/postgres,', '') },
      { relname: CONV, acl: PROD_ACL_R.replace('anon=r/postgres,', '') },
      { relname: MSG, acl: PROD_ACL_MSG.replace('anon=rm/postgres,', '') },
    ])
  })

  it('authenticated and service_role privileges, every policy, the publication and RLS are unchanged', async () => {
    expect(await untouched()).toEqual(before)
    // …and authenticated is still exactly what 656/661 left it.
    expect(before.privs.filter((p) => p.includes(' authenticated ') && p.endsWith(' true')).sort()).toEqual([
      `${RC} authenticated SELECT true`, `${BC} authenticated SELECT true`, `${CONV} authenticated SELECT true`,
      `${MSG} authenticated MAINTAIN true`, `${MSG} authenticated SELECT true`,
    ].sort())
    expect(before.published).toEqual([
      { pubname: 'supabase_realtime', tablename: CONV },
      { pubname: 'supabase_realtime', tablename: MSG },
    ])
  })

  it('the temporary snapshot objects are gone after commit', async () => {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('mig673_state', 'mig673_before')`)
    expect(rows).toEqual([{ n: 0 }])
  })
})

describe('after 673 — sessions', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each(TABLES)('anon: a read of %s is refused by the grant (42501), not an empty set', async (t) => {
    await expect(asRole('anon', `SELECT count(*) FROM public.${t}`)).rejects.toThrow(denied(t))
    await expect(asRole('anon', `SELECT id FROM public.${t} LIMIT 1`)).rejects.toThrow(denied(t))
    await expect(asRole('anon', `LOCK TABLE public.${t} IN ACCESS SHARE MODE`)).rejects.toThrow(denied(t))
  })

  it("manager with the WhatsApp permission: the phone's list, the inbox thread and realtime's SELECT read the same rows", async () => {
    expect(await asUser(MANAGER_A, 'SELECT id FROM public.whatsapp_conversations ORDER BY last_message_at DESC'))
      .toEqual([{ id: CONV_A }])
    expect(await asUser(MANAGER_A, `SELECT id FROM public.whatsapp_messages WHERE conversation_id = '${CONV_A}'`))
      .toEqual([{ id: M_A }])
    expect(await asUser(MANAGER_A, 'SELECT count(*)::int AS n FROM public.whatsapp_messages')).toEqual([{ n: 1 }])
  })

  it('plain staff: broadcasts and recipients read as before; conversations still hidden (no WhatsApp permission)', async () => {
    expect(await asUser(STAFF_A, 'SELECT id FROM public.whatsapp_broadcasts')).toEqual([{ id: BC_A }])
    expect(await asUser(STAFF_A, 'SELECT id FROM public.whatsapp_broadcast_recipients')).toEqual([{ id: R_A }])
    expect(await asUser(STAFF_A, 'SELECT count(*)::int AS n FROM public.whatsapp_conversations')).toEqual([{ n: 0 }])
  })

  it('authenticated still cannot write (656/661 unchanged)', async () => {
    await expect(asUser(MANAGER_A, `UPDATE public.whatsapp_messages SET body = 'x' WHERE id = '${M_A}'`)).rejects.toThrow(denied(MSG))
    await expect(asUser(MANAGER_A, `UPDATE public.whatsapp_conversations SET unread_count = 0 WHERE id = '${CONV_A}'`))
      .rejects.toThrow(denied(CONV))
  })

  it('service_role: the webhook, inbox, broadcast and cascade paths still work', async () => {
    const rows = await asRole('service_role',
      `INSERT INTO public.whatsapp_messages (conversation_id, location_id, direction, body) VALUES ('${CONV_A}', '${LOC_A}', 'outbound', 'synthetic')`,
      `SELECT public.increment_whatsapp_conversation_unread('${CONV_A}')`,
      `UPDATE public.whatsapp_broadcast_recipients SET status = 'delivered' WHERE id = '${R_A}'`,
      `DELETE FROM public.whatsapp_conversations WHERE id = '${CONV_B}'`,
      `SELECT (SELECT unread_count FROM public.whatsapp_conversations WHERE id = '${CONV_A}') AS unread,
              (SELECT count(*)::int FROM public.whatsapp_messages) AS msgs,
              (SELECT status FROM public.whatsapp_broadcast_recipients WHERE id = '${R_A}') AS rstatus`)
    expect(rows).toEqual([{ unread: 2, msgs: 2, rstatus: 'delivered' }])
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, sql = MIG_673, opts = {}) {
    await boot({ before, ...opts })
    const aclBefore = await relacls()
    await expect(runSql(sql)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    expect(await relacls()).toEqual(aclBefore)
  }

  it("when another grantor's anon SELECT survives the REVOKE", () => expectAbort(
    `GRANT SELECT ON public.whatsapp_broadcasts TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT SELECT ON public.whatsapp_broadcasts TO anon; RESET ROLE;`,
    /mig 673: anon\/PUBLIC still hold privileges on public\.whatsapp_broadcasts: anon:SELECT \(from other_grantor\)/,
  ), 60_000)

  it('when anon inherits SELECT through a role (information_schema and the ACL cannot see it)', () => expectAbort(
    `GRANT SELECT ON public.whatsapp_messages TO sneaky; GRANT sneaky TO anon;`,
    /mig 673: anon still holds SELECT on public\.whatsapp_messages/,
  ), 60_000)

  it('when a column-level anon grant from another grantor survives', () => expectAbort(
    `GRANT SELECT (id, body) ON public.whatsapp_messages TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT SELECT (id) ON public.whatsapp_messages TO anon; RESET ROLE;`,
    /mig 673: anon\/PUBLIC still hold privileges on public\.whatsapp_messages: anon:SELECT \(from other_grantor\)/,
  ), 60_000)

  it('when a policy on one of the four admits anon', () => expectAbort(
    `CREATE POLICY conv_public_peek ON public.whatsapp_conversations FOR SELECT TO anon USING (false);`,
    /mig 673: policies on public\.whatsapp_conversations admit anon or PUBLIC: conv_public_peek/,
  ), 60_000)

  it('when an anon-open policy on another table reads one of the four', () => expectAbort(
    `CREATE POLICY public_things_with_threads ON public.public_things FOR SELECT TO anon
       USING (EXISTS (SELECT 1 FROM public.whatsapp_conversations c WHERE c.location_id = public_things.location_id));`,
    /mig 673: policies open to anon read the WhatsApp tables: public\.public_things\.public_things_with_threads/,
  ), 60_000)

  it('when a function anon can execute names one of the four', () => expectAbort(
    `CREATE FUNCTION public.peek_unread() RETURNS bigint LANGUAGE sql STABLE SET search_path = '' AS $$
       SELECT count(*) FROM public.whatsapp_broadcast_recipients
     $$;`,
    /mig 673: functions anon can execute name the WhatsApp tables: peek_unread\(\)/,
  ), 60_000)

  it("when the file would also move authenticated's privileges (self-check 5)", () => {
    const NEEDLE = '  FROM anon, PUBLIC;\n'
    expect(MIG_673.split(NEEDLE).length).toBe(2)
    return expectAbort('',
      /mig 673: something besides anon\/PUBLIC changed: privilege whatsapp_messages authenticated MAINTAIN: true -> false/,
      MIG_673.replace(NEEDLE, `${NEEDLE}REVOKE MAINTAIN ON public.whatsapp_messages FROM authenticated;\n`))
  }, 60_000)

  it('when the file would also drop a policy or unpublish a table (self-check 5)', () => {
    const NEEDLE = '  FROM anon, PUBLIC;\n'
    return expectAbort('',
      /mig 673: something besides anon\/PUBLIC changed: policy whatsapp_conversations wa_conv_select: PERMISSIVE\|SELECT\|\{authenticated\}\|.* -> \(absent\); publication supabase_realtime whatsapp_messages: member -> \(absent\)/,
      MIG_673.replace(NEEDLE, `${NEEDLE}DROP POLICY wa_conv_select ON public.whatsapp_conversations;
ALTER PUBLICATION supabase_realtime DROP TABLE public.whatsapp_messages;\n`))
  }, 60_000)

  it('when 656/661 are not live yet (a client write privilege or write policy remains)', () => expectAbort(
    PRE_656,
    /mig 673: apply 656 and 661 first: authenticated still holds INSERT on public\.whatsapp_messages/,
  ), 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    const acl = await relacls()
    await expect(runSql(MIG_673)).resolves.toBeDefined()
    expect(await relacls()).toEqual(acl)
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  // A re-GRANT appends its ACL item at the end, so compare the entries as a set.
  const entries = (rows) => rows.map(({ relname, acl }) => ({ relname, acl: acl.slice(1, -1).split(',').sort() }))

  it('restores the 30 Sep ACLs exactly (entry for entry), and nothing else moved', async () => {
    await boot()
    const aclBefore = await relacls()
    const rest = await untouched()
    await runSql(MIG_673)
    await runSql(ROLLBACK_673)
    expect(entries(await relacls())).toEqual(entries(aclBefore))
    expect(await untouched()).toEqual(rest)
    expect(await asRole('anon', `SELECT count(*)::int AS n FROM public.${MSG}`)).toEqual([{ n: 0 }])
  }, 60_000)
})
