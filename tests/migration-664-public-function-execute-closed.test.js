// FNEXECSWEEP.1 — behavioural test for migration 664.
//
// Boots PGlite with prod's FUNCTION default privileges (pg_default_acl, 29 Sep
// 2026): for role postgres, a per-schema entry in public giving EXECUTE to
// postgres, anon, authenticated and service_role, and NO global entry — so
// Postgres's own PUBLIC EXECUTE applies to every new function in every
// schema. It creates the 50 functions 664 names with prod's exact identity
// signatures and ACL shapes (stubs, except the four whose behaviour is
// asserted, which are verbatim from pg_get_functiondef), the two member-app
// RPCs with their mig 118/193 ACLs, a private RLS helper with a NULL ACL, and
// the live derive_wa_phone trigger on contacts in its post-653 state. Proves:
//
//   * BEFORE: anon can execute 50 public functions, authenticated 52, PUBLIC
//     47; a new function in any schema opens to PUBLIC; and the row's literal
//     fix (IN SCHEMA public REVOKE … FROM PUBLIC) changes nothing;
//   * AFTER: anon nothing, authenticated only the two member RPCs (which still
//     return rows), PUBLIC nothing; service_role still runs a webhook counter
//     and the derive_wa_phone → normalize_ie_wa_phone path; a client UPDATE
//     still fires a trigger whose function it cannot execute; a new public
//     function is service_role-only while private/extensions keep PUBLIC; the
//     private helper keeps its NULL ACL;
//   * an INVOKER trigger's BODY is permission-checked as the firing role (why
//     contacts must stay client-write-free, mig 653);
//   * the self-check aborts the WHOLE file on another grantor's grant, an
//     inherited EXECUTE, an unaudited new function and a lost member RPC; a
//     second run passes; the rollback record restores every ACL and default.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_664 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/664_public_function_execute_closed.sql'), 'utf8')

// The rollback record from the C67 plan (Task 5 Step 7), verbatim.
const ROLLBACK_664 = `
BEGIN;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA extensions REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.bump_presentation_version(uuid, integer),
  public.claim_recon_hunt_batch(integer),
  public.funnel_step_counts(uuid, timestamp with time zone, text),
  public.hyrox_coaches_on_shift(uuid, timestamp with time zone, timestamp with time zone),
  public.increment_car_xero_issue_count(uuid),
  public.increment_email_send_clicks(uuid),
  public.increment_email_send_opens(uuid),
  public.increment_email_ticket_unread(uuid),
  public.increment_instagram_conversation_unread(uuid),
  public.increment_whatsapp_broadcast_metric(uuid, text, integer),
  public.increment_whatsapp_conversation_unread(uuid),
  public.increment_whatsapp_template_sent(uuid, integer),
  public.normalize_ie_wa_phone(text),
  public.record_bca_event(uuid, text, timestamp with time zone),
  public.upsert_supplier_default(uuid, text, text, text, text, text),
  public.whatsapp_spend_rollup(uuid, timestamp with time zone),
  public.auto_unsubscribe_classpass(),
  public.campaigns_block_sent_delete(),
  public.campaigns_lock_sent_content(),
  public.checklist_instances_touch_updated_at(),
  public.checklist_templates_touch_updated_at(),
  public.derive_wa_phone(),
  public.equipment_touch_updated_at(),
  public.fte_expense_claims_touch_updated_at(),
  public.host_campaigns_block_sent_delete(),
  public.invoices_queue_touch_updated_at(),
  public.issues_touch_updated_at(),
  public.log_wa_message_to_timeline(),
  public.policies_set_updated_at(),
  public.reset_email_status_on_address_change(),
  public.shift_assignments_warn_overlap(),
  public.sms_broadcasts_set_updated_at(),
  public.stamp_deal_stage_entered(),
  public.sync_activity_done_status(),
  public.tg_contractor_invoices_validate_period(),
  public.touch_achievement_rules_updated_at(),
  public.touch_contact_devices_updated_at(),
  public.touch_contact_goals_updated_at(),
  public.touch_hr_provider_connections_updated_at(),
  public.touch_service_integrations_updated_at(),
  public.update_holiday_allowance(),
  public.update_updated_at(),
  public.xero_accounts_touch_updated_at(),
  public.xero_contacts_touch_updated_at(),
  public.xero_supplier_defaults_touch_updated_at(),
  public.xero_tax_rates_touch_updated_at()
TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_invoice_analysis_batch(integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.increment_sms_broadcast_delivered(uuid),
  public.increment_sms_broadcast_metric(uuid, text, integer),
  public.increment_sms_broadcast_undelivered(uuid)
TO anon, authenticated;
COMMIT;
`

// §1 A — the 20 server-only RPCs, by identity signature (prod pg_proc, 29 Sep).
const SERVER_RPCS = [
  'bump_presentation_version(uuid, integer)',
  'claim_invoice_analysis_batch(integer)',
  'claim_recon_hunt_batch(integer)',
  'funnel_step_counts(uuid, timestamp with time zone, text)',
  'hyrox_coaches_on_shift(uuid, timestamp with time zone, timestamp with time zone)',
  'increment_car_xero_issue_count(uuid)',
  'increment_email_send_clicks(uuid)',
  'increment_email_send_opens(uuid)',
  'increment_email_ticket_unread(uuid)',
  'increment_instagram_conversation_unread(uuid)',
  'increment_sms_broadcast_delivered(uuid)',
  'increment_sms_broadcast_metric(uuid, text, integer)',
  'increment_sms_broadcast_undelivered(uuid)',
  'increment_whatsapp_broadcast_metric(uuid, text, integer)',
  'increment_whatsapp_conversation_unread(uuid)',
  'increment_whatsapp_template_sent(uuid, integer)',
  'normalize_ie_wa_phone(text)',
  'record_bca_event(uuid, text, timestamp with time zone)',
  'upsert_supplier_default(uuid, text, text, text, text, text)',
  'whatsapp_spend_rollup(uuid, timestamp with time zone)',
]
// §1 B — the 30 trigger functions with the full default ACL.
const TRIGGER_FNS = [
  'auto_unsubscribe_classpass', 'campaigns_block_sent_delete', 'campaigns_lock_sent_content',
  'checklist_instances_touch_updated_at', 'checklist_templates_touch_updated_at', 'derive_wa_phone',
  'equipment_touch_updated_at', 'fte_expense_claims_touch_updated_at', 'host_campaigns_block_sent_delete',
  'invoices_queue_touch_updated_at', 'issues_touch_updated_at', 'log_wa_message_to_timeline',
  'policies_set_updated_at', 'reset_email_status_on_address_change', 'shift_assignments_warn_overlap',
  'sms_broadcasts_set_updated_at', 'stamp_deal_stage_entered', 'sync_activity_done_status',
  'tg_contractor_invoices_validate_period', 'touch_achievement_rules_updated_at', 'touch_contact_devices_updated_at',
  'touch_contact_goals_updated_at', 'touch_hr_provider_connections_updated_at', 'touch_service_integrations_updated_at',
  'update_holiday_allowance', 'update_updated_at', 'xero_accounts_touch_updated_at',
  'xero_contacts_touch_updated_at', 'xero_supplier_defaults_touch_updated_at', 'xero_tax_rates_touch_updated_at',
]
const KEEP = ['list_enabled_integrations', 'scan_straps_for_contact']
// Prod ACL shapes that differ from the full default (§1 A).
const PUBLIC_ONLY = ['claim_invoice_analysis_batch(integer)']
const NO_PUBLIC = ['increment_sms_broadcast_delivered(uuid)', 'increment_sms_broadcast_metric(uuid, text, integer)', 'increment_sms_broadcast_undelivered(uuid)']

const nameOf = (sig) => sig.slice(0, sig.indexOf('('))
const argsOf = (sig) => sig.slice(sig.indexOf('(') + 1, -1)
const ALL_50 = [...SERVER_RPCS.map(nameOf), ...TRIGGER_FNS].sort()
const sorted = (a) => [...a].sort()

// Verbatim bodies (pg_get_functiondef, 29 Sep) where behaviour is asserted.
const VERBATIM = {
  increment_whatsapp_conversation_unread: `
    CREATE FUNCTION public.increment_whatsapp_conversation_unread(p_conversation_id uuid)
     RETURNS void LANGUAGE sql SET search_path TO ''
    AS $function$
      update public.whatsapp_conversations set unread_count = coalesce(unread_count,0) + 1 where id = p_conversation_id;
    $function$;`,
  normalize_ie_wa_phone: `
    CREATE FUNCTION public.normalize_ie_wa_phone(p text)
     RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
    AS $function$
    DECLARE d text;
    BEGIN
      IF p IS NULL OR p = '' THEN RETURN NULL; END IF;
      d := regexp_replace(p, '[^0-9]', '', 'g');
      IF d LIKE '00%' THEN d := substr(d, 3); END IF;
      IF    d ~ '^3538[35679][0-9]{7}$' THEN RETURN d;
      ELSIF d ~ '^08[35679][0-9]{7}$'   THEN RETURN '353' || substr(d, 2);
      ELSIF d ~ '^8[35679][0-9]{7}$'    THEN RETURN '353' || d;
      END IF;
      RETURN NULL;
    END; $function$;`,
  derive_wa_phone: `
    CREATE FUNCTION public.derive_wa_phone()
     RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
    AS $function$
    BEGIN
      IF (NEW.wa_phone IS NULL OR NEW.wa_phone = '') THEN
        NEW.wa_phone := normalize_ie_wa_phone(NEW.phone);
      END IF;
      RETURN NEW;
    END; $function$;`,
  update_updated_at: `
    CREATE FUNCTION public.update_updated_at()
     RETURNS trigger LANGUAGE plpgsql SET search_path TO ''
    AS $function$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $function$;`,
}

const serverStub = (sig) => VERBATIM[nameOf(sig)]
  ?? `CREATE FUNCTION public.${nameOf(sig)}(${argsOf(sig)}) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;`
const triggerStub = (name) => VERBATIM[name]
  ?? `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`

const MASTER = '10000000-0000-0000-0000-000000000001'
const STAFF = '10000000-0000-0000-0000-000000000002'
const CONV = '20000000-0000-0000-0000-000000000001'
const ISSUE = '30000000-0000-0000-0000-000000000001'
const CONTACT = '40000000-0000-0000-0000-000000000001'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_grantor NOLOGIN;
  CREATE ROLE sneaky NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  CREATE SCHEMA extensions;
  GRANT USAGE ON SCHEMA auth, public, extensions TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated, service_role;   -- live: anon has none

  -- prod pg_default_acl for postgres (29 Sep 2026): per-schema rows in public
  -- only; NO global row, so the built-in PUBLIC EXECUTE applies everywhere.
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO postgres, anon, authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL);
  REVOKE ALL ON public.profiles FROM anon, authenticated;

  -- A private RLS helper as live: SECURITY DEFINER, NULL proacl (so PUBLIC
  -- EXECUTE is how authenticated reaches it). Shape of private.auth_is_master().
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role = 'master')
  $$;

  CREATE TABLE public.whatsapp_conversations (id uuid PRIMARY KEY, unread_count integer);
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.whatsapp_conversations FROM anon, authenticated;  -- mig 661

  CREATE TABLE public.contacts (id uuid PRIMARY KEY, phone text, wa_phone text);
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.contacts FROM anon, authenticated;  -- mig 653
  REVOKE ALL ON public.contacts FROM anon;                                                                   -- mig 657

  -- A table a signed-in client may UPDATE (masters, by RLS), with an updated_at trigger.
  CREATE TABLE public.issues (id uuid PRIMARY KEY, title text, updated_at timestamptz);
  ALTER TABLE public.issues ENABLE ROW LEVEL SECURITY;
  CREATE POLICY issues_master ON public.issues FOR ALL TO authenticated
    USING ((SELECT private.auth_is_master())) WITH CHECK ((SELECT private.auth_is_master()));

  -- A HYPOTHETICAL client-writable table carrying derive_wa_phone: what
  -- contacts would be without mig 653.
  CREATE TABLE public.phone_scratch (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text, wa_phone text);

  CREATE TABLE public.service_integrations (provider text PRIMARY KEY, display_name text, is_enabled boolean, client_id text, client_secret text);
  REVOKE ALL ON public.service_integrations FROM anon, authenticated;
`

const FUNCTIONS = () => [
  ...SERVER_RPCS.map(serverStub),
  ...TRIGGER_FNS.map(triggerStub),
  // prod ACL shapes that are not the full default
  ...PUBLIC_ONLY.map((s) => `REVOKE EXECUTE ON FUNCTION public.${s} FROM anon, authenticated;`),
  ...NO_PUBLIC.map((s) => `REVOKE EXECUTE ON FUNCTION public.${s} FROM PUBLIC;`),
  // the two member-app RPCs, as migs 118 / 193 left them
  `CREATE FUNCTION public.list_enabled_integrations()
     RETURNS TABLE(provider text, display_name text) LANGUAGE sql STABLE SECURITY DEFINER
     SET search_path TO 'public', 'pg_temp'
   AS $function$
     SELECT provider, display_name FROM public.service_integrations
      WHERE is_enabled AND client_id IS NOT NULL AND client_secret IS NOT NULL ORDER BY display_name;
   $function$;
   REVOKE ALL ON FUNCTION public.list_enabled_integrations() FROM PUBLIC;
   REVOKE EXECUTE ON FUNCTION public.list_enabled_integrations() FROM anon;
   GRANT EXECUTE ON FUNCTION public.list_enabled_integrations() TO authenticated;`,
  `CREATE FUNCTION public.scan_straps_for_contact() RETURNS TABLE(n integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT 0 $$;
   REVOKE ALL ON FUNCTION public.scan_straps_for_contact() FROM PUBLIC;
   REVOKE EXECUTE ON FUNCTION public.scan_straps_for_contact() FROM anon;
   GRANT EXECUTE ON FUNCTION public.scan_straps_for_contact() TO authenticated;`,
  // live triggers
  `CREATE TRIGGER derive_wa_phone_trigger BEFORE INSERT OR UPDATE OF phone ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.derive_wa_phone();`,
  `CREATE TRIGGER derive_wa_phone_scratch BEFORE INSERT ON public.phone_scratch FOR EACH ROW EXECUTE FUNCTION public.derive_wa_phone();`,
  `CREATE TRIGGER issues_touch BEFORE UPDATE ON public.issues FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();`,
].join('\n')

const SEED = `
  INSERT INTO public.profiles VALUES ('${MASTER}', 'master'), ('${STAFF}', 'staff');
  INSERT INTO public.whatsapp_conversations VALUES ('${CONV}', 0);
  INSERT INTO public.issues VALUES ('${ISSUE}', 'synthetic', '2000-01-01');
  INSERT INTO public.service_integrations VALUES ('synthetic_provider', 'Synthetic', true, 'fake-id', 'fake-secret');
`

const BEFORE_DEFAULTS = ['public anon:EXECUTE', 'public authenticated:EXECUTE', 'public postgres:EXECUTE', 'public service_role:EXECUTE']
const AFTER_DEFAULTS = ['<global> postgres:EXECUTE', 'extensions PUBLIC:EXECUTE', 'private PUBLIC:EXECUTE', 'public postgres:EXECUTE', 'public service_role:EXECUTE']

let db
const runSql = (text) => db['exec'](text)

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

/** Sorted names of the public functions `role` can EXECUTE ('public' = PUBLIC). */
async function executableBy(role) {
  const { rows } = await db.query(
    `SELECT p.proname AS name FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege($1, p.oid, 'EXECUTE')`, [role])
  return sorted(rows.map((r) => r.name))
}

/** postgres's default ACL items for functions, as 'schema grantee:priv', sorted. */
async function defaultAcls() {
  const { rows } = await db.query(`
    SELECT coalesce(n.nspname, '<global>') || ' ' || coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type AS item
      FROM pg_default_acl d
      LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE d.defaclrole = 'postgres'::regrole AND d.defaclobjtype = 'f'`)
  return sorted(rows.map((r) => r.item))
}

/** Every public function's ACL items (NULL ACL expanded to the built-in default). */
async function fnAcls() {
  const { rows } = await db.query(`
    SELECT p.oid::regprocedure::text AS f,
           coalesce(string_agg(coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ','
                    ORDER BY coalesce(r.rolname, 'PUBLIC')), '') AS items
      FROM pg_proc p
      LEFT JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a ON true
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE p.pronamespace = 'public'::regnamespace
     GROUP BY 1`)
  return Object.fromEntries(rows.map((r) => [r.f, r.items]))
}

/** Who can execute a brand-new function in `schema` (created and dropped here). */
async function newFunctionCan(schema) {
  await runSql(`CREATE FUNCTION ${schema}._t_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'`)
  const out = {}
  for (const role of ['anon', 'authenticated', 'service_role', 'public']) {
    const { rows: [r] } = await db.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS can`, [role, `${schema}._t_probe()`])
    out[role] = r.can
  }
  await runSql(`DROP FUNCTION ${schema}._t_probe()`)
  return out
}
const OPEN = { anon: true, authenticated: true, service_role: true, public: true }
const SERVER_ONLY = { anon: false, authenticated: false, service_role: true, public: false }

async function boot({ migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(FUNCTIONS())
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_664)
}

describe('before 664 — prod, 29 Sep 2026', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('anon can execute the 50; authenticated the 50 + the two member RPCs; PUBLIC 47', async () => {
    expect(await executableBy('anon')).toEqual(ALL_50)
    expect(await executableBy('authenticated')).toEqual(sorted([...ALL_50, ...KEEP]))
    expect((await executableBy('public')).length).toBe(47)
  })

  it('the default privileges are prod\'s, and a new function in ANY schema opens to PUBLIC', async () => {
    expect(await defaultAcls()).toEqual(BEFORE_DEFAULTS)
    for (const schema of ['public', 'private', 'extensions']) expect(await newFunctionCan(schema), schema).toEqual(OPEN)
  })

  it('a client-fired INVOKER trigger can call normalize_ie_wa_phone today', async () => {
    expect(await asUser(STAFF, `INSERT INTO public.phone_scratch (phone) VALUES ('083 000 0000') RETURNING wa_phone`))
      .toEqual([{ wa_phone: '353830000000' }])
  })
})

describe("the row's literal fix is a no-op", () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('IN SCHEMA public REVOKE … FROM PUBLIC cannot remove the built-in (global) PUBLIC default', async () => {
    await runSql('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC')
    expect((await newFunctionCan('public')).public).toBe(true)
    expect((await newFunctionCan('public')).anon).toBe(true)
  })
})

describe('after 664 — the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it('anon: nothing; PUBLIC: nothing; authenticated: the two member RPCs only', async () => {
    expect(await executableBy('anon')).toEqual([])
    expect(await executableBy('public')).toEqual([])
    expect(await executableBy('authenticated')).toEqual(sorted(KEEP))
  })

  it('service_role can still execute every public function', async () => {
    expect((await executableBy('service_role')).length).toBe(52)
  })

  it('the defaults: public is service_role-only; private and extensions keep PUBLIC', async () => {
    expect(await defaultAcls()).toEqual(AFTER_DEFAULTS)
    expect(await newFunctionCan('public')).toEqual(SERVER_ONLY)
    expect(await newFunctionCan('private')).toEqual(OPEN)
    expect(await newFunctionCan('extensions')).toEqual(OPEN)
  })

  it('the private RLS helper is untouched (NULL ACL, authenticated still executes it)', async () => {
    const { rows: [r] } = await db.query(
      `SELECT proacl IS NULL AS null_acl, has_function_privilege('authenticated', oid, 'EXECUTE') AS auth
         FROM pg_proc WHERE oid = 'private.auth_is_master()'::regprocedure`)
    expect(r).toEqual({ null_acl: true, auth: true })
  })
})

describe('after 664 — people', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it('anon and a staff session: a server RPC is refused', async () => {
    const call = `SELECT public.increment_whatsapp_conversation_unread('${CONV}')`
    await expect(asRole('anon', call)).rejects.toThrow(/permission denied for function increment_whatsapp_conversation_unread/)
    await expect(asUser(STAFF, call)).rejects.toThrow(/permission denied for function increment_whatsapp_conversation_unread/)
  })

  it('service_role: the WhatsApp webhook counter still increments', async () => {
    const rows = await asRole('service_role',
      `SELECT public.increment_whatsapp_conversation_unread('${CONV}')`,
      `SELECT unread_count FROM public.whatsapp_conversations WHERE id = '${CONV}'`)
    expect(rows).toEqual([{ unread_count: 1 }])
  })

  it('signed-in member: both member RPCs still return rows; anon still cannot call them', async () => {
    expect(await asUser(STAFF, 'SELECT provider FROM public.list_enabled_integrations()')).toEqual([{ provider: 'synthetic_provider' }])
    expect(await asUser(STAFF, 'SELECT n FROM public.scan_straps_for_contact()')).toEqual([{ n: 0 }])
    await expect(asRole('anon', 'SELECT * FROM public.list_enabled_integrations()')).rejects.toThrow(/permission denied for function list_enabled_integrations/)
  })

  it('a client UPDATE still fires a trigger whose function it cannot EXECUTE', async () => {
    const { rows: [r] } = await db.query(`SELECT has_function_privilege('authenticated', 'public.update_updated_at()', 'EXECUTE') AS can`)
    expect(r.can).toBe(false)
    expect(await asUser(MASTER,
      `UPDATE public.issues SET title = 'synthetic 2' WHERE id = '${ISSUE}' RETURNING updated_at > '2000-01-02'::timestamptz AS touched`))
      .toEqual([{ touched: true }])
  })

  it('service_role: a contacts insert still derives wa_phone (derive_wa_phone → normalize_ie_wa_phone)', async () => {
    expect(await asRole('service_role', `INSERT INTO public.contacts (id, phone) VALUES ('${CONTACT}', '083 000 0000') RETURNING wa_phone`))
      .toEqual([{ wa_phone: '353830000000' }])
  })

  it("an INVOKER trigger's BODY is checked as the firing role — which is why contacts must stay client-write-free (mig 653)", async () => {
    await expect(asUser(STAFF, `INSERT INTO public.phone_scratch (phone) VALUES ('083 000 0000')`))
      .rejects.toThrow(/permission denied for function normalize_ie_wa_phone/)
    const { rows: [r] } = await db.query(
      `SELECT has_table_privilege('authenticated', 'public.contacts', 'INSERT') AS i,
              has_table_privilege('authenticated', 'public.contacts', 'UPDATE') AS u`)
    expect(r).toEqual({ i: false, u: false })
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message) {
    await boot({ before })
    await expect(runSql(MIG_664)).rejects.toThrow(message)
    await runSql('ROLLBACK')
    // Nothing applied.
    expect(await executableBy('anon')).toEqual(expect.arrayContaining(['bump_presentation_version', 'update_updated_at']))
    expect(await defaultAcls()).toEqual(BEFORE_DEFAULTS)
  }

  it("when another grantor's EXECUTE to anon survives the REVOKE", () => expectAbort(
    `GRANT EXECUTE ON FUNCTION public.bump_presentation_version(uuid, integer) TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor;
     GRANT EXECUTE ON FUNCTION public.bump_presentation_version(uuid, integer) TO anon;
     RESET ROLE;`,
    /mig 664: anon can still execute: .*bump_presentation_version\(uuid,integer\)/,
  ), 60_000)

  it('when authenticated inherits EXECUTE through role membership', () => expectAbort(
    `GRANT EXECUTE ON FUNCTION public.funnel_step_counts(uuid, timestamp with time zone, text) TO sneaky;
     GRANT sneaky TO authenticated;`,
    /mig 664: authenticated can execute functions outside the keep list: .*funnel_step_counts/,
  ), 60_000)

  it('when a function nobody audited appeared before the apply', () => expectAbort(
    `CREATE FUNCTION public.brand_new_rpc() RETURNS integer LANGUAGE sql AS 'SELECT 1';`,
    /mig 664: anon can still execute: .*brand_new_rpc\(\)/,
  ), 60_000)

  it('when a member RPC has already lost EXECUTE (a live screen would be broken)', () => expectAbort(
    `REVOKE EXECUTE ON FUNCTION public.list_enabled_integrations() FROM authenticated;`,
    /mig 664: authenticated lost EXECUTE on (public\.)?list_enabled_integrations\(\)/,
  ), 60_000)

  it('a second run passes (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_664)).resolves.toBeDefined()
    expect(await defaultAcls()).toEqual(AFTER_DEFAULTS)
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores every function ACL and the default privileges exactly (as sets)', async () => {
    await boot()
    const before = { fns: await fnAcls(), defaults: await defaultAcls() }
    await runSql(MIG_664)
    await runSql(ROLLBACK_664)
    expect(await fnAcls()).toEqual(before.fns)
    expect(await defaultAcls()).toEqual(before.defaults)
    expect(await newFunctionCan('public')).toEqual(OPEN)
  }, 60_000)
})
