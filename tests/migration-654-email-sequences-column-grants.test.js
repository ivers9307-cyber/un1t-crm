// PROFILESPREAD.1b — behavioural GRANT test for migration 654.
//
// No local Supabase stack exists, so a grant change otherwise gets its first
// run on prod. email_sequences, sequence_steps and sequence_enrollments carry
// Supabase's default table-level ALL for anon + authenticated (prod relacl
// arwdDxtm, 29 Sep 2026) and FOR ALL policies admitting any member of the
// studio. So a plain staff member's own login reads the sequences'
// webhook_token / webhook_secret and can UPDATE / INSERT / DELETE sequences
// (activate one that emails customers), steps (email bodies) and enrolments
// directly, bypassing every route. This boots PGlite with the three tables in
// PROD column order, the prod helper and policies (pg_policies / pg_proc,
// 29 Sep) and the prod grants (Supabase's default privileges: ALL on every new
// public table for anon + authenticated + service_role), proves the leak and
// the write hole, applies the REAL 654 file, and asserts:
//   * the catalog holds exactly the allow-list (column_privileges and the
//     inheritance-aware has_*_privilege, one privilege per call);
//   * webhook_token, webhook_secret and `SELECT *` are refused; the 27 columns
//     still read, for exactly the rows they read before (RLS unchanged);
//   * the child tables' policies still work (they read email_sequences.id /
//     location_id as the caller) and return the same rows as before;
//   * no client write to any of the three tables; anon holds nothing;
//   * service_role (every route, page and cron) keeps full DML, cascades and
//     the updated_at trigger;
//   * the self-check aborts the WHOLE file on every way it can go wrong (the
//     plan's mutation table, kept as permanent cases);
//   * the header's probe runs and reads as documented, before and after;
//   * the header's rollback restores the pre-654 ACLs exactly.
// Fictional values only (SYNTH-…, made-up UUIDs): the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import {
  EMAIL_SEQUENCES_SELECT, EMAIL_SEQUENCES_WITHHELD, READ_ONLY_TABLES, SEQUENCE_TABLES,
} from './helpers/sequence-column-grants.js'

const MIG_654 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/654_email_sequences_column_grants.sql'), 'utf8')

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const STAFF = '10000000-0000-0000-0000-000000000001'   // plain staff at A
const OWNER = '10000000-0000-0000-0000-000000000002'   // owner at A
const MASTER = '10000000-0000-0000-0000-0000000000ff'
const SEQ_A = '20000000-0000-0000-0000-00000000000a'
const SEQ_B = '20000000-0000-0000-0000-00000000000b'
const STEP_A = '30000000-0000-0000-0000-00000000000a'
const STEP_B = '30000000-0000-0000-0000-00000000000b'
const ENR_A = '40000000-0000-0000-0000-00000000000a'
const ENR_B = '40000000-0000-0000-0000-00000000000b'
const CONTACT = '50000000-0000-0000-0000-000000000001'
const SEND_A = '60000000-0000-0000-0000-00000000000a'

const DENIED = /permission denied for (table|relation) (email_sequences|sequence_steps|sequence_enrollments)/

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO authenticated, anon, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated;  -- prod nspacl: anon has none

  -- Supabase's default privileges (pg_default_acl, prod 29 Sep): every table
  -- created in public is born with ALL for the three API roles. This is what
  -- mig 654's table-level REVOKE has to undo, so the replay models it rather
  -- than granting by hand.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true,
    deleted_at timestamptz, created_at timestamptz DEFAULT now());
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  REVOKE ALL ON public.profiles FROM authenticated, anon;  -- mig 153b

  -- PROD column order and types (information_schema.columns, 29 Sep 2026).
  CREATE TABLE public.email_sequences (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY, location_id uuid, name text NOT NULL, description text,
    trigger_type text DEFAULT 'manual' NOT NULL, trigger_config jsonb DEFAULT '{}'::jsonb,
    audience_filter jsonb DEFAULT '{"logic": "and", "filters": []}'::jsonb, active boolean DEFAULT false,
    total_enrolled integer DEFAULT 0, total_completed integer DEFAULT 0, total_exited integer DEFAULT 0,
    created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    status text DEFAULT 'draft', goal_config jsonb, send_window jsonb, re_enrolment_cooldown_days integer,
    webhook_token text, webhook_secret text, graph jsonb, draft_graph jsonb, graph_version integer DEFAULT 1 NOT NULL,
    from_email text, from_name text, reply_to text, audience_seeded_at timestamptz, audience_seeded_by uuid,
    audience_seed_count integer
  );
  CREATE TABLE public.sequence_steps (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    sequence_id uuid NOT NULL REFERENCES public.email_sequences(id) ON DELETE CASCADE,
    step_order integer NOT NULL, delay_minutes integer DEFAULT 0, delay_type text DEFAULT 'after_previous',
    subject text, design_json jsonb, html_content text, template_id uuid, step_type text DEFAULT 'email',
    total_sent integer DEFAULT 0, total_opened integer DEFAULT 0, total_clicked integer DEFAULT 0,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), delay_days integer DEFAULT 0,
    delay_hours integer DEFAULT 0, whatsapp_template_id uuid, whatsapp_variables jsonb DEFAULT '{}'::jsonb,
    whatsapp_header_media_url text, sms_body text, config jsonb DEFAULT '{}'::jsonb
  );
  CREATE TABLE public.sequence_enrollments (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    sequence_id uuid NOT NULL REFERENCES public.email_sequences(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL, current_step_order integer DEFAULT 0, status text DEFAULT 'active',
    next_step_at timestamptz, exit_reason text, enrolled_at timestamptz DEFAULT now(), completed_at timestamptz,
    exited_at timestamptz, last_processed_at timestamptz, last_step_send_id uuid, last_error text,
    error_count integer DEFAULT 0 NOT NULL, source_type text, source_ref text, metadata jsonb DEFAULT '{}'::jsonb
  );
  -- The other FKs into these tables on prod (pg_constraint): email_sends
  -- (ON DELETE SET NULL) and locations.dunning_sequence_id (SET NULL). One of
  -- them is modelled so the service_role delete case exercises the RI actions.
  CREATE TABLE public.email_sends (
    id uuid PRIMARY KEY,
    sequence_id uuid REFERENCES public.email_sequences(id) ON DELETE SET NULL,
    sequence_step_id uuid REFERENCES public.sequence_steps(id) ON DELETE SET NULL
  );

  -- Prod triggers: update_updated_at() on email_sequences and sequence_steps (INVOKER, row-local).
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TRIGGER email_sequences_updated_at BEFORE UPDATE ON public.email_sequences
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
  CREATE TRIGGER sequence_steps_updated_at BEFORE UPDATE ON public.sequence_steps
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

  -- The prod helper, verbatim (pg_proc.prosrc, 29 Sep; mig 626), SECURITY DEFINER.
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
         AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations
                                            WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
  $$;
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;

  ALTER TABLE public.email_sequences ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.sequence_steps ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.sequence_enrollments ENABLE ROW LEVEL SECURITY;

  -- Prod policies (pg_policies, 29 Sep): one PERMISSIVE FOR ALL TO authenticated each.
  CREATE POLICY email_sequences_location_scoped ON public.email_sequences FOR ALL TO authenticated
    USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
  CREATE POLICY sequence_steps_via_sequence ON public.sequence_steps FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.email_sequences s WHERE s.id = sequence_steps.sequence_id AND private.auth_is_in_location(s.location_id)))
    WITH CHECK (EXISTS (SELECT 1 FROM public.email_sequences s WHERE s.id = sequence_steps.sequence_id AND private.auth_is_in_location(s.location_id)));
  CREATE POLICY sequence_enrollments_via_sequence ON public.sequence_enrollments FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.email_sequences s WHERE s.id = sequence_enrollments.sequence_id AND private.auth_is_in_location(s.location_id)))
    WITH CHECK (EXISTS (SELECT 1 FROM public.email_sequences s WHERE s.id = sequence_enrollments.sequence_id AND private.auth_is_in_location(s.location_id)));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}', 'Studio A'), ('${LOC_B}', 'Studio B');
  INSERT INTO public.profiles (id, role) VALUES ('${STAFF}', 'staff'), ('${OWNER}', 'owner'), ('${MASTER}', 'master');
  INSERT INTO public.profile_locations VALUES ('${STAFF}', '${LOC_A}', 'staff'), ('${OWNER}', '${LOC_A}', 'owner');
  INSERT INTO public.email_sequences (id, location_id, name, status, webhook_token, webhook_secret) VALUES
    ('${SEQ_A}', '${LOC_A}', 'Welcome', 'draft', 'SYNTH-TOKEN-A', 'SYNTH-SECRET-A'),
    ('${SEQ_B}', '${LOC_B}', 'Other studio', 'draft', NULL, NULL);
  INSERT INTO public.sequence_steps (id, sequence_id, step_order, subject) VALUES
    ('${STEP_A}', '${SEQ_A}', 1, 'Hello'), ('${STEP_B}', '${SEQ_B}', 1, 'Hi');
  INSERT INTO public.sequence_enrollments (id, sequence_id, contact_id) VALUES
    ('${ENR_A}', '${SEQ_A}', '${CONTACT}'), ('${ENR_B}', '${SEQ_B}', '${CONTACT}');
  INSERT INTO public.email_sends VALUES ('${SEND_A}', '${SEQ_A}', '${STEP_A}');
`

const NAMED = EMAIL_SEQUENCES_SELECT.join(', ')
const ALL_TABLE_PRIVS = ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']
const WRITE_PRIVS = ['DELETE', 'INSERT', 'REFERENCES', 'TRIGGER', 'TRUNCATE', 'UPDATE']
// Postgres 17's `m` (VACUUM/ANALYZE/REINDEX/LOCK TABLE): part of the default
// ALL (prod relacl arwdDxtm) but invisible to information_schema, so it is
// checked with has_table_privilege.
const MAINTAIN = 'MAINTAIN'
const sorted = (xs) => [...xs].sort() // sort in JS: collation-independent

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)

/** Run `sql` as `role` (with a JWT for `sub`) inside a rolled-back tx; returns rows. */
async function as(sub, sql, role = 'authenticated') {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role })])
    await runSql(`SET LOCAL ROLE ${role}`)
    return (await db.query(sql)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function tablePrivileges(table, grantee) {
  const { rows } = await db.query(
    `SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 ORDER BY privilege_type`, [table, grantee])
  return rows.map((r) => r.privilege_type)
}

async function columnGrants(table, grantee, privilege) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 AND privilege_type = $3`, [table, grantee, privilege])
  return sorted(rows.map((r) => r.column_name))
}

/** Each table's ACL as a sorted list of aclitems, plus how many columns carry an ACL. */
async function aclSnapshot() {
  const out = {}
  for (const t of SEQUENCE_TABLES) {
    const { rows: [r] } = await db.query(
      `SELECT (SELECT array_agg(x::text) FROM unnest(c.relacl) x) AS acl,
              (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND a.attacl IS NOT NULL) AS col_acls
         FROM pg_class c WHERE c.oid = $1::regclass`, [`public.${t}`])
    out[t] = { acl: sorted(r.acl), col_acls: r.col_acls }
  }
  return out
}

// What a staff member at A reads through each table (rows, not privileges).
const STAFF_READS = `SELECT
  (SELECT array_agg(id ORDER BY id) FROM public.sequence_steps)::text AS steps,
  (SELECT array_agg(id ORDER BY id) FROM public.sequence_enrollments)::text AS enrolments,
  (SELECT array_agg(id ORDER BY id) FROM (SELECT ${NAMED} FROM public.email_sequences) s)::text AS sequences`

async function boot({ migrate = false } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(SEED)
  if (migrate) await runSql(MIG_654)
}

// The header's probe (run on prod before and after the apply), extracted and
// replayed here so the documented expectations are proven, not asserted.
function headerBlock(label) {
  const m = MIG_654.match(new RegExp(`^-- ${label}:[\\s\\S]*?^--\\s+(BEGIN;|begin;)\\n([\\s\\S]*?^--\\s+(COMMIT|ROLLBACK|commit|rollback);)$`, 'm'))
  if (!m) return null
  return `${m[1]}\n${m[2].replace(/^--\s?/gm, '')}`
}

async function runProbe() {
  const sql = headerBlock('PROBE')
  expect(sql, 'the probe SQL in the header').not.toBeNull()
  const results = await runSql(sql)
  const probe = results.find((r) => r.fields?.some((f) => f.name === 'sequences'))
  return probe.rows[0]
}

// What the staff member at A reads before 654 (pinned in the 'before' block;
// the 'after' block requires the same).
const BEFORE_READS = [{ steps: `{${STEP_A}}`, enrolments: `{${ENR_A}}`, sequences: `{${SEQ_A}}` }]

describe('before 654: the leak and the write hole (prod today)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it.each(SEQUENCE_TABLES)('%s: both client roles hold the default table-level ALL (prod relacl arwdDxtm)', async (t) => {
    expect(await tablePrivileges(t, 'authenticated')).toEqual(ALL_TABLE_PRIVS)
    expect(await tablePrivileges(t, 'anon')).toEqual(ALL_TABLE_PRIVS)
    expect(await tablePrivileges(t, 'service_role')).toEqual(ALL_TABLE_PRIVS)
    for (const role of ['authenticated', 'anon']) {
      const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, $2, $3) AS v`, [role, `public.${t}`, MAINTAIN])
      expect([role, t, MAINTAIN, r.v]).toEqual([role, t, MAINTAIN, true])
    }
  })

  it("a plain staff login reads its studio's webhook secret and token", async () => {
    expect(await as(STAFF, 'SELECT webhook_token, webhook_secret FROM public.email_sequences'))
      .toEqual([{ webhook_token: 'SYNTH-TOKEN-A', webhook_secret: 'SYNTH-SECRET-A' }])
  })

  it('a plain staff login activates a sequence, rewrites a step and exits an enrolment', async () => {
    expect(await as(STAFF, `UPDATE public.email_sequences SET status = 'active' WHERE id = '${SEQ_A}' RETURNING id`)).toHaveLength(1)
    expect(await as(STAFF, `UPDATE public.sequence_steps SET html_content = 'x' WHERE id = '${STEP_A}' RETURNING id`)).toHaveLength(1)
    expect(await as(STAFF, `UPDATE public.sequence_enrollments SET status = 'exited' WHERE id = '${ENR_A}' RETURNING id`)).toHaveLength(1)
  })

  it('a plain staff login enrols a contact and deletes a sequence', async () => {
    expect(await as(STAFF, `INSERT INTO public.sequence_enrollments (sequence_id, contact_id) VALUES ('${SEQ_A}', '${CONTACT}') RETURNING id`)).toHaveLength(1)
    expect(await as(STAFF, `DELETE FROM public.email_sequences WHERE id = '${SEQ_A}' RETURNING id`)).toHaveLength(1)
  })

  it("the staff login's reads (the baseline the 'after' block compares against)", async () => {
    expect(await as(STAFF, STAFF_READS)).toEqual(BEFORE_READS)
  })

  it('anon is fenced by RLS only (no policy names anon: zero rows, no error)', async () => {
    expect(await as(null, 'SELECT id FROM public.email_sequences', 'anon')).toEqual([])
  })

  it("the header's probe reads the documented 'before' values", async () => {
    expect(await runProbe()).toEqual({
      sequences: 1, steps: 1, enrolments: 1,
      seq_update: true, steps_update: true, enr_insert: true, reads_secret: true,
    })
  })
})

describe('after 654: the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it('the lists classify every email_sequences column, with no overlap', async () => {
    const { rows } = await db.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'email_sequences'`)
    expect(sorted([...EMAIL_SEQUENCES_SELECT, ...EMAIL_SEQUENCES_WITHHELD])).toEqual(sorted(rows.map((r) => r.column_name)))
    expect(EMAIL_SEQUENCES_SELECT.filter((c) => EMAIL_SEQUENCES_WITHHELD.includes(c))).toEqual([])
  })

  it('email_sequences: no table-level privilege for a client role; service_role keeps ALL', async () => {
    expect(await tablePrivileges('email_sequences', 'authenticated')).toEqual([])
    expect(await tablePrivileges('email_sequences', 'anon')).toEqual([])
    expect(await tablePrivileges('email_sequences', 'PUBLIC')).toEqual([])
    expect(await tablePrivileges('email_sequences', 'service_role')).toEqual(ALL_TABLE_PRIVS)
  })

  it('email_sequences: authenticated holds exactly the SELECT allow-list and no other column privilege; anon nothing', async () => {
    expect(await columnGrants('email_sequences', 'authenticated', 'SELECT')).toEqual(sorted(EMAIL_SEQUENCES_SELECT))
    for (const p of ['INSERT', 'UPDATE', 'REFERENCES']) {
      expect(await columnGrants('email_sequences', 'authenticated', p)).toEqual([])
    }
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
      expect(await columnGrants('email_sequences', 'anon', p)).toEqual([])
      expect(await columnGrants('email_sequences', 'PUBLIC', p)).toEqual([])
    }
  })

  it.each(EMAIL_SEQUENCES_WITHHELD)('email_sequences.%s: neither client role can read it (inheritance-aware)', async (col) => {
    const { rows: [r] } = await db.query(
      `SELECT has_column_privilege('authenticated', 'public.email_sequences', $1, 'SELECT') AS a,
              has_column_privilege('anon', 'public.email_sequences', $1, 'SELECT') AS n`, [col])
    expect(r).toEqual({ a: false, n: false })
  })

  it.each(READ_ONLY_TABLES)('%s: authenticated holds table-level SELECT only; anon nothing; service_role ALL', async (t) => {
    expect(await tablePrivileges(t, 'authenticated')).toEqual(['SELECT'])
    expect(await tablePrivileges(t, 'anon')).toEqual([])
    expect(await tablePrivileges(t, 'PUBLIC')).toEqual([])
    expect(await tablePrivileges(t, 'service_role')).toEqual(ALL_TABLE_PRIVS)
  })

  it.each(SEQUENCE_TABLES)('%s: no client write privilege, one privilege per call (a comma list is true if ANY is held)', async (t) => {
    for (const role of ['authenticated', 'anon']) {
      for (const p of [...WRITE_PRIVS, MAINTAIN]) {
        const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, $2, $3) AS v`, [role, `public.${t}`, p])
        expect([role, t, p, r.v]).toEqual([role, t, p, false])
      }
      for (const p of ['INSERT', 'UPDATE', 'REFERENCES']) {
        const { rows: [r] } = await db.query(`SELECT has_any_column_privilege($1, $2, $3) AS v`, [role, `public.${t}`, p])
        expect([role, t, p, r.v]).toEqual([role, t, p, false])
      }
    }
    const { rows: [a] } = await db.query(`SELECT has_any_column_privilege('anon', $1, 'SELECT') AS v`, [`public.${t}`])
    expect(a.v).toBe(false)
  })

  it("the migration's GRANT SELECT line names exactly the helper's list", () => {
    const m = MIG_654.match(/^GRANT SELECT \(([^)]*)\)\s+ON public\.email_sequences TO authenticated;/m)
    expect(m, 'the email_sequences column grant').not.toBeNull()
    expect(sorted(m[1].split(',').map((s) => s.trim()))).toEqual(sorted(EMAIL_SEQUENCES_SELECT))
  })

  it('takes its locks with a 5s lock_timeout, set right after BEGIN', () => {
    expect(MIG_654).toMatch(/^BEGIN;\nSET LOCAL lock_timeout = '5s';\n/m)
  })

  it('leaves the existing webhook column comments alone (mig 131 text; the rollback touches no comment)', async () => {
    expect(MIG_654).not.toMatch(/^\s*COMMENT ON/im)
  })

  it('a second run passes its own self-check (idempotent)', async () => {
    await expect(runSql(MIG_654)).resolves.toBeDefined()
    expect(await columnGrants('email_sequences', 'authenticated', 'SELECT')).toEqual(sorted(EMAIL_SEQUENCES_SELECT))
    expect(await tablePrivileges('sequence_steps', 'authenticated')).toEqual(['SELECT'])
  })
})

describe('after 654: people', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it('a staff login reads exactly what it read before: the 27 named columns and both child tables, own studio only', async () => {
    expect(await as(STAFF, STAFF_READS)).toEqual(BEFORE_READS)
  })

  it("the child tables' policies still work (they read email_sequences.id / location_id as the caller)", async () => {
    expect(await as(STAFF, 'SELECT * FROM public.sequence_steps')).toHaveLength(1)
    expect(await as(STAFF, 'SELECT * FROM public.sequence_enrollments')).toHaveLength(1)
    expect(await as(MASTER, 'SELECT id FROM public.sequence_steps')).toHaveLength(2)
  })

  it.each([STAFF, OWNER, MASTER])('webhook_token, webhook_secret and SELECT * are refused (%s)', async (who) => {
    await expect(as(who, 'SELECT webhook_secret FROM public.email_sequences')).rejects.toThrow(DENIED)
    await expect(as(who, 'SELECT webhook_token FROM public.email_sequences')).rejects.toThrow(DENIED)
    await expect(as(who, 'SELECT * FROM public.email_sequences')).rejects.toThrow(DENIED)
    await expect(as(who, `SELECT id FROM public.email_sequences WHERE webhook_token IS NOT NULL`)).rejects.toThrow(DENIED)
  })

  it('a PostgREST-shaped embed of the sequence name from a child still works', async () => {
    const rows = await as(STAFF, `SELECT e.id, (SELECT row_to_json(s1.*) FROM (SELECT s.name FROM public.email_sequences s WHERE s.id = e.sequence_id) s1) AS email_sequences
      FROM public.sequence_enrollments e`)
    expect(rows).toEqual([{ id: ENR_A, email_sequences: { name: 'Welcome' } }])
  })

  it.each([STAFF, OWNER, MASTER])('no client write to any of the three tables (%s)', async (who) => {
    await expect(as(who, `UPDATE public.email_sequences SET status = 'active' WHERE id = '${SEQ_A}'`)).rejects.toThrow(DENIED)
    await expect(as(who, `INSERT INTO public.email_sequences (location_id, name) VALUES ('${LOC_A}', 'x')`)).rejects.toThrow(DENIED)
    await expect(as(who, `DELETE FROM public.email_sequences WHERE id = '${SEQ_A}'`)).rejects.toThrow(DENIED)
    await expect(as(who, `UPDATE public.sequence_steps SET html_content = 'x' WHERE id = '${STEP_A}'`)).rejects.toThrow(DENIED)
    await expect(as(who, `INSERT INTO public.sequence_steps (sequence_id, step_order) VALUES ('${SEQ_A}', 2)`)).rejects.toThrow(DENIED)
    await expect(as(who, `DELETE FROM public.sequence_steps WHERE id = '${STEP_A}'`)).rejects.toThrow(DENIED)
    await expect(as(who, `UPDATE public.sequence_enrollments SET status = 'exited' WHERE id = '${ENR_A}'`)).rejects.toThrow(DENIED)
    await expect(as(who, `INSERT INTO public.sequence_enrollments (sequence_id, contact_id) VALUES ('${SEQ_A}', '${CONTACT}')`)).rejects.toThrow(DENIED)
    await expect(as(who, `DELETE FROM public.sequence_enrollments WHERE id = '${ENR_A}'`)).rejects.toThrow(DENIED)
    await expect(as(who, 'TRUNCATE public.sequence_enrollments')).rejects.toThrow(DENIED)
  })

  it('anon is refused by the grant itself now', async () => {
    for (const t of SEQUENCE_TABLES) {
      await expect(as(null, `SELECT id FROM public.${t}`, 'anon')).rejects.toThrow(DENIED)
    }
  })

  it('service_role (every route, page and cron) keeps full DML, the updated_at trigger and the FK actions', async () => {
    const SVC = `
      SELECT * FROM public.email_sequences;
      UPDATE public.email_sequences SET status = 'active', webhook_secret = 'SYNTH-ROTATED', updated_at = 'epoch' WHERE id = '${SEQ_A}';
      UPDATE public.sequence_steps SET html_content = 'x', updated_at = 'epoch' WHERE id = '${STEP_A}';
      UPDATE public.sequence_enrollments SET status = 'exited' WHERE id = '${ENR_A}';
      INSERT INTO public.sequence_enrollments (sequence_id, contact_id) VALUES ('${SEQ_A}', '${CONTACT}');
      INSERT INTO public.sequence_steps (sequence_id, step_order) VALUES ('${SEQ_A}', 2);
      INSERT INTO public.email_sequences (location_id, name) VALUES ('${LOC_A}', 'New');`
    await runSql('BEGIN')
    try {
      await runSql('SET LOCAL ROLE service_role')
      await runSql(SVC)
      const { rows: [r] } = await db.query(`SELECT
        (SELECT webhook_secret FROM public.email_sequences WHERE id = '${SEQ_A}') AS secret,
        (SELECT updated_at > 'epoch' FROM public.email_sequences WHERE id = '${SEQ_A}') AS seq_trigger,
        (SELECT updated_at > 'epoch' FROM public.sequence_steps WHERE id = '${STEP_A}') AS step_trigger,
        (SELECT count(*)::int FROM public.sequence_enrollments WHERE sequence_id = '${SEQ_A}') AS enrolments`)
      expect(r).toEqual({ secret: 'SYNTH-ROTATED', seq_trigger: true, step_trigger: true, enrolments: 2 })
      await runSql(`DELETE FROM public.email_sequences WHERE id = '${SEQ_A}'`)
      await runSql('RESET ROLE')
      const { rows: [after] } = await db.query(`SELECT
        (SELECT count(*)::int FROM public.sequence_steps WHERE sequence_id = '${SEQ_A}') AS steps,
        (SELECT count(*)::int FROM public.sequence_enrollments WHERE sequence_id = '${SEQ_A}') AS enrolments,
        (SELECT sequence_id IS NULL AND sequence_step_id IS NULL FROM public.email_sends WHERE id = '${SEND_A}') AS send_nulled`)
      expect(after).toEqual({ steps: 0, enrolments: 0, send_nulled: true })
    } finally {
      await runSql('ROLLBACK')
    }
  })

  it("the header's probe reads the documented 'after' values", async () => {
    expect(await runProbe()).toEqual({
      sequences: 1, steps: 1, enrolments: 1,
      seq_update: false, steps_update: false, enr_insert: false, reads_secret: false,
    })
  })
})

describe('the self-check aborts the WHOLE file', () => {
  // The file is one transaction (BEGIN … COMMIT), so a RAISE leaves it
  // aborted; ROLLBACK then restores the pre-654 state for the next case.
  let BEFORE_ACL
  beforeAll(async () => {
    await boot()
    BEFORE_ACL = await aclSnapshot()
  }, 60_000)
  afterAll(() => db?.close())

  const stillOpen = async () => {
    expect(await aclSnapshot()).toEqual(BEFORE_ACL)
    for (const t of SEQUENCE_TABLES) expect(await tablePrivileges(t, 'authenticated')).toEqual(ALL_TABLE_PRIVS)
  }

  const mutated = (from, to) => {
    expect(MIG_654, `the file contains: ${from}`).toContain(from)
    return MIG_654.replace(from, to)
  }

  const abortsWith = async (sql, message) => {
    await expect(runSql(sql)).rejects.toThrow(message)
    await runSql('ROLLBACK')
    await stillOpen()
  }

  it('when the table-level REVOKE on email_sequences is missing (the mig 153 mistake)', async () => {
    await abortsWith(mutated('REVOKE ALL ON public.email_sequences FROM authenticated, anon;\n', ''),
      /PROFILESPREAD\.1b: table-level \w+ on public\.email_sequences survived/)
  })

  it('when webhook_secret is added to the GRANT list', async () => {
    await abortsWith(mutated('audience_seed_count)\n  ON public.email_sequences', 'audience_seed_count, webhook_secret)\n  ON public.email_sequences'),
      /PROFILESPREAD\.1b: email_sequences SELECT for authenticated is \[.*webhook_secret/)
  })

  it('when location_id is dropped from the GRANT list (the child policies would 42501)', async () => {
    await abortsWith(mutated('GRANT SELECT (id, location_id, name,', 'GRANT SELECT (id, name,'),
      /PROFILESPREAD\.1b: email_sequences SELECT for authenticated is \[/)
  })

  it("when section B's GRANT SELECT is dropped (the child reads would change)", async () => {
    await abortsWith(mutated('GRANT SELECT ON public.sequence_steps, public.sequence_enrollments TO authenticated;\n', ''),
      /PROFILESPREAD\.1b: authenticated lost SELECT on public\.sequence_steps/)
  })

  it("when section B's REVOKE is dropped (the write hole stays open)", async () => {
    await abortsWith(mutated('REVOKE ALL ON public.sequence_steps, public.sequence_enrollments FROM authenticated, anon;\n', ''),
      /PROFILESPREAD\.1b: authenticated still holds \w+ on public\.sequence_steps/)
  })

  it('when MAINTAIN survives on email_sequences (a table-level privilege the column grant cannot see)', async () => {
    await abortsWith(mutated('  ON public.email_sequences TO authenticated;\n', '  ON public.email_sequences TO authenticated;\nGRANT MAINTAIN ON public.email_sequences TO anon;\n'),
      /PROFILESPREAD\.1b: table-level MAINTAIN on public\.email_sequences survived for anon/)
  })

  it('when MAINTAIN survives on a child table', async () => {
    await abortsWith(mutated('GRANT SELECT ON public.sequence_steps, public.sequence_enrollments TO authenticated;\n',
      'GRANT SELECT ON public.sequence_steps, public.sequence_enrollments TO authenticated;\nGRANT MAINTAIN ON public.sequence_enrollments TO authenticated;\n'),
    /PROFILESPREAD\.1b: authenticated still holds MAINTAIN on public\.sequence_enrollments/)
  })

  it('when email_sequences has a column the file does not classify', async () => {
    await runSql('BEGIN; ALTER TABLE public.email_sequences ADD COLUMN surprise text;')
    await expect(runSql(MIG_654)).rejects.toThrow(/PROFILESPREAD\.1b: public\.email_sequences has column\(s\) this migration does not classify: surprise/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it('when a table-level grant survives through role inheritance (information_schema cannot see it)', async () => {
    await runSql(`BEGIN; CREATE ROLE sneaky NOLOGIN; GRANT UPDATE ON public.sequence_enrollments TO sneaky; GRANT sneaky TO authenticated;`)
    await expect(runSql(MIG_654)).rejects.toThrow(/PROFILESPREAD\.1b: authenticated still holds UPDATE on public\.sequence_enrollments/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it("when a grant made by ANOTHER grantor survives (the owner's REVOKE removes only its own)", async () => {
    await runSql(`BEGIN; CREATE ROLE other_grantor NOLOGIN; GRANT USAGE ON SCHEMA public TO other_grantor;
      GRANT SELECT ON public.email_sequences TO other_grantor WITH GRANT OPTION;
      SET LOCAL ROLE other_grantor; GRANT SELECT ON public.email_sequences TO authenticated; RESET ROLE;`)
    await expect(runSql(MIG_654)).rejects.toThrow(/PROFILESPREAD\.1b: table-level SELECT on public\.email_sequences survived/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it.each(SEQUENCE_TABLES)('when service_role has lost a privilege on %s (every route would break)', async (t) => {
    await runSql(`BEGIN; REVOKE DELETE ON public.${t} FROM service_role;`)
    await expect(runSql(MIG_654)).rejects.toThrow(new RegExp(`PROFILESPREAD\\.1b: service_role lacks DELETE on public\\.${t}`))
    await runSql('ROLLBACK')
    expect(await tablePrivileges(t, 'service_role')).toEqual(ALL_TABLE_PRIVS)
    await stillOpen()
  })
})

describe("the header's rollback restores the pre-654 ACLs exactly", () => {
  let BEFORE_ACL
  beforeAll(async () => {
    await boot()
    BEFORE_ACL = await aclSnapshot()
    await runSql(MIG_654)
  }, 60_000)
  afterAll(() => db?.close())

  it('REVOKE ALL + GRANT ALL, no column lists: relacl item-for-item as before, no column ACL left', async () => {
    const sql = headerBlock('ROLLBACK')
    expect(sql, 'the rollback SQL in the header').not.toBeNull()
    expect(sql).not.toMatch(/\(\s*id\s*,/) // no column lists: cannot drift if a later migration grants a column
    expect(await aclSnapshot()).not.toEqual(BEFORE_ACL)
    await runSql(sql)
    expect(await aclSnapshot()).toEqual(BEFORE_ACL)
    expect(await as(STAFF, 'SELECT webhook_secret FROM public.email_sequences')).toEqual([{ webhook_secret: 'SYNTH-SECRET-A' }])
  })
})
