// AUDITRLS.1 — behavioural test for migration 655.
//
// audit_events carried Supabase's default client grants and one policy,
// audit_events_select_master_owner: any active master/owner may read EVERY
// row (no organisation term). It does not work today only because the
// policy's EXISTS (SELECT … FROM profiles) runs as the caller and
// `authenticated` has no SELECT on profiles (mig 153b): every client read
// errors 42501. Grant any profiles column and it opens. No client code reads
// the table. This boots PGlite with the audited tables, replays the REAL mig
// 191 and 647 files and the prod policy + grants, proves (a) today's
// accidental fence and (b) the leak it hides, applies the REAL 655 file, and
// asserts:
//   * no client role reads audit_events, even with a profiles grant;
//   * the trigger still writes an audit row for a CLIENT-session write;
//   * the service role still reads and writes;
//   * customer_agent.test_phones is masked, a change marked, [] kept;
//   * credential masking is exactly 647's;
//   * the file's self-check aborts the whole file on a stray policy;
//   * the SQL PII list is the JS one.
// Fictional values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { AUDIT_PII_KEY_EXACT } from '../src/lib/secret-keys.js'

// PGlite's multi-statement SQL runner (an in-process database call, not a shell).
const runSql = (db, text) => db['exec'](text)

const MIG_DIR = path.resolve(import.meta.dirname, '../supabase/migrations')
const MIG_191 = readFileSync(path.join(MIG_DIR, '191_audit_mutation_triggers.sql'), 'utf8')
const MIG_647 = readFileSync(path.join(MIG_DIR, '647_audit_redact_secrets.sql'), 'utf8')
const MIG_655 = readFileSync(path.join(MIG_DIR, '655_audit_events_client_closed.sql'), 'utf8')

const ORG_A = 'c0000000-0000-0000-0000-00000000000a'
const ORG_B = 'c0000000-0000-0000-0000-00000000000b'
const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'a0000000-0000-0000-0000-00000000000b'
const OWNER_A = '10000000-0000-0000-0000-00000000000a'
const MASTER = '10000000-0000-0000-0000-0000000000ff'

const DENIED_AUDIT = /permission denied for (table|relation) audit_events/
const DENIED_PROFILES = /permission denied for (table|relation) profiles/

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO authenticated, anon, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated;   -- prod nspacl

  -- Supabase's form: once a transaction has set the claims GUC and rolled
  -- back, current_setting() returns '' (not NULL), so the nullif must come
  -- BEFORE the ::jsonb cast or every later superuser write's audit row fails.
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

  CREATE TABLE public.audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    category text NOT NULL, action text NOT NULL,
    actor_id uuid, actor_label text, target_profile_id uuid, target_label text,
    target_resource text, location_id uuid, details jsonb, ip_address inet, user_agent text,
    -- Test-only: insert order. PGlite's clock can hand two quick writes the
    -- same occurred_at, so "latest row" orders by this (as the 647 test does).
    seq bigint GENERATED ALWAYS AS IDENTITY
  );
  ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

  CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.locations (
    id uuid PRIMARY KEY, name text, organization_id uuid, settings jsonb DEFAULT '{}'::jsonb,
    sensibo_api_key text, thinq_pat text, bca_config jsonb, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, full_name text, role text, active boolean DEFAULT true,
    deleted_at timestamptz, pin_hash text, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.profile_locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid, location_id uuid, role text, unifi_synced_at timestamptz);
  CREATE TABLE public.cars (id uuid PRIMARY KEY, location_id uuid, status text, deposit_token uuid, deposit_revolut_checkout_url text, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.invoices_queue (id uuid PRIMARY KEY, location_id uuid, status text, updated_at timestamptz DEFAULT now());

  -- prod helper (mig 626), SECURITY DEFINER
  CREATE FUNCTION private.auth_is_active_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND active IS NOT FALSE AND deleted_at IS NULL)
  $$;
  GRANT EXECUTE ON FUNCTION private.auth_is_active_staff() TO authenticated;

  -- prod grants: Supabase defaults on every table …
  GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon, service_role;
  -- … except profiles (mig 153b).
  REVOKE ALL ON public.profiles FROM authenticated, anon;

  -- prod policy (mig 626 form, read from pg_policies 28 Sep 2026)
  CREATE POLICY audit_events_select_master_owner ON public.audit_events FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = (SELECT auth.uid())
                      AND p.role = ANY (ARRAY['master','owner'])
                      AND (SELECT private.auth_is_active_staff())));
`

const SEED = `
  INSERT INTO public.organizations VALUES ('${ORG_A}', 'Org A'), ('${ORG_B}', 'Org B');
  INSERT INTO public.locations (id, name, organization_id, settings) VALUES
    ('${LOC_A}', 'Studio A', '${ORG_A}', '{"customer_agent":{"enabled":false,"test_phones":["+353000000001"]},"glofox":{"branch_id":"b","api_key":"FAKESECRET-1"}}'),
    ('${LOC_B}', 'Studio B', '${ORG_B}', '{}');
  INSERT INTO public.profiles (id, full_name, role) VALUES ('${OWNER_A}', 'Owner A', 'owner'), ('${MASTER}', 'Master', 'master');
  INSERT INTO public.audit_events (category, action, location_id, details) VALUES
    ('business', 'org_a.thing', '${LOC_A}', '{}'), ('business', 'org_b.thing', '${LOC_B}', '{}');
`

// Every credential shape 647's own self-check pins, plus arrays and a deep
// branch. No PII key in it: 655 must redact it byte-identically to 647.
const SECRETS_FIXTURE = {
  id: 'x', thinq_pat: 'FAKESECRET-p', pin_hash: 'FAKESECRET-h', sensibo_api_key: null, deposit_token: '',
  deposit_token_expires_at: '2026-01-01', content_hash: 'c', pin_set_at: '2026-01-01', password_changed: true,
  tokens: [], empty_secret: [],
  settings: {
    glofox: { api_key: 'FAKESECRET-k', api_token: 'FAKESECRET-t', webhook_secret: 'FAKESECRET-w', branch_id: 'b' },
    unifi: { api_token: 'FAKESECRET-u', host: '10.0.0.1' },
    oauth: { accessToken: 'FAKESECRET-a', clientSecret: 'FAKESECRET-c', token_expires_at: '2026-01-01' },
    door: { pin: '1', password_hash: 'FAKESECRET-ph', tokens: ['FAKESECRET-t2'] },
    wa_card_sets: [{ label: 'l', access_token: 'FAKESECRET-wa' }],
  },
}

/** Run `sql` as `sub` under `role` inside a transaction that always rolls back. */
async function asUser(db, sub, sql, role = 'authenticated') {
  await runSql(db, 'BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role })])
    await runSql(db, `SET LOCAL ROLE ${role}`)
    return await db.query(sql)
  } finally {
    await runSql(db, 'ROLLBACK')
  }
}

async function lastDetails(db, action) {
  const { rows } = await db.query(
    `SELECT details FROM public.audit_events WHERE action = $1 ORDER BY seq DESC LIMIT 1`, [action])
  return rows[0]?.details ?? null
}

async function walk(db, doc, changed = []) {
  const { rows: [r] } = await db.query(
    `SELECT private.audit_redact($1::jsonb, $2::text[]) AS out,
            (SELECT jsonb_agg(jsonb_build_array(s.path, s.val) ORDER BY s.path) FROM private.audit_secret_paths($1::jsonb) s) AS paths`,
    [JSON.stringify(doc), changed])
  return r
}

async function freshDb() {
  const db = new PGlite()
  await runSql(db, BASE_SCHEMA)
  await runSql(db, MIG_191)
  await runSql(db, MIG_647)
  await runSql(db, SEED)
  return db
}

describe('before 655: closed by accident, open the moment profiles is granted', () => {
  let db
  beforeAll(async () => { db = await freshDb() })
  afterAll(async () => { await db.close() })

  it("today: an owner's read errors on PROFILES (the policy's subquery), not on the audit table", async () => {
    await expect(asUser(db, OWNER_A, 'SELECT count(*) FROM public.audit_events')).rejects.toThrow(DENIED_PROFILES)
    await expect(asUser(db, MASTER, 'SELECT count(*) FROM public.audit_events')).rejects.toThrow(DENIED_PROFILES)
  })

  it("with any profiles grant, an owner at org A reads org B's audit rows (the missing scope)", async () => {
    await runSql(db, 'GRANT SELECT (id, role, active, deleted_at) ON public.profiles TO authenticated')
    const { rows } = await asUser(db, OWNER_A, `SELECT action FROM public.audit_events WHERE category = 'business' ORDER BY action`)
    expect(rows.map((r) => r.action)).toEqual(['org_a.thing', 'org_b.thing'])
    await runSql(db, 'REVOKE SELECT (id, role, active, deleted_at) ON public.profiles FROM authenticated')
  })

  it('647 alone copies test_phones into the audit row', async () => {
    await runSql(db, `UPDATE public.locations SET settings = jsonb_set(settings, '{customer_agent,test_phones}', '["+353000000002"]') WHERE id = '${LOC_A}'`)
    const d = await lastDetails(db, 'locations.updated')
    expect(JSON.stringify(d)).toContain('+353000000002')
  })
})

describe('after 655', () => {
  let db
  let before647
  beforeAll(async () => {
    db = await freshDb()
    before647 = await walk(db, SECRETS_FIXTURE, ['settings.glofox.api_key', 'tokens'])
    await runSql(db, MIG_655)
  })
  afterAll(async () => { await db.close() })

  it('no policy remains, RLS is still on, and no client role holds any privilege', async () => {
    const { rows: [r] } = await db.query(`
      SELECT (SELECT count(*)::int FROM pg_policies WHERE tablename = 'audit_events') AS policies,
             (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.audit_events'::regclass) AS rls,
             (SELECT bool_or(has_table_privilege(r, 'public.audit_events', p))
                FROM unnest(array['anon','authenticated']) r,
                     unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p) AS any_client,
             (SELECT bool_or(has_any_column_privilege(r, 'public.audit_events', p))
                FROM unnest(array['anon','authenticated']) r,
                     unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) p) AS any_client_column,
             has_table_privilege('service_role', 'public.audit_events', 'SELECT') AND
             has_table_privilege('service_role', 'public.audit_events', 'INSERT') AS service_ok`)
    expect(r).toEqual({ policies: 0, rls: true, any_client: false, any_client_column: false, service_ok: true })
  })

  it('an owner, a master and anon are refused on the audit table itself, even with a profiles grant', async () => {
    await runSql(db, 'GRANT SELECT (id, role, active, deleted_at) ON public.profiles TO authenticated, anon')
    await expect(asUser(db, OWNER_A, 'SELECT count(*) FROM public.audit_events')).rejects.toThrow(DENIED_AUDIT)
    await expect(asUser(db, MASTER, 'SELECT count(*) FROM public.audit_events')).rejects.toThrow(DENIED_AUDIT)
    await expect(asUser(db, null, 'SELECT count(*) FROM public.audit_events', 'anon')).rejects.toThrow(DENIED_AUDIT)
    await expect(asUser(db, MASTER, `INSERT INTO public.audit_events (category, action) VALUES ('x','y')`)).rejects.toThrow(DENIED_AUDIT)
    await expect(asUser(db, MASTER, `DELETE FROM public.audit_events`)).rejects.toThrow(DENIED_AUDIT)
    await runSql(db, 'REVOKE SELECT (id, role, active, deleted_at) ON public.profiles FROM authenticated, anon')
  })

  it('the service role still reads every row', async () => {
    const { rows } = await asUser(db, null, `SELECT count(*)::int AS n FROM public.audit_events WHERE category = 'business'`, 'service_role')
    expect(rows).toEqual([{ n: 2 }])
  })

  it('a CLIENT-session write is still audited: the trigger insert does not need the client grant', async () => {
    await runSql(db, 'BEGIN')
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: OWNER_A, role: 'authenticated' })])
    await runSql(db, 'SET LOCAL ROLE authenticated')
    await runSql(db, `UPDATE public.locations SET name = 'Studio A2' WHERE id = '${LOC_A}'`)
    await runSql(db, 'RESET ROLE')
    const { rows } = await db.query(`SELECT actor_id, details FROM public.audit_events WHERE action = 'locations.updated' AND details::text LIKE '%Studio A2%'`)
    await runSql(db, 'ROLLBACK')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_id).toBe(OWNER_A)
    expect(rows[0].details).toEqual({ before: { name: 'Studio A' }, after: { name: 'Studio A2' } })
  })

  it('a settings change stores test_phones masked and marked changed; siblings and secrets as before', async () => {
    await runSql(db, `UPDATE public.locations SET settings = jsonb_set(settings, '{customer_agent,test_phones}', '["+353000000003"]') WHERE id = '${LOC_A}'`)
    const d = await lastDetails(db, 'locations.updated')
    expect(JSON.stringify(d)).not.toMatch(/\+3530000000/)
    expect(JSON.stringify(d)).not.toMatch(/FAKESECRET/)
    expect(d.before.settings.customer_agent.test_phones).toBe('[redacted]')
    expect(d.after.settings.customer_agent.test_phones).toBe('[redacted: changed]')
    expect(d.after.settings.customer_agent.enabled).toBe(false)
    expect(d.after.settings.glofox).toEqual({ branch_id: 'b', api_key: '[redacted]' })
  })

  it('a change to another settings key leaves test_phones masked but NOT marked changed', async () => {
    await runSql(db, `UPDATE public.locations SET settings = jsonb_set(settings, '{customer_agent,enabled}', 'true') WHERE id = '${LOC_A}'`)
    const d = await lastDetails(db, 'locations.updated')
    expect(JSON.stringify(d)).not.toMatch(/\+3530000000/)
    expect(d.before.settings.customer_agent).toEqual({ enabled: false, test_phones: '[redacted]' })
    expect(d.after.settings.customer_agent).toEqual({ enabled: true, test_phones: '[redacted]' })
  })

  it('PII: null, "" and [] stay visible; a non-empty list is masked, whatever the key case', async () => {
    const { rows: [r] } = await db.query(`SELECT private.audit_redact($1::jsonb) AS out`, [JSON.stringify({
      a: { test_phones: null }, b: { test_phones: '' }, c: { test_phones: [] }, d: { test_phones: ['x'] }, e: { Test_Phones: ['x'] },
    })])
    expect(r.out).toEqual({ a: { test_phones: null }, b: { test_phones: '' }, c: { test_phones: [] }, d: { test_phones: '[redacted]' }, e: { Test_Phones: '[redacted]' } })
  })

  it("credentials are exactly 647's: an empty-array secret is still masked (the [] rule is PII-only)", async () => {
    const { rows: [r] } = await db.query(`SELECT private.audit_redact($1::jsonb) AS out`, [JSON.stringify({ tokens: [], api_token: 't', note: 'n' })])
    expect(r.out).toEqual({ tokens: '[redacted]', api_token: '[redacted]', note: 'n' })
  })

  it("on a credentials-only document both walkers return exactly what 647's did", async () => {
    const after = await walk(db, SECRETS_FIXTURE, ['settings.glofox.api_key', 'tokens'])
    expect(after).toEqual(before647)
    expect(JSON.stringify(after.out)).not.toMatch(/FAKESECRET/)
  })

  it('no helper is callable by a client role', async () => {
    const { rows } = await db.query(`
      SELECT f, has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE') AS callable
        FROM unnest(array['private.audit_is_pii_key(text)','private.audit_is_secret_key(text)',
                          'private.audit_redact(jsonb,text[],text,integer)','private.audit_secret_paths(jsonb,text,integer)']) f`)
    expect(rows.every((r) => r.callable === false)).toBe(true)
  })

  it('the audit trigger function is still SECURITY DEFINER with an empty search_path', async () => {
    const { rows: [r] } = await db.query(
      `SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'private.log_mutation()'::regprocedure`)
    expect(r).toEqual({ prosecdef: true, proconfig: ['search_path=""'] })
  })

  it('the SQL PII list is the JS one (src/lib/secret-keys.js AUDIT_PII_KEY_EXACT)', async () => {
    const { rows } = await db.query(`SELECT n, private.audit_is_pii_key(n) AS p FROM unnest($1::text[]) n`,
      [[...AUDIT_PII_KEY_EXACT, 'phone', 'test_phone', 'display_phone']])
    expect(Object.fromEntries(rows.map((r) => [r.n, r.p]))).toEqual({
      ...Object.fromEntries(AUDIT_PII_KEY_EXACT.map((k) => [k, true])),
      phone: false, test_phone: false, display_phone: false,
    })
  })

  it('re-applying the file is harmless (drop if exists, create or replace, the self-check)', async () => {
    await runSql(db, MIG_655)
    const { rows: [r] } = await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'audit_events'`)
    expect(r.n).toBe(0)
  })
})

describe('the self-check aborts the WHOLE file', () => {
  it('a second policy on audit_events leaves the policies, the grants and the functions exactly as they were', async () => {
    const db = await freshDb()
    await runSql(db, `CREATE POLICY audit_events_extra ON public.audit_events FOR SELECT TO authenticated USING (false)`)
    await expect(runSql(db, MIG_655)).rejects.toThrow(/AUDITRLS\.1: public\.audit_events still has a policy: audit_events_extra/)
    // The file is one transaction (BEGIN … COMMIT): a RAISE leaves it aborted
    // (the mig 646 test's pattern). ROLLBACK, then read the state.
    await runSql(db, 'ROLLBACK')
    const { rows: [r] } = await db.query(`
      SELECT (SELECT count(*)::int FROM pg_policies WHERE tablename = 'audit_events') AS policies,
             has_table_privilege('authenticated', 'public.audit_events', 'SELECT') AS auth_sel,
             to_regprocedure('private.audit_is_pii_key(text)') IS NULL AS no_pii_fn`)
    expect(r).toEqual({ policies: 2, auth_sel: true, no_pii_fn: true })
    await db.close()
  })

  it("the audit trigger's owner unable to run a helper aborts it (else every audit row would be audit_redaction_failed)", async () => {
    const db = await freshDb()
    // Another role owns the trigger function; the helpers stay postgres-owned
    // with PUBLIC's EXECUTE revoked, so that owner cannot call them.
    await runSql(db, `CREATE ROLE audit_other_owner NOLOGIN; ALTER FUNCTION private.log_mutation() OWNER TO audit_other_owner;`)
    await expect(runSql(db, MIG_655)).rejects.toThrow(/AUDITRLS\.1: the audit trigger's owner \(audit_other_owner\) cannot execute private\./)
    await runSql(db, 'ROLLBACK')
    const { rows: [r] } = await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'audit_events'`)
    expect(r.n).toBe(1)
    await db.close()
  })

  it('a missing audit trigger aborts it too (the attachment is part of the contract)', async () => {
    const db = await freshDb()
    const { rows: [t] } = await db.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.cars'::regclass AND NOT tgisinternal`)
    await runSql(db, `DROP TRIGGER ${t.tgname} ON public.cars`)
    await expect(runSql(db, MIG_655)).rejects.toThrow(/AUDITRLS\.1: the audit trigger runs on /)
    await runSql(db, 'ROLLBACK')
    const { rows: [r] } = await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'audit_events'`)
    expect(r.n).toBe(1)
    await db.close()
  })
})
