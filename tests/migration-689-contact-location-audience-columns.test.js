// AUDIENCEVIEWCOLS.1 — behavioural test for migration 689.
//
// Models prod on 1 Oct 2026: contacts (the 93 columns contact_location_audience
// selects, in live order, then the 10 later columns it never got), the view
// exactly as mig 652 left it (explicit list, security_invoker, comment), the
// post-662/677 ACL (postgres + service_role only; contacts SELECT for
// authenticated) and the live contacts_select policy. Then runs the REAL 689
// file and proves:
//   * before 689 an audience filter on last_email_open_at fails (42703);
//     after it the same read works and returns the right row;
//   * the first 97 columns are untouched, the 10 are appended in contacts
//     order with contacts' types, and no contacts column is missing;
//   * security_invoker, OID, owner, comment and ACL are unchanged; no client
//     role can read the view (mig 662);
//   * leaving WITH (security_invoker = on) out of the CREATE OR REPLACE is
//     caught by the self-check (the OR REPLACE trap);
//   * 689 refuses to run before 652, or when a client role holds anything on
//     the view, or when contacts has a column the file does not list; a
//     second run passes; the rollback record restores 97 columns.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_689 = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/689_contact_location_audience_columns.sql'), 'utf8')

// contact_location_audience's contacts columns, live order (1 Oct 2026; = mig 652's list).
const VIEW_CONTACT_COLS = `
  id name first_name last_name email phone label glofox_member_id trial_credits_remaining
  lead_source lead_created_at created_at updated_at source location_id last_emailed_at
  total_emails_sent total_emails_opened total_emails_clicked email_status tags wa_phone wa_status
  last_wa_message_at total_wa_sent total_wa_received sms_status created_via_import_id user_id
  max_hr_override hr_post_class_emails_enabled glofox_membership_status glofox_synced_at dob
  joined_at last_booked_at last_attended_at total_bookings_30d total_attended_30d
  total_noshow_30d recent_bookings lifetime_value_cents lifetime_transaction_count
  lifetime_currency last_payment_at last_invoice_at total_attended_7d
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
const CLP_COLS = ['audience_location_id', 'loc_email_marketing', 'loc_sms_marketing', 'loc_whatsapp_marketing']
// contacts columns the view lacks (1 Oct 2026), contacts attnum order, prod types.
const NEW_COLS = [
  ['last_email_open_at', 'timestamp with time zone'],
  ['last_email_click_at', 'timestamp with time zone'],
  ['email_hygiene_released_at', 'timestamp with time zone'],
  ['instagram_igsid', 'text'],
  ['instagram_handle', 'text'],
  ['name_normalized', 'text'],
  ['last_lead_source', 'text'],
  ['last_lead_source_at', 'timestamp with time zone'],
  ['glofox_user_membership_id', 'text'],
  ['glofox_detail_due_at', 'timestamp with time zone'],
]
const NEW_NAMES = NEW_COLS.map(([c]) => c)
const BEFORE = [...VIEW_CONTACT_COLS, ...CLP_COLS]
const AFTER = [...BEFORE, ...NEW_NAMES]

const colType = (c) => (c === 'id' ? 'uuid PRIMARY KEY'
  : ['location_id', 'user_id'].includes(c) ? 'uuid'
  : c === 'email_marketing' ? 'boolean NOT NULL DEFAULT true'
  : c === 'tags' ? 'text[]'
  : 'text')

// The view as mig 652 wrote it (explicit list).
const SELECT_652 = [...VIEW_CONTACT_COLS.map((c) => `c.${c}`),
  'clp.location_id AS audience_location_id', 'clp.email_marketing AS loc_email_marketing',
  'clp.sms_marketing AS loc_sms_marketing', 'clp.whatsapp_marketing AS loc_whatsapp_marketing'].join(', ')
const COMMENT = 'LOCCOMMS.3 — send-path read surface. Filter audience_location_id + loc_*_marketing. A view rather than a PostgREST embed because embedded-resource filters silently break head:true counts (CLASSIFY.1).'

// The plan's rollback record (Task 5 Step 7), POST-677 form: DROP + CREATE with
// the 97-column list; the new view gets the post-677 default (postgres +
// service_role), the REVOKE is the consent guard's required no-op, the comment
// is restored.
const ROLLBACK_689 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP VIEW public.contact_location_audience;
CREATE VIEW public.contact_location_audience WITH (security_invoker = on) AS
  SELECT ${SELECT_652}
    FROM public.contacts c JOIN public.contact_location_preferences clp ON clp.contact_id = c.id;
REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;
COMMENT ON VIEW public.contact_location_audience IS '${COMMENT}';
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const STAFF = '10000000-0000-0000-0000-000000000001'
const C1 = '30000000-0000-0000-0000-000000000001'
const C2 = '30000000-0000-0000-0000-000000000002'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public, private TO anon, authenticated, service_role;
  -- post-677 default: new relations in public go to service_role only.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));

  CREATE TABLE public.contacts (${VIEW_CONTACT_COLS.map((c) => `${c} ${colType(c)}`).join(', ')});
  CREATE TABLE public.contact_location_preferences (
    contact_id uuid, location_id uuid, email_marketing boolean NOT NULL DEFAULT true,
    sms_marketing boolean NOT NULL DEFAULT true, whatsapp_marketing boolean NOT NULL DEFAULT true, source text
  );

  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
    SELECT loc_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations
               WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
  $$;
  REVOKE ALL ON FUNCTION private.auth_is_in_location(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION private.auth_is_in_location(uuid) TO authenticated, service_role;

  -- contacts post-653/657/677: authenticated SELECT only, one SELECT policy.
  GRANT SELECT ON public.contacts TO authenticated;
  ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
  -- contact_location_preferences post-662: RLS on, no policy, no client privilege.
  ALTER TABLE public.contact_location_preferences ENABLE ROW LEVEL SECURITY;

  -- the view as mig 652 left it (explicit list), closed by 662.
  CREATE VIEW public.contact_location_audience WITH (security_invoker = on) AS
    SELECT ${SELECT_652}
      FROM public.contacts c JOIN public.contact_location_preferences clp ON clp.contact_id = c.id;
  REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;
  COMMENT ON VIEW public.contact_location_audience IS '${COMMENT}';

  -- …and the contacts columns added since, which the view never got.
  ${NEW_COLS.map(([c, t]) => `ALTER TABLE public.contacts ADD COLUMN ${c} ${t};`).join('\n  ')}
`

const SEED = `
  INSERT INTO public.profiles (id, role) VALUES ('${STAFF}', 'staff');
  INSERT INTO public.profile_locations VALUES ('${STAFF}', '${LOC_A}', 'staff');
  INSERT INTO public.contacts (id, name, email, location_id, last_email_open_at, instagram_handle) VALUES
    ('${C1}', 'Synth One', 'one@example.test', '${LOC_A}', now() - interval '2 days', 'synth_one'),
    ('${C2}', 'Synth Two', 'two@example.test', '${LOC_A}', NULL, NULL);
  INSERT INTO public.contact_location_preferences (contact_id, location_id) VALUES ('${C1}', '${LOC_A}'), ('${C2}', '${LOC_A}');
`

let db
const runSql = (text) => db['exec'](text)

async function asRole(role, sql, sub = null) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify(sub ? { sub, role } : { role })])
    await runSql(`SET LOCAL ROLE ${role}`)
    return (await db.query(sql)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}
async function viewCols() {
  const { rows } = await db.query(`SELECT attname, format_type(atttypid, atttypmod) AS typ FROM pg_attribute
    WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`)
  return rows
}
async function aclItems(rel) {
  const { rows } = await db.query(`
    SELECT coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type || ':' || a.is_grantable || ':' || g.rolname AS item
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee JOIN pg_roles g ON g.oid = a.grantor
     WHERE c.oid = $1::regclass ORDER BY 1`, [rel])
  return rows.map((r) => r.item)
}
async function viewState() {
  const { rows: [r] } = await db.query(`SELECT oid::int AS oid, reloptions::text AS opts,
      pg_get_userbyid(relowner) AS owner, obj_description(oid, 'pg_class') AS comment
    FROM pg_class WHERE oid = 'public.contact_location_audience'::regclass`)
  return { ...r, acl: await aclItems('public.contact_location_audience') }
}
/** Run SQL; return the error it raised (the self-check), or null. A failed run leaves its BEGIN open: roll it back. */
async function abortMessage(sql) {
  try { await runSql(sql); return null } catch (e) { await runSql('ROLLBACK'); return String(e.message || e) }
}
async function boot(before = '') {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(SEED)
  if (before) await runSql(before)
}

// The failing shape: applyAudienceFilter's `gt` on a date field, through the
// email channel builder (audience_location_id + loc_email_marketing gates).
const OPENED_LAST_WEEK = `SELECT id FROM public.contact_location_audience
  WHERE audience_location_id = '${LOC_A}' AND loc_email_marketing
    AND last_email_open_at > now() - interval '7 days' ORDER BY id`

describe('before 689: prod on 1 Oct 2026', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('the view has the 97 columns of mig 652 and none of the 10 later contacts columns', async () => {
    const cols = (await viewCols()).map((r) => r.attname)
    expect(cols).toEqual(BEFORE)
    expect(cols.filter((c) => NEW_NAMES.includes(c))).toEqual([])
  })

  it('an audience filtered on "Last email open" fails (the C65 bug)', async () => {
    await expect(asRole('service_role', OPENED_LAST_WEEK)).rejects.toThrow(/column "last_email_open_at" does not exist/)
  })

  it('the view is closed to clients (mig 662) and security_invoker', async () => {
    const s = await viewState()
    expect(s.opts).toBe('{security_invoker=on}')
    expect(s.acl.every((i) => i.startsWith('postgres:') || i.startsWith('service_role:'))).toBe(true)
  })
})

describe('after 689', () => {
  let before
  beforeAll(async () => {
    await boot()
    before = { view: await viewState(), contactsAcl: await aclItems('public.contacts') }
    await runSql(MIG_689)
  }, 60_000)
  afterAll(() => db?.close())

  it('the 97 columns are unchanged and the 10 are appended in contacts order, with contacts types', async () => {
    const cols = await viewCols()
    expect(cols.map((r) => r.attname)).toEqual(AFTER)
    expect(cols.slice(BEFORE.length).map((r) => [r.attname, r.typ])).toEqual(NEW_COLS)
  })

  it('no contacts column is missing from the view', async () => {
    const { rows } = await db.query(`SELECT attname FROM pg_attribute WHERE attrelid = 'public.contacts'::regclass
        AND attnum > 0 AND NOT attisdropped
      EXCEPT SELECT attname FROM pg_attribute WHERE attrelid = 'public.contact_location_audience'::regclass
        AND attnum > 0 AND NOT attisdropped`)
    expect(rows).toEqual([])
  })

  it('the "Last email open" audience now works and picks the right contact', async () => {
    expect((await asRole('service_role', OPENED_LAST_WEEK)).map((r) => r.id)).toEqual([C1])
    const star = await asRole('service_role', `SELECT * FROM public.contact_location_audience WHERE id = '${C1}'`)
    expect(Object.keys(star[0])).toHaveLength(AFTER.length)
    expect(star[0].instagram_handle).toBe('synth_one')
  })

  it('same view (OID), security_invoker, owner, comment and ACL; contacts ACL untouched', async () => {
    expect(await viewState()).toEqual(before.view)
    expect(await aclItems('public.contacts')).toEqual(before.contactsAcl)
  })

  it('no client role can read the view', async () => {
    await expect(asRole('authenticated', 'SELECT id FROM public.contact_location_audience', STAFF))
      .rejects.toThrow(/permission denied for (view|table|relation) contact_location_audience/)
    await expect(asRole('anon', 'SELECT id FROM public.contact_location_audience'))
      .rejects.toThrow(/permission denied for (view|table|relation) contact_location_audience/)
  })

  it('a second run passes and changes nothing', async () => {
    const s = await viewState()
    await expect(runSql(MIG_689)).resolves.toBeDefined()
    expect((await viewCols()).map((r) => r.attname)).toEqual(AFTER)
    expect(await viewState()).toEqual(s)
  })
})

describe('the file aborts as a whole', () => {
  afterEach(async () => { await db?.close() })

  it('before 652 (contacts still has glofox_passcode)', async () => {
    await boot('ALTER TABLE public.contacts ADD COLUMN glofox_passcode text;')
    expect(await abortMessage(MIG_689)).toMatch(/mig 689: apply 652_drop_glofox_passcode_columns first/)
    expect((await viewCols()).map((r) => r.attname)).toEqual(BEFORE)
  }, 60_000)

  it('when a client role holds anything on the view (662 undone: look first)', async () => {
    await boot('GRANT SELECT ON public.contact_location_audience TO authenticated;')
    expect(await abortMessage(MIG_689)).toMatch(/mig 689: a client role holds a privilege on contact_location_audience/)
    expect((await viewCols()).map((r) => r.attname)).toEqual(BEFORE)
  }, 60_000)

  it('the OR REPLACE trap: without WITH (security_invoker = on) the self-check refuses', async () => {
    await boot()
    const trapped = MIG_689.replace(/ WITH \(security_invoker = on\) AS/, ' AS')
    expect(trapped).not.toBe(MIG_689)
    expect(await abortMessage(trapped)).toMatch(/mig 689: contact_location_audience lost security_invoker/)
    expect((await viewState()).opts).toBe('{security_invoker=on}')
  }, 60_000)

  it('a live contacts column the file does not know is reported, not silently skipped', async () => {
    await boot('ALTER TABLE public.contacts ADD COLUMN synth_new_col text;')
    expect(await abortMessage(MIG_689)).toMatch(/mig 689: contacts columns missing from contact_location_audience: synth_new_col/)
  }, 60_000)
})

describe("the plan's rollback record (POST-677 form)", () => {
  afterAll(() => db?.close())

  it('restores the 97-column view, closed, security_invoker, with its comment', async () => {
    await boot()
    await runSql(MIG_689)
    await runSql(ROLLBACK_689)
    expect((await viewCols()).map((r) => r.attname)).toEqual(BEFORE)
    const s = await viewState()
    expect(s.opts).toBe('{security_invoker=on}')
    expect(s.comment).toBe(COMMENT)
    expect(s.acl.every((i) => i.startsWith('postgres:') || i.startsWith('service_role:'))).toBe(true)
    expect(s.acl.some((i) => i.startsWith('service_role:SELECT:'))).toBe(true)
  }, 60_000)
})
