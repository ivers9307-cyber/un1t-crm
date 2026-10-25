// PASSCODEREAD.2 — behavioural test for migration 652.
//
// Boots PGlite with Supabase's DEFAULT PRIVILEGES, a contacts table whose
// first 94 columns are the ones contact_location_audience selects (live
// order, 29 Sep 2026), the view created the way mig 491 did (c.* expanded AT
// CREATION), then the 10 later contacts columns that never reached it, so
// the view has prod's 98 columns. glofox_push_events is in prod column order;
// contact_preferences and consent_log are the subset migs 660/662 touch.
//
// Prod when 652 applies (30 Sep 2026) has 651, 653, 657, 660 and 662 applied,
// so the view is already CLOSED to clients (662: relacl = postgres +
// service_role only). The replay runs those REAL files in that order before
// 652, and also runs everything in migration-number order (652 before 653…662,
// as a fresh database would), and proves:
//   * 652 refuses to run before 651 (or with a NOT VALID CHECK);
//   * after 652 both columns and both 651 CHECKs are gone; the view is the
//     captured column list minus glofox_passcode (same order/types, the 10
//     later columns still NOT added), security_invoker, same ACL, owner and
//     comment, and NO privilege for anon/authenticated/PUBLIC;
//     contacts/glofox_push_events ACLs unchanged;
//   * the view's readers (service-role shapes) return what they did; client
//     sessions are refused exactly as before; in number order (view still
//     open, pre-662) a staff read through security_invoker is unchanged;
//   * prod order and number order end in the same state;
//   * a new dependent view, or a view grant from another grantor, aborts the
//     WHOLE file; a second run passes; the rollback record restores.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const mig = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_651 = mig('651_retire_glofox_passcodes.sql')
const MIG_652 = mig('652_drop_glofox_passcode_columns.sql')
const MIG_653 = mig('653_contacts_client_writes_off.sql')
const MIG_657 = mig('657_anon_contacts_consent_drift_closed.sql')
const MIG_660 = mig('660_consent_tables_client_writes_off.sql')
const MIG_662 = mig('662_consent_tables_client_closed.sql')

// Prod on 30 Sep 2026, the state 652 applies to.
const PROD_BEFORE_652 = [MIG_651, MIG_653, MIG_657, MIG_660, MIG_662]
// A fresh database replays by number.
const NUMBER_ORDER = [MIG_651, MIG_652, MIG_653, MIG_657, MIG_660, MIG_662]

// contact_location_audience's contacts columns, live order (pg_get_viewdef, 29 Sep 2026).
const VIEW_CONTACT_COLS = `
  id name first_name last_name email phone label glofox_member_id trial_credits_remaining
  lead_source lead_created_at created_at updated_at source location_id last_emailed_at
  total_emails_sent total_emails_opened total_emails_clicked email_status tags wa_phone wa_status
  last_wa_message_at total_wa_sent total_wa_received sms_status created_via_import_id user_id
  max_hr_override hr_post_class_emails_enabled glofox_membership_status glofox_synced_at dob
  joined_at last_booked_at last_attended_at total_bookings_30d total_attended_30d
  total_noshow_30d recent_bookings lifetime_value_cents lifetime_transaction_count
  lifetime_currency last_payment_at last_invoice_at glofox_passcode total_attended_7d
  pipeline_stage_slug email_marketing glofox_membership_plan glofox_membership_state
  glofox_membership_expiry glofox_membership_price_cents glofox_billing_interval
  glofox_payment_method glofox_membership_type glofox_image_url gender emergency_contact
  glofox_signup_answers glofox_roaming_enabled glofox_account_active glofox_source
  glofox_membership_plan_full first_class_checkin_at person_group_id email_administrative
  weight_kg weight_kg_source weight_kg_at profile_setup_completed_at whatsapp_marketing
  is_primary_contact ctwa_clid ctwa_clid_at converted_at hr_leaderboard_opt_out push_prefs
  pack_customer_at utm_campaign utm_content utm_term ad_provider ad_external_id attributed_at
  pipeline_dismissed_at email_suppressed_at wa_bsuid last_marketing_touch_at
  glofox_membership_paused_at glofox_membership_resume_at gympass_member_id automations_exempt
`.trim().split(/\s+/)
// contacts columns added after mig 491 that the view never got (29 Sep 2026).
const LATER_COLS = ['last_email_open_at', 'last_email_click_at', 'email_hygiene_released_at', 'instagram_igsid',
  'instagram_handle', 'name_normalized', 'last_lead_source', 'last_lead_source_at', 'glofox_user_membership_id',
  'glofox_detail_due_at']
const CLP_COLS = ['audience_location_id', 'loc_email_marketing', 'loc_sms_marketing', 'loc_whatsapp_marketing']
const EXPECTED_AFTER = [...VIEW_CONTACT_COLS.filter((c) => c !== 'glofox_passcode'), ...CLP_COLS]

const colType = (c) => (['id'].includes(c) ? 'uuid PRIMARY KEY'
  : ['location_id', 'user_id'].includes(c) ? 'uuid'
  : ['email_marketing', 'email_administrative', 'whatsapp_marketing'].includes(c) ? 'boolean NOT NULL DEFAULT true' : 'text')

const ALL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
const VIEW_DENIED = /permission denied for view contact_location_audience/

// The rollback record (C50 plan Task 5 Step 7), with the REVOKE the C68 guard
// (tests/consent-tables-client-closed-guard.test.js) requires after any
// CREATE [OR REPLACE] VIEW contact_location_audience. CREATE OR REPLACE keeps
// the ACL, so after 662 the REVOKE is a no-op.
const VIEW_SELECT_LIST = [...VIEW_CONTACT_COLS.filter((c) => c !== 'glofox_passcode').map((c) => `c.${c}`),
  'clp.location_id AS audience_location_id', 'clp.email_marketing AS loc_email_marketing',
  'clp.sms_marketing AS loc_sms_marketing', 'clp.whatsapp_marketing AS loc_whatsapp_marketing'].join(', ')
const ROLLBACK_652 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS glofox_passcode text;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_glofox_passcode_retired CHECK (glofox_passcode IS NULL);
ALTER TABLE public.glofox_push_events ADD COLUMN IF NOT EXISTS passcode_sent text;
ALTER TABLE public.glofox_push_events ADD CONSTRAINT glofox_push_events_passcode_retired CHECK (passcode_sent IS NULL);
CREATE OR REPLACE VIEW public.contact_location_audience WITH (security_invoker = on) AS
  SELECT ${VIEW_SELECT_LIST}, c.glofox_passcode
    FROM public.contacts c JOIN public.contact_location_preferences clp ON clp.contact_id = c.id;
REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const STAFF = '10000000-0000-0000-0000-000000000001'
const C1 = '30000000-0000-0000-0000-000000000001'
const C2 = '30000000-0000-0000-0000-000000000002'
const PASSCODE = 'SYNTH-PC-0001'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_grantor NOLOGIN;
  CREATE ROLE sneaky NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  REVOKE SELECT ON public.profiles FROM anon, authenticated;

  CREATE TABLE public.contacts (${VIEW_CONTACT_COLS.map((c) => `${c} ${colType(c)}`).join(', ')});
  CREATE TABLE public.contact_location_preferences (
    contact_id uuid, location_id uuid, email_marketing boolean NOT NULL DEFAULT true,
    sms_marketing boolean NOT NULL DEFAULT true, whatsapp_marketing boolean NOT NULL DEFAULT true, source text
  );
  -- The two other consent tables, the columns migs 660/662 and their policies touch.
  CREATE TABLE public.contact_preferences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL UNIQUE, location_id uuid,
    unsubscribe_token uuid DEFAULT gen_random_uuid()
  );
  CREATE TABLE public.consent_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL, channel text, action text
  );
  -- glofox_push_events: prod column order (as in the 651 replay).
  CREATE TABLE public.glofox_push_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, location_id uuid, source text NOT NULL,
    status text NOT NULL, glofox_member_id text, glofox_response jsonb, error_message text, passcode_sent text,
    created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz, reviewed_by uuid
  );

  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations
               WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
  $$;
  CREATE FUNCTION private.auth_is_active_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND active IS NOT FALSE AND deleted_at IS NULL)
  $$;
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated, service_role;

  -- consent_drift_rows (mig 544 shape): mig 657 closes it to clients.
  CREATE FUNCTION public.consent_drift_rows() RETURNS TABLE(contact_id uuid, location_id uuid, email text)
    LANGUAGE sql SET search_path TO 'pg_catalog', 'public' AS $fn$
    SELECT clp.contact_id, clp.location_id, c.email
      FROM contact_location_preferences clp JOIN contacts c ON c.id = clp.contact_id
  $fn$;
  GRANT EXECUTE ON FUNCTION public.consent_drift_rows() TO PUBLIC, anon, authenticated, service_role;

  -- Live contacts policies BEFORE mig 653 (653 drops the three write ones).
  ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
  CREATE POLICY contacts_update ON public.contacts FOR UPDATE TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())))
    WITH CHECK (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
  CREATE POLICY contacts_insert ON public.contacts FOR INSERT TO authenticated
    WITH CHECK (private.auth_is_in_location(location_id));
  CREATE POLICY contacts_delete ON public.contacts FOR DELETE TO authenticated
    USING (private.auth_is_in_location(location_id));
  -- The consent tables' policies BEFORE mig 660 (660 makes them SELECT-only, 662 drops them).
  ALTER TABLE public.contact_location_preferences ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contact_location_preferences_location_scoped ON public.contact_location_preferences FOR ALL TO authenticated
    USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
  ALTER TABLE public.contact_preferences ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contact_preferences_location_scoped ON public.contact_preferences FOR ALL TO authenticated
    USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
  ALTER TABLE public.consent_log ENABLE ROW LEVEL SECURITY;
  CREATE POLICY consent_log_via_contact ON public.consent_log FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.contacts c
                    WHERE c.id = consent_log.contact_id AND private.auth_is_in_location(c.location_id)));
  ALTER TABLE public.glofox_push_events ENABLE ROW LEVEL SECURITY;
  CREATE POLICY glofox_push_events_select ON public.glofox_push_events FOR SELECT TO public
    USING (location_id IN (SELECT pl.location_id FROM public.profile_locations pl
                           WHERE pl.profile_id = (SELECT auth.uid()) AND (SELECT private.auth_is_active_staff())));

  -- mig 491, verbatim: c.* is expanded HERE, once.
  create view contact_location_audience
  with (security_invoker = on) as
  select
    c.*,
    clp.location_id        as audience_location_id,
    clp.email_marketing    as loc_email_marketing,
    clp.sms_marketing      as loc_sms_marketing,
    clp.whatsapp_marketing as loc_whatsapp_marketing
  from contacts c
  join contact_location_preferences clp on clp.contact_id = c.id;
  comment on view contact_location_audience is
    'LOCCOMMS.3 — send-path read surface. Filter audience_location_id + loc_*_marketing. A view rather than a PostgREST embed because embedded-resource filters silently break head:true counts (CLASSIFY.1).';

  -- …and the columns contacts gained afterwards, which the view never saw.
  ${LATER_COLS.map((c) => `ALTER TABLE public.contacts ADD COLUMN ${c} text;`).join('\n  ')}
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}');
  INSERT INTO public.profiles (id, role) VALUES ('${STAFF}', 'staff');
  INSERT INTO public.profile_locations VALUES ('${STAFF}', '${LOC_A}', 'staff');
  INSERT INTO public.contacts (id, name, email, location_id, glofox_passcode, email_status) VALUES
    ('${C1}', 'Synth One', 'one@example.test', '${LOC_A}', '${PASSCODE}', NULL),
    ('${C2}', 'Synth Two', 'two@example.test', '${LOC_A}', NULL, 'bounced');
  INSERT INTO public.contact_location_preferences (contact_id, location_id) VALUES ('${C1}', '${LOC_A}'), ('${C2}', '${LOC_A}');
  INSERT INTO public.contact_preferences (contact_id, location_id) VALUES ('${C1}', '${LOC_A}'), ('${C2}', '${LOC_A}');
  INSERT INTO public.glofox_push_events (contact_id, location_id, source, status, passcode_sent) VALUES
    ('${C1}', '${LOC_A}', 'booking_form', 'created', '${PASSCODE}');
`

let db
const runSql = (text) => db['exec'](text)

async function asUser(uid, sql) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    return (await db.query(sql)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}
async function asRole(role, sql) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role })])
    await runSql(`SET LOCAL ROLE ${role}`)
    return (await db.query(sql)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}
/** The error message a read raises, or 'ok' when it succeeds. */
const outcome = (p) => p.then(() => 'ok', (e) => e.message)

async function viewCols() {
  const { rows } = await db.query(`SELECT attname FROM pg_attribute
    WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`)
  return rows.map((r) => r.attname)
}
/** ACL as a sorted set of 'grantee:privilege:grantable:grantor' (item ORDER in relacl may differ after a re-grant). */
async function aclItems(rel) {
  const { rows } = await db.query(`
    SELECT coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type || ':' || a.is_grantable || ':' || g.rolname AS item
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee JOIN pg_roles g ON g.oid = a.grantor
     WHERE c.oid = $1::regclass ORDER BY 1`, [rel])
  return rows.map((r) => r.item)
}
/** Every (client role, privilege) that has_table_privilege / has_any_column_privilege grants on `rel`. */
async function clientPrivileges(rel) {
  const { rows } = await db.query(`
    SELECT r.role || ':' || p.priv AS item
      FROM unnest(ARRAY['anon', 'authenticated', 'public']) r(role), unnest($2::text[]) p(priv)
     WHERE has_table_privilege(r.role, $1, p.priv)
    UNION ALL
    SELECT r.role || ':column ' || p.priv
      FROM unnest(ARRAY['anon', 'authenticated', 'public']) r(role), unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p(priv)
     WHERE has_any_column_privilege(r.role, $1, p.priv)
     ORDER BY 1`, [rel, ALL_PRIVS])
  return rows.map((r) => r.item)
}
async function relState(rel) {
  const { rows: [r] } = await db.query(`SELECT reloptions::text AS opts,
      pg_get_userbyid(relowner) AS owner, obj_description(oid, 'pg_class') AS comment
    FROM pg_class WHERE oid = $1::regclass`, [rel])
  return { ...r, acl: await aclItems(rel) }
}
async function hasColumn(rel, col) {
  const { rows: [r] } = await db.query(`SELECT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = $1::regclass AND attname = $2 AND NOT attisdropped) AS has`, [rel, col])
  return r.has
}
async function constraintNames() {
  const { rows } = await db.query(`SELECT conname FROM pg_constraint WHERE conname LIKE '%passcode_retired' ORDER BY 1`)
  return rows.map((r) => r.conname)
}

async function boot({ steps = [], after = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(SEED)
  for (const s of steps) await runSql(s)
  if (after) await runSql(after)
}

// Reader shapes (all service role in prod): consent-drift cron, campaign
// resend/non-opener id pass, and whatsapp.js's default '*' base.
const DRIFT_READ = `SELECT id, email, audience_location_id FROM public.contact_location_audience
  WHERE loc_email_marketing AND email_status IS DISTINCT FROM 'bounced' AND email_suppressed_at IS NULL
    AND email IS NOT NULL ORDER BY id, audience_location_id`
const STAR_READ = `SELECT * FROM public.contact_location_audience WHERE audience_location_id = '${LOC_A}' ORDER BY id`
const COUNT_READ = 'SELECT count(*)::int AS n FROM public.contact_location_audience'

// The view's ACL after mig 662: the owner and the service role, nothing else (PG 17: 8 privileges each).
const CLOSED_VIEW_ACL = ['postgres', 'service_role'].flatMap((r) => ALL_PRIVS.map((p) => `${r}:${p}:false:postgres`)).sort()

describe('before 652: prod on 30 Sep (651, 653, 657, 660, 662 applied)', () => {
  beforeAll(() => boot({ steps: PROD_BEFORE_652 }), 60_000)
  afterAll(() => db?.close())

  it('the view has 98 columns, glofox_passcode is column 47, and none of the 10 later columns', async () => {
    const cols = await viewCols()
    expect(cols).toHaveLength(98)
    expect(cols[46]).toBe('glofox_passcode')
    expect(cols.filter((c) => LATER_COLS.includes(c))).toEqual([])
  })

  it('both columns exist, are all NULL, and carry 651\'s validated CHECKs', async () => {
    expect(await hasColumn('public.contacts', 'glofox_passcode')).toBe(true)
    expect(await hasColumn('public.glofox_push_events', 'passcode_sent')).toBe(true)
    expect(await constraintNames()).toEqual(['contacts_glofox_passcode_retired', 'glofox_push_events_passcode_retired'])
  })

  it('the view is closed to clients (mig 662): owner + service_role only', async () => {
    expect((await relState('public.contact_location_audience')).acl).toEqual(CLOSED_VIEW_ACL)
    expect(await clientPrivileges('public.contact_location_audience')).toEqual([])
  })
})

describe('652 refuses to run before 651', () => {
  afterEach(async () => { await db?.close() })

  it('when 651 is not applied at all (nothing changes)', async () => {
    await boot()
    await expect(runSql(MIG_652)).rejects.toThrow(/mig 652: apply 651_retire_glofox_passcodes first/)
    await runSql('ROLLBACK')
    expect(await hasColumn('public.contacts', 'glofox_passcode')).toBe(true)
    expect(await viewCols()).toHaveLength(98)
  }, 60_000)

  it('when the CHECK exists but is NOT VALID', async () => {
    await boot({ steps: PROD_BEFORE_652, after: `
      ALTER TABLE public.contacts DROP CONSTRAINT contacts_glofox_passcode_retired;
      ALTER TABLE public.contacts ADD CONSTRAINT contacts_glofox_passcode_retired CHECK (glofox_passcode IS NULL) NOT VALID;` })
    await expect(runSql(MIG_652)).rejects.toThrow(/mig 652: apply 651_retire_glofox_passcodes first/)
    await runSql('ROLLBACK')
    expect(await hasColumn('public.contacts', 'glofox_passcode')).toBe(true)
  }, 60_000)
})

describe('prod order: 651 → 653 → 657 → 660 → 662 → 652', () => {
  let before
  beforeAll(async () => {
    await boot({ steps: PROD_BEFORE_652 })
    before = {
      view: await relState('public.contact_location_audience'),
      contacts: await relState('public.contacts'),
      gpe: await relState('public.glofox_push_events'),
      staff: await outcome(asUser(STAFF, COUNT_READ)),
      anon: await outcome(asRole('anon', COUNT_READ)),
      serviceCount: await asRole('service_role', COUNT_READ),
      drift: await asRole('service_role', DRIFT_READ),
    }
    await runSql(MIG_652)
  }, 60_000)
  afterAll(() => db?.close())

  it('both columns and both 651 CHECKs are gone', async () => {
    expect(await hasColumn('public.contacts', 'glofox_passcode')).toBe(false)
    expect(await hasColumn('public.glofox_push_events', 'passcode_sent')).toBe(false)
    expect(await constraintNames()).toEqual([])
  })

  it('the view is the old list minus glofox_passcode, same order, and still WITHOUT the 10 later columns', async () => {
    expect(await viewCols()).toEqual(EXPECTED_AFTER)
    expect(EXPECTED_AFTER).toHaveLength(97)
  })

  it('security_invoker, ACL, owner and comment are exactly as before', async () => {
    expect(await relState('public.contact_location_audience')).toEqual(before.view)
    expect(before.view.opts).toBe('{security_invoker=on}')
    expect(before.view.owner).toBe('postgres')
    expect(before.view.comment).toMatch(/^LOCCOMMS\.3 — send-path read surface\./)
  })

  it('the recreated view has NO anon/authenticated/PUBLIC privilege (662 stays closed)', async () => {
    expect((await relState('public.contact_location_audience')).acl).toEqual(CLOSED_VIEW_ACL)
    expect(await clientPrivileges('public.contact_location_audience')).toEqual([])
    const { rows: [r] } = await db.query(`SELECT has_table_privilege('service_role', 'public.contact_location_audience', 'SELECT') AS s`)
    expect(r.s).toBe(true)
  })

  it('contacts and glofox_push_events ACLs are unchanged (651 left gpe with no client privilege)', async () => {
    expect(await relState('public.contacts')).toEqual(before.contacts)
    expect(await relState('public.glofox_push_events')).toEqual(before.gpe)
    expect(await clientPrivileges('public.glofox_push_events')).toEqual([])
  })

  it('service-role readers get what they did, minus the always-NULL key', async () => {
    expect(await asRole('service_role', DRIFT_READ)).toEqual(before.drift)
    expect(await asRole('service_role', COUNT_READ)).toEqual(before.serviceCount)
    expect(before.serviceCount).toEqual([{ n: 2 }])
    const star = await asRole('service_role', STAR_READ)
    expect(star.map((r) => r.id)).toEqual([C1, C2])
    expect(Object.keys(star[0])).not.toContain('glofox_passcode')
    expect(Object.keys(star[0])).toEqual(EXPECTED_AFTER)
  })

  it('client sessions are refused exactly as before (no privilege on the view)', async () => {
    expect(before.staff).toMatch(VIEW_DENIED)
    expect(before.anon).toMatch(VIEW_DENIED)
    expect(await outcome(asUser(STAFF, COUNT_READ))).toBe(before.staff)
    expect(await outcome(asRole('anon', COUNT_READ))).toBe(before.anon)
  })

  it('a stray read or write of a dropped column now fails loudly', async () => {
    await expect(runSql('SELECT glofox_passcode FROM public.contacts')).rejects.toThrow(/column "glofox_passcode" does not exist/)
    await expect(runSql(`UPDATE public.glofox_push_events SET passcode_sent = 'x'`)).rejects.toThrow(/column "passcode_sent" of relation "glofox_push_events" does not exist/)
  })

  it('a second run passes (idempotent) and changes nothing', async () => {
    const state = await relState('public.contact_location_audience')
    await expect(runSql(MIG_652)).resolves.toBeDefined()
    expect(await viewCols()).toEqual(EXPECTED_AFTER)
    expect(await relState('public.contact_location_audience')).toEqual(state)
  })
})

describe('number order (a fresh database): 651 → 652 → 653 → 657 → 660 → 662', () => {
  afterEach(async () => { await db?.close() })

  it('652 keeps the still-open pre-662 ACL and a staff read through security_invoker is unchanged', async () => {
    await boot({ steps: [MIG_651] })
    const view = await relState('public.contact_location_audience')
    const staff = await asUser(STAFF, COUNT_READ)
    expect(staff).toEqual([{ n: 2 }])
    expect(await clientPrivileges('public.contact_location_audience')).toContain('authenticated:SELECT')
    await runSql(MIG_652)
    expect(await relState('public.contact_location_audience')).toEqual(view)
    expect(await asUser(STAFF, COUNT_READ)).toEqual(staff)
    expect(await viewCols()).toEqual(EXPECTED_AFTER)
  }, 60_000)

  it('ends in the same state as prod order, closed to clients', async () => {
    const endState = async () => ({
      cols: await viewCols(),
      view: await relState('public.contact_location_audience'),
      viewClient: await clientPrivileges('public.contact_location_audience'),
      contacts: await relState('public.contacts'),
      gpe: await relState('public.glofox_push_events'),
      checks: await constraintNames(),
    })
    await boot({ steps: [...PROD_BEFORE_652, MIG_652] })
    const a = await endState()
    await db.close()
    await boot({ steps: NUMBER_ORDER })
    const b = await endState()
    expect(a).toEqual(b)
    expect(a.cols).toEqual(EXPECTED_AFTER)
    expect(a.view.acl).toEqual(CLOSED_VIEW_ACL)
    expect(a.viewClient).toEqual([])
    expect(a.checks).toEqual([])
    // 653 + 657: anon holds nothing on contacts, authenticated keeps SELECT + MAINTAIN only
    expect(a.contacts.acl.filter((i) => i.startsWith('anon:'))).toEqual([])
    expect(a.contacts.acl.filter((i) => i.startsWith('authenticated:'))).toEqual(['authenticated:MAINTAIN:false:postgres', 'authenticated:SELECT:false:postgres'])
  }, 120_000)
})

describe('grants on the view are preserved from the catalog, whatever they are', () => {
  afterAll(() => db?.close())

  it('an extra (same-grantor, non-client) item survives the drop and create', async () => {
    await boot({ steps: PROD_BEFORE_652, after: 'GRANT SELECT ON public.contact_location_audience TO sneaky;' })
    const aclBefore = (await relState('public.contact_location_audience')).acl
    await runSql(MIG_652)
    expect((await relState('public.contact_location_audience')).acl).toEqual(aclBefore)
    expect(aclBefore).toContain('sneaky:SELECT:false:postgres')
    expect(await clientPrivileges('public.contact_location_audience')).toEqual([])
  }, 60_000)
})

describe('the file aborts as a whole', () => {
  afterEach(async () => { await db?.close() })

  it('when something new depends on the view (no CASCADE)', async () => {
    await boot({ steps: PROD_BEFORE_652, after: 'CREATE VIEW public.synth_dependent AS SELECT id FROM public.contact_location_audience;' })
    await expect(runSql(MIG_652)).rejects.toThrow(/cannot drop view contact_location_audience because other objects depend on it/)
    await runSql('ROLLBACK')
    expect(await hasColumn('public.contacts', 'glofox_passcode')).toBe(true)
    expect(await constraintNames()).toHaveLength(2)
  }, 60_000)

  it('when a view privilege came from another grantor (it cannot be re-issued as that grantor)', async () => {
    await boot({ steps: PROD_BEFORE_652, after: `
      GRANT SELECT ON public.contact_location_audience TO other_grantor WITH GRANT OPTION;
      SET ROLE other_grantor; GRANT SELECT ON public.contact_location_audience TO sneaky; RESET ROLE;` })
    await expect(runSql(MIG_652)).rejects.toThrow(/mig 652: contact_location_audience privileges differ from before/)
    await runSql('ROLLBACK')
    expect(await hasColumn('public.contacts', 'glofox_passcode')).toBe(true)
    expect(await viewCols()).toHaveLength(98)
  }, 60_000)
})

describe('the rollback record', () => {
  afterAll(() => db?.close())

  it('re-adds both columns (NULL, CHECK-refused) and the view column at the END, grants kept and still closed', async () => {
    await boot({ steps: [...PROD_BEFORE_652, MIG_652] })
    const aclAfter652 = (await relState('public.contact_location_audience')).acl
    await runSql(ROLLBACK_652)
    expect(await hasColumn('public.contacts', 'glofox_passcode')).toBe(true)
    expect(await hasColumn('public.glofox_push_events', 'passcode_sent')).toBe(true)
    expect(await constraintNames()).toEqual(['contacts_glofox_passcode_retired', 'glofox_push_events_passcode_retired'])
    expect(await viewCols()).toEqual([...EXPECTED_AFTER, 'glofox_passcode'])
    expect((await relState('public.contact_location_audience')).acl).toEqual(aclAfter652)
    expect(await clientPrivileges('public.contact_location_audience')).toEqual([])
    await expect(runSql(`UPDATE public.contacts SET glofox_passcode = 'x' WHERE id = '${C1}'`))
      .rejects.toThrow(/contacts_glofox_passcode_retired/)
  }, 60_000)
})
