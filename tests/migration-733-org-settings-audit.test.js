// ORGSETAUDIT.1 — behavioural test for migration 733.
//
// Boots PGlite with the audit machinery exactly as prod has it, by replaying
// the real migrations 191 (log_mutation + the six audit_mutation triggers),
// 647 (key-name redaction) and 655 (PII keys), on the reduced tables of
// tests/migration-655-audit-events-client-closed.test.js, plus org_settings in
// prod column order. audit_events.actor_id references profiles(id) as on prod.
// It proves:
//
//   * BEFORE: attaching log_mutation to org_settings as-is names every row
//     'org_settings/?' and records no actor for a service-role write;
//   * AFTER: rows read 'org_settings/<organization_id>' (created, updated,
//     deleted); a service-role API write is credited to updated_by, a cron
//     write that clears updated_by to nobody, a postgres/migration write to
//     nobody, a signed-in write to auth.uid() whatever updated_by says, a
//     DELETE to nobody; updated_at alone writes no row; caps, alert
//     addresses and legal names are kept, a secret-named key inside
//     customer_agent is redacted; the SET ROLE path works without claims;
//     an actor column holding a non-uuid is ignored, never an error;
//   * the six existing triggers behave exactly as before (target <table>/<id>,
//     actor auth.uid(), no fallback);
//   * the self-check aborts the whole file on a seventh unknown table, a
//     disabled audit trigger and a function owner other than postgres; a
//     second run passes; the rollback (drop the trigger, re-run 647's body)
//     restores the function byte-for-byte.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// PGlite's multi-statement SQL runner (an in-process database call, not a shell).
const runSql = (db, text) => db['exec'](text)

const MIG_DIR = path.resolve(import.meta.dirname, '../supabase/migrations')
const MIG_191 = readFileSync(path.join(MIG_DIR, '191_audit_mutation_triggers.sql'), 'utf8')
const MIG_647 = readFileSync(path.join(MIG_DIR, '647_audit_redact_secrets.sql'), 'utf8')
const MIG_655 = readFileSync(path.join(MIG_DIR, '655_audit_events_client_closed.sql'), 'utf8')
const MIG_733 = readFileSync(path.join(MIG_DIR, '733_org_settings_audit.sql'), 'utf8')

// Mig 647's log_mutation, verbatim: the live body before 733 (655 changed only
// the redaction helpers). The rollback re-runs it.
const LOG_MUTATION_647 = (() => {
  const start = MIG_647.search(/create or replace function private\.log_mutation\(\)/i)
  const end = MIG_647.indexOf('\n$$;', start)
  if (start < 0 || end < 0) throw new Error('mig 647 log_mutation not found')
  return MIG_647.slice(start, end + 4)
})()
const ROLLBACK_733 = `
BEGIN;
DROP TRIGGER IF EXISTS audit_mutation ON public.org_settings;
${LOG_MUTATION_647}
COMMIT;
`

const ORG_A = 'c0000000-0000-0000-0000-00000000000a'
const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const ADMIN = '10000000-0000-0000-0000-00000000000a'
const ADMIN_2 = '10000000-0000-0000-0000-00000000000b'
const OWNER = '10000000-0000-0000-0000-00000000000c'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_owner NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO authenticated, anon, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon, service_role;

  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, full_name text, role text, active boolean DEFAULT true,
    deleted_at timestamptz, pin_hash text, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    category text NOT NULL, action text NOT NULL,
    actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    actor_label text, target_profile_id uuid, target_label text,
    target_resource text, location_id uuid, details jsonb, ip_address inet, user_agent text,
    -- Test-only: insert order (PGlite's clock can repeat occurred_at).
    seq bigint GENERATED ALWAYS AS IDENTITY
  );
  ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

  CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.locations (
    id uuid PRIMARY KEY, name text, organization_id uuid, settings jsonb DEFAULT '{}'::jsonb,
    sensibo_api_key text, thinq_pat text, bca_config jsonb, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.profile_locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid, location_id uuid, role text, unifi_synced_at timestamptz);
  CREATE TABLE public.cars (id uuid PRIMARY KEY, location_id uuid, status text, deposit_token uuid, deposit_revolut_checkout_url text, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.invoices_queue (id uuid PRIMARY KEY, location_id uuid, status text, updated_at timestamptz DEFAULT now());

  -- org_settings: PROD column order (17 Oct 2026); constraints reduced to the keys.
  CREATE TABLE public.org_settings (
    organization_id uuid NOT NULL PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
    logo_url text, favicon_url text, company_name text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES public.profiles(id),
    ai_hard_cap_cents numeric, email_hard_cap_sends integer,
    ai_cap_notice_month text, email_cap_notice_month text,
    ops_alert_emails text[],
    legal_entity_name text, legal_trading_name text, legal_address text, privacy_contact_email text,
    short_name text, customer_agent jsonb
  );
  CREATE FUNCTION private.touch_org_settings_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
  BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER org_settings_touch_updated_at BEFORE UPDATE ON public.org_settings
    FOR EACH ROW EXECUTE FUNCTION private.touch_org_settings_updated_at();

  -- The server and the test's signed-in session may write every table here
  -- (the grants are not what this file tests; mig 730 owns org_settings').
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role, authenticated;
`

const SEED = `
  INSERT INTO public.profiles (id, full_name, role) VALUES
    ('${ADMIN}', 'Admin A', 'owner'), ('${ADMIN_2}', 'Admin B', 'owner'), ('${OWNER}', 'Owner C', 'owner');
  INSERT INTO public.organizations VALUES ('${ORG_A}', 'Org A');
  INSERT INTO public.locations (id, name, organization_id) VALUES ('${LOC_A}', 'Studio A', '${ORG_A}');
`

let db
afterEach(async () => { await db?.close(); db = null })

async function freshDb({ migrate = true, before = '' } = {}) {
  db = new PGlite()
  await runSql(db, BASE_SCHEMA)
  await runSql(db, MIG_191)
  await runSql(db, MIG_647)
  await runSql(db, MIG_655)
  // Prod EXECUTE since mig 678: {postgres, authenticated, service_role}, no PUBLIC.
  await runSql(db, `REVOKE EXECUTE ON FUNCTION private.log_mutation() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION private.log_mutation() TO authenticated, service_role;`)
  await runSql(db, SEED)
  await runSql(db, 'TRUNCATE public.audit_events')
  if (before) await runSql(db, before)
  if (migrate) await runSql(db, MIG_733)
  return db
}

/** Run statements as the PostgREST service-role request does: claims + SET LOCAL ROLE. COMMITS. */
async function asService(sqls, { claims = true } = {}) {
  await runSql(db, 'BEGIN')
  if (claims) await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })])
  await runSql(db, 'SET LOCAL ROLE service_role')
  for (const s of [].concat(sqls)) await db.query(s)
  await runSql(db, 'COMMIT')
}

/** A signed-in session (auth.uid() = sub). COMMITS. */
async function asUser(sub, sqls) {
  await runSql(db, 'BEGIN')
  await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role: 'authenticated' })])
  await runSql(db, 'SET LOCAL ROLE authenticated')
  for (const s of [].concat(sqls)) await db.query(s)
  await runSql(db, 'COMMIT')
}

async function rows(action) {
  const { rows: r } = await db.query(
    `SELECT action, actor_id, target_resource, location_id, details FROM public.audit_events
      WHERE ($1::text IS NULL OR action = $1) ORDER BY seq`, [action ?? null])
  return r
}
const last = async (action) => (await rows(action)).at(-1)

const CREATE_ROW = `INSERT INTO public.org_settings (organization_id, company_name, ai_hard_cap_cents, ops_alert_emails, legal_entity_name, updated_by)
  VALUES ('${ORG_A}', 'Synthetic Group', 5000, ARRAY['ops@example.invalid'], 'Synthetic Ltd', '${ADMIN}')`

describe('before 733 — log_mutation as mig 647 left it', () => {
  it("names every org_settings row 'org_settings/?' and credits a service-role write to nobody", async () => {
    await freshDb({ migrate: false })
    await runSql(db, `CREATE TRIGGER audit_mutation AFTER INSERT OR UPDATE OR DELETE ON public.org_settings
      FOR EACH ROW EXECUTE FUNCTION private.log_mutation();`)
    await asService([CREATE_ROW, `UPDATE public.org_settings SET ai_hard_cap_cents = NULL WHERE organization_id = '${ORG_A}'`])
    const r = await last('org_settings.updated')
    expect(r.target_resource).toBe('org_settings/?')
    expect(r.actor_id).toBeNull()
    expect(r.details.after).toEqual({ ai_hard_cap_cents: null }) // nothing says which organisation
  }, 60_000)
})

describe('after 733 — org_settings', () => {
  it('an admin save (service role) is created/updated under the org, credited to updated_by, values kept', async () => {
    await freshDb()
    await asService(CREATE_ROW)
    const created = await last('org_settings.created')
    expect(created).toMatchObject({ actor_id: ADMIN, target_resource: `org_settings/${ORG_A}`, location_id: null })
    expect(created.details.after).toMatchObject({
      organization_id: ORG_A, ai_hard_cap_cents: 5000, ops_alert_emails: ['ops@example.invalid'], legal_entity_name: 'Synthetic Ltd',
    })

    // The same admin saves again (updated_by unchanged): still theirs.
    await asService(`UPDATE public.org_settings SET ai_hard_cap_cents = NULL, ops_alert_emails = ARRAY['x@example.invalid'], updated_by = '${ADMIN}'
      WHERE organization_id = '${ORG_A}'`)
    const upd = await last('org_settings.updated')
    expect(upd).toMatchObject({ actor_id: ADMIN, target_resource: `org_settings/${ORG_A}` })
    expect(upd.details).toEqual({
      before: { ai_hard_cap_cents: 5000, ops_alert_emails: ['ops@example.invalid'] },
      after: { ai_hard_cap_cents: null, ops_alert_emails: ['x@example.invalid'] },
    })

    // Another admin: credited to them, and the hand-over shows in the diff.
    await asService(`UPDATE public.org_settings SET legal_entity_name = 'Renamed Ltd', updated_by = '${ADMIN_2}' WHERE organization_id = '${ORG_A}'`)
    const upd2 = await last('org_settings.updated')
    expect(upd2.actor_id).toBe(ADMIN_2)
    expect(upd2.details.before).toEqual({ legal_entity_name: 'Synthetic Ltd', updated_by: ADMIN })
  }, 60_000)

  it("the usage-rollup cron's write (updated_by cleared) is credited to nobody", async () => {
    await freshDb()
    await asService(CREATE_ROW)
    await asService(`UPDATE public.org_settings SET ai_cap_notice_month = '2026-10', updated_by = NULL WHERE organization_id = '${ORG_A}'`)
    const r = await last('org_settings.updated')
    expect(r.actor_id).toBeNull()
    expect(r.details).toEqual({
      before: { ai_cap_notice_month: null, updated_by: ADMIN },
      after: { ai_cap_notice_month: '2026-10', updated_by: null },
    })
  }, 60_000)

  it('a migration / SQL editor write (postgres, no claim) never borrows updated_by', async () => {
    await freshDb()
    await asService(CREATE_ROW)
    await runSql(db, `UPDATE public.org_settings SET short_name = 'SYN' WHERE organization_id = '${ORG_A}'`)
    const r = await last('org_settings.updated')
    expect(r.actor_id).toBeNull()
    expect(r.target_resource).toBe(`org_settings/${ORG_A}`)
  }, 60_000)

  it('a signed-in write is credited to auth.uid(), whatever updated_by says', async () => {
    await freshDb()
    await asService(CREATE_ROW)
    await asUser(OWNER, `UPDATE public.org_settings SET company_name = 'Mine', updated_by = '${ADMIN}' WHERE organization_id = '${ORG_A}'`)
    expect((await last('org_settings.updated')).actor_id).toBe(OWNER)
  }, 60_000)

  it('SET ROLE service_role with no claims (the role GUC) still reads the actor column', async () => {
    await freshDb()
    await asService(CREATE_ROW, { claims: false })
    expect((await last('org_settings.created')).actor_id).toBe(ADMIN)
  }, 60_000)

  it('a change to updated_at alone writes no row; a DELETE (the org cascade) has no actor', async () => {
    await freshDb()
    await asService(CREATE_ROW)
    const n = (await rows()).length
    await asService(`UPDATE public.org_settings SET updated_at = now() + interval '1 hour' WHERE organization_id = '${ORG_A}'`)
    expect((await rows()).length).toBe(n)
    await asService(`DELETE FROM public.organizations WHERE id = '${ORG_A}'`)
    const del = await last('org_settings.deleted')
    expect(del).toMatchObject({ actor_id: null, target_resource: `org_settings/${ORG_A}` })
    expect(del.details.before).toMatchObject({ company_name: 'Synthetic Group', updated_by: ADMIN })
  }, 60_000)

  it('a secret-named key inside customer_agent is redacted; its copy is not', async () => {
    await freshDb()
    await asService(CREATE_ROW)
    await asService(`UPDATE public.org_settings SET customer_agent = '{"tone":"warm","webhook_secret":"FAKESECRET-1"}', updated_by = '${ADMIN}'
      WHERE organization_id = '${ORG_A}'`)
    const r = await last('org_settings.updated')
    expect(r.details.after.customer_agent).toEqual({ tone: 'warm', webhook_secret: '[redacted: changed]' })
    expect(JSON.stringify(r.details)).not.toContain('FAKESECRET')
  }, 60_000)

  it('an actor column holding a non-uuid is ignored, never an error (the write and its row both land)', async () => {
    await freshDb()
    await runSql(db, `CREATE TABLE public.scratch_audit (id uuid PRIMARY KEY, who text);
      GRANT ALL ON public.scratch_audit TO service_role;
      CREATE TRIGGER audit_mutation AFTER INSERT OR UPDATE OR DELETE ON public.scratch_audit
        FOR EACH ROW EXECUTE FUNCTION private.log_mutation('id', 'who');`)
    await asService(`INSERT INTO public.scratch_audit VALUES ('${ADMIN}', 'not-a-uuid')`)
    const r = await last('scratch_audit.created')
    expect(r).toMatchObject({ actor_id: null, target_resource: `scratch_audit/${ADMIN}` })
    expect(r.details.after).toEqual({ id: ADMIN, who: 'not-a-uuid' })
  }, 60_000)
})

describe('after 733 — the six existing triggers are unchanged', () => {
  it('target <table>/<id>, actor auth.uid() only; no fallback without arguments', async () => {
    await freshDb()
    await asService(`UPDATE public.organizations SET name = 'Org A2' WHERE id = '${ORG_A}'`)
    expect(await last('organizations.updated')).toMatchObject({ actor_id: null, target_resource: `organizations/${ORG_A}` })
    await asUser(OWNER, `UPDATE public.locations SET name = 'Studio A2' WHERE id = '${LOC_A}'`)
    expect(await last('locations.updated')).toMatchObject({ actor_id: OWNER, target_resource: `locations/${LOC_A}`, location_id: null })
    const { rows: t } = await db.query(`SELECT c.relname, t.tgnargs FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgfoid = 'private.log_mutation()'::regprocedure ORDER BY 1`)
    expect(t).toEqual([
      { relname: 'cars', tgnargs: 0 }, { relname: 'invoices_queue', tgnargs: 0 }, { relname: 'locations', tgnargs: 0 },
      { relname: 'org_settings', tgnargs: 2 }, { relname: 'organizations', tgnargs: 0 },
      { relname: 'profile_locations', tgnargs: 0 }, { relname: 'profiles', tgnargs: 0 },
    ])
  }, 60_000)

  it('the function kept DEFINER, its empty search_path and its EXECUTE ACL', async () => {
    await freshDb({ migrate: false })
    const q = `SELECT prosecdef, proconfig, proacl::text AS acl, proowner::regrole::text AS owner FROM pg_proc WHERE oid = 'private.log_mutation()'::regprocedure`
    const before = (await db.query(q)).rows[0]
    await runSql(db, MIG_733)
    expect((await db.query(q)).rows[0]).toEqual(before)
    expect(before.prosecdef).toBe(true)
  }, 60_000)
})

describe('the self-check aborts the whole file', () => {
  async function expectAbort(before, message) {
    await freshDb({ migrate: false, before })
    const fnBefore = (await db.query(`SELECT pg_get_functiondef('private.log_mutation()'::regprocedure) AS d`)).rows[0].d
    await expect(runSql(db, MIG_733)).rejects.toThrow(message)
    await runSql(db, 'ROLLBACK')
    expect((await db.query(`SELECT pg_get_functiondef('private.log_mutation()'::regprocedure) AS d`)).rows[0].d).toBe(fnBefore)
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.org_settings'::regclass AND tgname = 'audit_mutation'`)).rows[0].n).toBe(0)
  }

  it('when log_mutation runs on a table the file does not know', () => expectAbort(
    `CREATE TABLE public.xero_connections (id uuid PRIMARY KEY);
     CREATE TRIGGER log_changes AFTER INSERT OR UPDATE OR DELETE ON public.xero_connections FOR EACH ROW EXECUTE FUNCTION private.log_mutation();`,
    /mig 733: private\.log_mutation\(\) runs on .*xero_connections\(0\)/,
  ), 60_000)

  it('when one of the six audit triggers is disabled', () => expectAbort(
    `ALTER TABLE public.cars DISABLE TRIGGER audit_mutation;`,
    /mig 733: log_mutation trigger of the wrong shape or disabled: cars/,
  ), 60_000)

  it('when the function is owned by another role', () => expectAbort(
    `ALTER FUNCTION private.log_mutation() OWNER TO other_owner;`,
    /mig 733: private\.log_mutation\(\) is not owned by postgres/,
  ), 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await freshDb()
    await expect(runSql(db, MIG_733)).resolves.toBeDefined()
  }, 60_000)
})

describe('the rollback record', () => {
  it("drops the trigger and restores mig 647's function exactly", async () => {
    await freshDb({ migrate: false })
    const q = `SELECT pg_get_functiondef('private.log_mutation()'::regprocedure) AS d`
    const before = (await db.query(q)).rows[0].d
    await runSql(db, MIG_733)
    expect((await db.query(q)).rows[0].d).not.toBe(before)
    await runSql(db, ROLLBACK_733)
    expect((await db.query(q)).rows[0].d).toBe(before)
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.org_settings'::regclass AND NOT tgisinternal AND tgname = 'audit_mutation'`)).rows[0].n).toBe(0)
  }, 60_000)
})
