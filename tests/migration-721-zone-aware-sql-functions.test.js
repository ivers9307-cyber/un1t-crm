// TZ.15 — behavioural test for migration 721 (zone-aware SQL functions and
// the challenges_read policy).
//
// No local Supabase stack exists, so the DDL would otherwise get its first
// run on prod. This boots PGlite (PostgreSQL 17) with the union of the
// tables the five functions and the policy read (column names as prod),
// replays the REAL predecessor files (719's private.location_tz, 622, 641,
// 686, the 080 last-master guard, and the function statements of 448, 517
// and 521 with their prod ACLs), keeps a frozen copy of each pre-721 body in
// schema `legacy`, applies the REAL 721 and proves:
//
//   * Europe/Dublin is identical: for every studio on Europe/Dublin each
//     rewritten function returns exactly what its 721-less body returns, at
//     instants around both 2026 DST changes and month/year edges
//     (tombstone_staff_profile's dry-run summary, hyrox_coaches_on_shift,
//     both monthly stats functions, claim_shift_offer's outcome), and a
//     member/staff/master reads the same challenges as under 686;
//   * America/New_York follows New York: a NY block is judged on the NY wall
//     clock from the same p_now (tombstone, against a JS Intl oracle over
//     every block), a NY class instant finds the coaches rostered on the NY
//     clock, NY months bucket on NY midnight, a cross-studio claim overlaps
//     on instants, and a NY member's 14-day challenge window is NY days;
//   * service_role, which holds NO USAGE on schema private (as on prod),
//     runs all five (and would fail calling private.location_tz from an
//     INVOKER body: the reason they read the zone inline);
//   * ACLs, SECURITY, search_path, signature and owner unchanged; the policy
//     is still the table's one PERMISSIVE SELECT policy; the zone lookup in
//     it is an InitPlan; D5's billing functions untouched but commented;
//   * the pre-check aborts the WHOLE file on a hand-edited body or a moved
//     policy, the self-check on a changed ACL; a second run passes.
// Fictional ids and names only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const mig = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_721 = mig('721_zone_aware_sql_functions.sql')
const VERIFY = readFileSync(path.resolve(import.meta.dirname, 'sql/tz-721.sql'), 'utf8')
const VERIFY_B = VERIFY.slice(VERIFY.indexOf('-- ═══ B.'), VERIFY.indexOf('-- ═══ C.'))
const MIG_719 = mig('719_locations_timezone_hardening.sql')
const MIG_622 = mig('622_staff_tombstone.sql')
const MIG_641 = mig('641_shift_offers.sql')
const MIG_686 = mig('686_challenges_member_wrapped_window.sql')
const MIG_080 = mig('080_assignment_audit_and_master_guard.sql')
const MASTER_GUARD = MIG_080.slice(
  MIG_080.indexOf('CREATE OR REPLACE FUNCTION private.guard_at_least_one_master()'),
  MIG_080.indexOf('COMMENT ON FUNCTION private.guard_at_least_one_master()'),
)

/** The text from `start` through the first `end` after it. */
function cut(text, start, end) {
  const i = text.indexOf(start)
  const j = text.indexOf(end, i)
  if (i < 0 || j < 0) throw new Error(`cut: ${start} … ${end} not found`)
  return text.slice(i, j + end.length)
}
const FN = {
  hyrox: cut(mig('448_hyrox_class_reminder.sql'), 'CREATE OR REPLACE FUNCTION public.hyrox_coaches_on_shift(', '$$;'),
  listHealth: cut(mig('517_list_health_monthly_stats.sql'), 'create or replace function public.list_health_monthly_stats(', '$$;'),
  emailSends: cut(mig('521_email_source_and_campaign_recipient_stats.sql'), 'create or replace function public.email_sends_monthly_stats(', '$$;'),
  tombstone: cut(MIG_622, 'CREATE OR REPLACE FUNCTION public.tombstone_staff_profile(', '$$;'),
  claim: cut(MIG_641, 'CREATE OR REPLACE FUNCTION public.claim_shift_offer(', '$$;'),
}
// The statements after 517's / 521's function (comment, revoke, grant), verbatim.
const ACL_517 = cut(mig('517_list_health_monthly_stats.sql'), 'comment on function public.list_health_monthly_stats(', 'to service_role;')
const ACL_521 = cut(mig('521_email_source_and_campaign_recipient_stats.sql'), 'comment on function public.email_sends_monthly_stats(', 'to service_role;')
const legacy = (create) => create.replace(/FUNCTION public\./i, 'FUNCTION legacy.')

const LOC_D = 'a0000000-0000-0000-0000-00000000000d'   // a Dublin studio, always
const LOC_N = 'a0000000-0000-0000-0000-00000000000e'   // Dublin, or New York in the NY tests
const GONE = '10000000-0000-0000-0000-000000000001'    // deactivated coach being deleted
const PEER = '10000000-0000-0000-0000-000000000002'    // the claimant / a hyrox coach
const MASTER = '10000000-0000-0000-0000-000000000009'
const MEMBER_UID = '20000000-0000-0000-0000-000000000001'
const CONTACT_M = '30000000-0000-0000-0000-000000000001'
const R_PUB = '60000000-0000-0000-0000-000000000001'
const OFFER_BLOCK = '21000000-0000-0000-0000-000000000001'
const NY = 'America/New_York'
const DUB = 'Europe/Dublin'

// Prod's privileges where they matter: service_role has NO USAGE on schema
// private (mig 622 step 9, mig 678's live census); authenticated does (022).
const SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  CREATE SCHEMA legacy;
  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text, timezone text DEFAULT 'Europe/Dublin');
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email text NOT NULL, full_name text NOT NULL, role text NOT NULL DEFAULT 'staff',
    avatar_url text, active boolean DEFAULT true, permissions jsonb DEFAULT '{"dashboard": true}'::jsonb,
    two_factor_enabled boolean DEFAULT false, updated_at timestamptz DEFAULT now(),
    employment_type text NOT NULL DEFAULT 'fte', hourly_rate numeric,
    unifi_door_access boolean NOT NULL DEFAULT false, unifi_user_id text,
    pin_hash text UNIQUE, pin_set_at timestamptz, pin_failed_count int NOT NULL DEFAULT 0, pin_locked_until timestamptz,
    home_screen_path text NOT NULL DEFAULT '/dashboard', email_signature text, email_signature_rich jsonb
  );
  CREATE TABLE public.profile_compensation (profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE, hourly_rate numeric);
  CREATE TABLE public.profile_locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, location_id uuid NOT NULL REFERENCES public.locations(id), role text);
  CREATE TABLE public.profile_organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE);
  CREATE TABLE public.device_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, expo_push_token text);
  CREATE TABLE public.widget_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, token_hash text);
  CREATE TABLE public.email_mailbox_access (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE);
  CREATE TABLE public.mobile_bar_prefs (profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, location_id uuid NOT NULL, PRIMARY KEY (profile_id, location_id));
  CREATE TABLE public.shift_templates (id uuid PRIMARY KEY, name text, start_time time, end_time time, kind text NOT NULL DEFAULT 'class');
  CREATE TABLE public.rosters (id uuid PRIMARY KEY, status text NOT NULL);
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES public.locations(id), template_id uuid REFERENCES public.shift_templates(id),
    block_date date NOT NULL, start_time time NOT NULL, end_time time NOT NULL,
    min_coaches smallint NOT NULL DEFAULT 1, max_coaches smallint NOT NULL DEFAULT 15,
    roster_id uuid REFERENCES public.rosters(id),
    CONSTRAINT shift_blocks_time_order CHECK (end_time > start_time)
  );
  CREATE TABLE public.shift_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), block_id uuid NOT NULL REFERENCES public.shift_blocks(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    status text DEFAULT 'scheduled', notes text, assigned_by uuid REFERENCES public.profiles(id), assigned_at timestamptz DEFAULT now(),
    start_time_override time, end_time_override time, arrived_at timestamptz,
    CONSTRAINT shift_assignments_block_id_profile_id_key UNIQUE (block_id, profile_id)
  );
  CREATE TABLE public.shift_swap_requests (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES public.locations(id),
    requester_shift_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
    requester_id uuid NOT NULL REFERENCES public.profiles(id),
    target_shift_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
    target_id uuid REFERENCES public.profiles(id),
    status text DEFAULT 'pending', reviewed_by uuid REFERENCES public.profiles(id), reviewed_at timestamptz,
    review_note text, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.time_off_requests (
    id uuid PRIMARY KEY, profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    location_id uuid REFERENCES public.locations(id),
    type text, start_date date NOT NULL, end_date date NOT NULL, total_days numeric,
    status text NOT NULL DEFAULT 'pending', review_note text, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.staff_allowances (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, year int, total_days numeric, used_days numeric);
  CREATE TABLE public.schedule_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, type text);
  CREATE TABLE public.contractor_invoices (id uuid PRIMARY KEY, contractor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, invoice_amount numeric);
  CREATE TABLE public.staff_attendance_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    matched_assignment_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL
  );
  CREATE TABLE public.scheduled_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), report_name text NOT NULL,
    email_recipients text[], confirmed_external_recipients text[] NOT NULL DEFAULT '{}', updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.roster_change_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, block_id uuid, block_date date,
    actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL, coach_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    action text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb, notified_at timestamptz
  );
  CREATE TABLE public.audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category text NOT NULL, action text NOT NULL,
    actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL, actor_label text,
    target_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL, target_label text,
    target_resource text, details jsonb
  );

  -- 517 / 521 / 686 inputs (only the columns they read).
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, user_id uuid, location_id uuid REFERENCES public.locations(id));
  CREATE TABLE public.campaigns (id uuid PRIMARY KEY, location_id uuid);
  CREATE TABLE public.campaign_recipients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid REFERENCES public.campaigns(id),
    sent_at timestamptz, bounce_type text, complained_at timestamptz, opened_at timestamptz);
  CREATE TABLE public.consent_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid REFERENCES public.contacts(id), location_id uuid,
    channel text, action text, source text, created_at timestamptz);
  CREATE TABLE public.email_sends (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, location_id uuid, source_type text,
    sent_at timestamptz, bounce_type text, complained_at timestamptz, opened_at timestamptz);
  CREATE TABLE public.challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    name text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL, is_flagship boolean NOT NULL DEFAULT false
  );
  -- The column comments 721 rewrites.
  CREATE TABLE public.email_sequences (id uuid PRIMARY KEY, send_window jsonb);
  CREATE TABLE public.company_settings (id uuid PRIMARY KEY, send_quiet_hours_start smallint NOT NULL DEFAULT 21, send_quiet_hours_end smallint NOT NULL DEFAULT 8);
  CREATE TABLE public.whatsapp_broadcasts (id uuid PRIMARY KEY, send_window_tz text NOT NULL DEFAULT 'Europe/Dublin');

  -- Stand-in for mig 191's audit trigger (as tests/migration-622-*.test.js).
  CREATE FUNCTION public.test_audit_profiles() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    INSERT INTO public.audit_events (category, action, target_resource, details)
    VALUES ('mutation', 'profiles.updated', 'profiles/' || NEW.id::text,
            jsonb_build_object('before', jsonb_build_object('email', OLD.email, 'pin_hash', OLD.pin_hash)));
    RETURN NULL;
  END $fn$;
  CREATE TRIGGER audit_mutation AFTER UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.test_audit_profiles();

  -- 686's helpers, verbatim (as tests/migration-686-*.test.js).
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role = 'master' AND active IS NOT FALSE)
  $$;
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
  $$;
  CREATE FUNCTION private.auth_contact_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'public', 'pg_temp' AS $$
    SELECT id FROM public.contacts WHERE user_id = auth.uid()
  $$;
  REVOKE EXECUTE ON FUNCTION private.auth_is_master(), private.auth_is_in_location(uuid), private.auth_contact_id() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION private.auth_is_master(), private.auth_is_in_location(uuid), private.auth_contact_id() TO authenticated, service_role;
`

// D5's billing four: stand-ins with prod's signatures and a pinned Dublin
// conversion (721 only comments them); wallet_apply carries its 420 comment.
const BILLING = `
  CREATE FUNCTION public.wallet_apply(p_location uuid, p_kind text, p_amount integer, p_note text, p_a integer, p_b integer, p_c text, p_d text, p_e uuid)
    RETURNS integer LANGUAGE sql AS $$ SELECT extract(day FROM (now() AT TIME ZONE 'Europe/Dublin'))::int $$;
  COMMENT ON FUNCTION public.wallet_apply(uuid, text, integer, text, integer, integer, text, text, uuid) IS 'INTEG-C2a: the ONLY write path for wallets.';
  CREATE FUNCTION public.rollup_usage_for_day(p_day date) RETURNS void LANGUAGE sql AS $$ SELECT WHERE (now() AT TIME ZONE 'Europe/Dublin')::date = p_day $$;
  CREATE FUNCTION public.org_ai_spend_month_cents(p_org uuid, p_month_start date) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT ((now() AT TIME ZONE 'Europe/Dublin')::date - p_month_start)::numeric $$;
  CREATE FUNCTION public.org_email_sends_month(p_org uuid, p_month_start date) RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT ((now() AT TIME ZONE 'Europe/Dublin')::date - p_month_start)::bigint $$;
  REVOKE EXECUTE ON FUNCTION public.wallet_apply(uuid, text, integer, text, integer, integer, text, text, uuid), public.rollup_usage_for_day(date),
    public.org_ai_spend_month_cents(uuid, date), public.org_email_sends_month(uuid, date) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.wallet_apply(uuid, text, integer, text, integer, integer, text, text, uuid), public.rollup_usage_for_day(date),
    public.org_ai_spend_month_cents(uuid, date), public.org_email_sends_month(uuid, date) TO service_role;
`

// challenges_read before 686 (pg_policies, 30 Sep 2026), so the REAL 686 applies.
const POLICIES_PRE_686 = `
  ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
  ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;
  CREATE POLICY challenges_read ON public.challenges FOR SELECT TO public USING (
    (SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id)
    OR ((ends_on >= ((now() AT TIME ZONE 'utc'::text))::date)
        AND EXISTS (SELECT 1 FROM public.contacts c
                     WHERE c.id = (SELECT private.auth_contact_id()) AND c.location_id = challenges.location_id)));
  REVOKE ALL ON public.contacts, public.challenges FROM anon, authenticated, PUBLIC;
  GRANT SELECT ON public.contacts, public.challenges TO authenticated;
`

// ── Instants. US DST 2026: 8 Mar / 1 Nov; EU: 29 Mar / 25 Oct. ─────────────
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z',
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z',
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z',
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z',
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z',
]
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10)
const addDays = (ymd, n) => isoDate(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000)

/** 'YYYY-MM-DDTHH:MM:SS' wall clock of an instant in a zone (the oracle). */
function wall(zone, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}

// ── The roster grid: GONE and PEER on blocks around every sample, both studios.
const TIMES = [['00:00', '00:30'], ['00:30', '01:30'], ['01:00', '02:00'], ['01:30', '03:00'], ['06:00', '09:00'],
  ['12:00', '13:00'], ['18:00', '21:00'], ['22:00', '23:00'], ['23:00', '23:59:59']]
const GRID_DATES = [...new Set(SAMPLES.flatMap((s) => [-1, 0, 1].map((k) => addDays(s.slice(0, 10), k))))].sort()
const hex = (n, w = 12) => n.toString(16).padStart(w, '0')
const GRID = []
let gi = 0
for (const loc of [LOC_D, LOC_N]) {
  for (const date of GRID_DATES) {
    for (const [start, end] of TIMES) {
      gi++
      // Deterministic variety: some start overrides, some arrivals, some attendance.
      const override = gi % 7 === 0 ? `${start.slice(0, 2)}:15` : null
      GRID.push({
        block: `22000000-0000-0000-0000-${hex(gi)}`, assignment: `32000000-0000-0000-0000-${hex(gi)}`,
        peer: `33000000-0000-0000-0000-${hex(gi)}`, loc, date, start, end, override,
        arrived: gi % 11 === 0, attended: gi % 13 === 0,
      })
    }
  }
}
const pad = (t) => (t.length === 5 ? `${t}:00` : t)

const SEED = `
  INSERT INTO public.locations (id, name, timezone) VALUES ('${LOC_D}', 'Studio D', 'Europe/Dublin'), ('${LOC_N}', 'Studio N', 'Europe/Dublin');
  INSERT INTO auth.users VALUES ('${GONE}', 'former.coach@example.test'), ('${PEER}', 'peer@example.test'), ('${MASTER}', 'master@example.test');
  INSERT INTO public.profiles (id, email, full_name, role, active) VALUES
    ('${GONE}', 'former.coach@example.test', 'Former Coach', 'staff', false),
    ('${PEER}', 'peer@example.test', 'Peer Coach', 'staff', true),
    ('${MASTER}', 'master@example.test', 'Master One', 'master', true);
  INSERT INTO public.profile_locations (profile_id, location_id, role) VALUES
    ('${GONE}', '${LOC_D}', 'staff'), ('${PEER}', '${LOC_D}', 'staff'), ('${PEER}', '${LOC_N}', 'staff');
  INSERT INTO public.rosters VALUES ('${R_PUB}', 'published');
  INSERT INTO public.shift_blocks (id, location_id, block_date, start_time, end_time, roster_id) VALUES
    ${GRID.map((g) => `('${g.block}', '${g.loc}', '${g.date}', '${g.start}', '${g.end}', '${R_PUB}')`).join(',\n    ')};
  INSERT INTO public.shift_assignments (id, block_id, profile_id, start_time_override, arrived_at) VALUES
    ${GRID.map((g) => `('${g.assignment}', '${g.block}', '${GONE}', ${g.override ? `'${g.override}'` : 'NULL'}, ${g.arrived ? "'2026-01-01T00:00:00Z'" : 'NULL'})`).join(',\n    ')};
  INSERT INTO public.staff_attendance_events (profile_id, matched_assignment_id) VALUES
    ${GRID.filter((g) => g.attended).map((g) => `('${GONE}', '${g.assignment}')`).join(', ')};
  INSERT INTO public.time_off_requests (id, profile_id, location_id, type, start_date, end_date, total_days, status) VALUES
    ('70000000-0000-0000-0000-000000000001', '${GONE}', '${LOC_N}', 'holiday', '2026-03-01', '2026-03-08', 5, 'pending'),
    ('70000000-0000-0000-0000-000000000002', '${GONE}', '${LOC_D}', 'holiday', '2026-11-01', '2026-11-03', 2, 'pending');
  INSERT INTO public.contacts VALUES ('${CONTACT_M}', '${MEMBER_UID}', '${LOC_N}');
`

let db
const runSql = (text) => db['exec'](text) // PGlite's multi-statement SQL runner (a SQL call, no shell)
const q = async (sql, params = []) => (await db.query(sql, params)).rows

/** One statement as `role` in a rolled-back tx (claims for the policy). */
async function as(role, sql, params = [], claims = null) {
  await runSql('BEGIN')
  try {
    if (claims) await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    await runSql(`SET LOCAL ROLE ${role}`)
    return (await db.query(sql, params)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}
const setZone = (loc, tz) => runSql(`UPDATE public.locations SET timezone = '${tz}' WHERE id = '${loc}'`)
const pinClock = (iso) => vi.setSystemTime(new Date(iso))

const PROD_ACLS_448 = `
  REVOKE EXECUTE ON FUNCTION public.hyrox_coaches_on_shift(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.hyrox_coaches_on_shift(uuid, timestamptz, timestamptz) TO service_role;
`

/** Prod's state before 721, plus frozen `legacy.*` copies of the five bodies. */
async function bootPre721({ before = '' } = {}) {
  db = new PGlite()
  await runSql(SCHEMA)
  await runSql(MIG_719)
  await runSql(MIG_622)
  await runSql(MASTER_GUARD)
  await runSql(MIG_641)
  await runSql(FN.hyrox + PROD_ACLS_448)
  await runSql(`${FN.listHealth}\n${ACL_517}`)
  await runSql(`${FN.emailSends}\n${ACL_521}`)
  await runSql(BILLING)
  await runSql('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role')
  await runSql(POLICIES_PRE_686)
  await runSql(MIG_686)
  for (const create of Object.values(FN)) await runSql(legacy(create))
  await runSql(SEED)
  if (before) await runSql(before)
}

const FIVE = [
  'public.hyrox_coaches_on_shift(uuid, timestamptz, timestamptz)',
  'public.list_health_monthly_stats(uuid, integer, text[], text[], text[], text[])',
  'public.email_sends_monthly_stats(uuid, integer)',
  'public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean)',
  'public.claim_shift_offer(uuid, uuid)',
]
const catalog = async () => q(`SELECT p.oid::regprocedure::text AS fn, p.oid::int AS oid, coalesce(p.proacl::text, '-') AS acl, p.prosecdef,
    p.provolatile, coalesce(p.proconfig::text, '-') AS cfg, p.proowner::int AS owner, pg_get_function_result(p.oid) AS result,
    pg_get_function_arguments(p.oid) AS args, md5(p.prosrc) AS body
  FROM pg_proc p WHERE p.oid = ANY ($1::regprocedure[]) ORDER BY 1`, [FIVE])
const policies = async () => q(`SELECT policyname, permissive, cmd, roles::text AS roles, qual, with_check FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'challenges' ORDER BY policyname`)

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); pinClock('2026-10-11T12:00:00Z') })
afterAll(() => { vi.useRealTimers() })

// ═════════════════════════════════════════════════════════════════════════
describe('721 applied to prod\'s shape', () => {
  let catBefore, polBefore, verifyBefore, verifyAfter
  /** Section B of tests/sql/tz-721.sql: every result row of every statement. */
  const fingerprints = async () => (await runSql(VERIFY_B)).map((r) => r.rows).filter((rows) => rows.length)
  const challengeReadsBefore = new Map()
  const CH_INSTANTS = ['2026-09-30T23:30:00Z', '2026-07-01T22:59:59Z', '2026-07-01T23:00:00Z', '2026-12-01T23:30:00Z']
  const STAFF_CLAIMS = { sub: PEER, role: 'authenticated' }
  const MEMBER_CLAIMS = { sub: MEMBER_UID, role: 'authenticated' }
  const MASTER_CLAIMS = { sub: MASTER, role: 'authenticated' }
  const readIds = async (claims) => (await as('authenticated', 'SELECT id FROM public.challenges ORDER BY id', [], claims)).map((r) => r.id)
  const seedChallenges = async () => {
    await runSql('DELETE FROM public.challenges')
    // ends_on from 20 days ago to 2 days ahead on BOTH clocks the tests use, at both studios.
    const { rows } = await db.query(`SELECT d::date::text AS d FROM generate_series(
      (now() AT TIME ZONE 'America/New_York')::date - 20, (now() AT TIME ZONE 'Europe/Dublin')::date + 2, interval '1 day') d`)
    let i = 0
    for (const loc of [LOC_D, LOC_N]) {
      for (const { d } of rows) {
        i++
        await db.query(`INSERT INTO public.challenges (id, location_id, name, starts_on, ends_on, is_flagship)
          VALUES ($1, $2, 'Challenge ' || $3, ($4::date - 30), $4::date, true)`, [`40000000-0000-0000-0000-${hex(i)}`, loc, i, d])
      }
    }
  }

  beforeAll(async () => {
    await bootPre721()
    catBefore = await catalog()
    polBefore = await policies()
    for (const at of CH_INSTANTS) {
      pinClock(at)
      await seedChallenges()
      challengeReadsBefore.set(at, {
        member: await readIds(MEMBER_CLAIMS), staff: await readIds(STAFF_CLAIMS), master: await readIds(MASTER_CLAIMS),
      })
    }
    pinClock('2026-10-11T12:00:00Z')
    verifyBefore = await fingerprints()
    await runSql(MIG_721)
    verifyAfter = await fingerprints()   // same data, same clock: only 721 in between
  }, 120_000)
  afterAll(async () => { pinClock('2026-10-11T12:00:00Z'); await db?.close() })

  // ── catalog ──────────────────────────────────────────────────────────────
  it('only the bodies moved: same OID, ACL, SECURITY INVOKER, volatility, search_path, owner, signature', async () => {
    const after = await catalog()
    expect(after.map(({ body: _b, ...r }) => r)).toEqual(catBefore.map(({ body: _b, ...r }) => r))
    for (let i = 0; i < after.length; i++) expect(after[i].body, after[i].fn).not.toBe(catBefore[i].body)
    expect(after.every((r) => r.prosecdef === false)).toBe(true)
    for (const fn of FIVE) {
      const { rows } = await db.query(`SELECT has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon,
          has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authd,
          has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS svc`, [fn])
      expect(rows[0], fn).toEqual({ anon: false, authd: false, svc: true })
    }
  })

  it('no rewritten body converts AT TIME ZONE \'Europe/Dublin\' except tombstone\'s pending-leave date; D5\'s four are untouched', async () => {
    const pinned = (await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public', 'private') AND p.prosrc ~* 'at\\s+time\\s+zone\\s+''europe/dublin''' ORDER BY 1`)).map((r) => r.proname)
    expect(pinned).toEqual(['org_ai_spend_month_cents', 'org_email_sends_month', 'rollup_usage_for_day', 'tombstone_staff_profile', 'wallet_apply'])
    const [{ src }] = await q(`SELECT prosrc AS src FROM pg_proc WHERE oid = 'public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean)'::regprocedure`)
    expect(src.match(/AT TIME ZONE 'Europe\/Dublin'/g)).toHaveLength(1)
    expect(src).toMatch(/v_today := \(p_now AT TIME ZONE 'Europe\/Dublin'\)::date;/)
    expect(src).not.toMatch(/\bv_time\b/)
  })

  it('D5: the billing four keep their bodies and gain a comment naming D5 (wallet_apply\'s own comment kept)', async () => {
    const rows = await q(`SELECT p.proname, obj_description(p.oid, 'pg_proc') AS c FROM pg_proc p
      WHERE p.proname IN ('wallet_apply', 'rollup_usage_for_day', 'org_ai_spend_month_cents', 'org_email_sends_month') ORDER BY 1`)
    for (const r of rows) expect(r.c, r.proname).toMatch(/D5 \(TZ\.15, mig 721\): the platform billing calendar \(Europe\/Dublin\) by decision/)
    expect(rows.find((r) => r.proname === 'wallet_apply').c).toMatch(/^INTEG-C2a: the ONLY write path for wallets\. D5 \(TZ\.15/)
  })

  it('comments: the rewritten functions and the wall-clock settings columns name the studio zone', async () => {
    const fnComment = async (fn) => (await q(`SELECT obj_description($1::regprocedure, 'pg_proc') AS c`, [fn]))[0].c
    expect(await fnComment(FIVE[1])).toMatch(/bucketed in the studio's timezone \(locations\.timezone; TZ\.15, mig 721\)\. CONSENT SOURCES/)
    expect(await fnComment(FIVE[2])).toMatch(/bucketed in the studio's timezone \(locations\.timezone; TZ\.15, mig 721\)\. This is/)
    expect(await fnComment(FIVE[3])).toMatch(/NOT STARTED at p_now on the wall clock of the shift's own studio/)
    expect(await fnComment(FIVE[3])).toMatch(/^STAFFDELETE\.1 \(mig 622\)/)
    const col = async (t, c) => (await q(`SELECT col_description($1::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2)) AS c`, [t, c]))[0].c
    expect(await col('public.email_sequences', 'send_window')).toMatch(/^Optional delivery window on the studio's wall clock \(locations\.timezone/)
    expect(await col('public.company_settings', 'send_quiet_hours_start')).toMatch(/on the studio's wall clock/)
    expect(await col('public.company_settings', 'send_quiet_hours_end')).toMatch(/on the studio's wall clock/)
    expect(await col('public.whatsapp_broadcasts', 'send_window_tz')).toMatch(/Since TZ\.4/)
    // Defaults stay (binding decision).
    const defs = await q(`SELECT table_name, column_default FROM information_schema.columns
      WHERE (table_name, column_name) IN (('locations', 'timezone'), ('whatsapp_broadcasts', 'send_window_tz')) ORDER BY 1`)
    expect(defs).toEqual([{ table_name: 'locations', column_default: "'Europe/Dublin'::text" },
      { table_name: 'whatsapp_broadcasts', column_default: "'Europe/Dublin'::text" }])
  })

  it('service_role has no USAGE on private, so an INVOKER body calling private.location_tz would fail; the five run', async () => {
    expect((await q(`SELECT has_schema_privilege('service_role', 'private', 'USAGE') AS u`))[0].u).toBe(false)
    await runSql(`CREATE FUNCTION legacy.probe(p uuid) RETURNS text LANGUAGE sql STABLE SECURITY INVOKER AS $$ SELECT private.location_tz(p) $$;
      GRANT USAGE ON SCHEMA legacy TO service_role; GRANT EXECUTE ON FUNCTION legacy.probe(uuid) TO service_role;`)
    await expect(as('service_role', `SELECT legacy.probe('${LOC_D}')`)).rejects.toThrow(/permission denied for schema private/)
    await runSql('DROP FUNCTION legacy.probe(uuid); REVOKE USAGE ON SCHEMA legacy FROM service_role;')
    await expect(as('service_role', `SELECT * FROM public.hyrox_coaches_on_shift('${LOC_D}', now(), now() + interval '1 hour')`)).resolves.toBeDefined()
    await expect(as('service_role', `SELECT * FROM public.list_health_monthly_stats('${LOC_D}')`)).resolves.toHaveLength(12)
    await expect(as('service_role', `SELECT * FROM public.email_sends_monthly_stats('${LOC_D}')`)).resolves.toBeDefined()
    await expect(as('service_role', `SELECT public.tombstone_staff_profile('${GONE}', '${MASTER}', now(), true) AS s`)).resolves.toHaveLength(1)
  })

  // ── tombstone_staff_profile ──────────────────────────────────────────────
  describe('tombstone_staff_profile: only "has this shift started?" moved', () => {
    const dry = async (fn, at) => (await q(`SELECT ${fn}($1, $2, $3, true) AS s`, [GONE, MASTER, at]))[0].s
    const ids = (arr) => arr.map((x) => x.assignment_id).sort()

    it.each(SAMPLES)('Europe/Dublin: the dry-run summary is identical to mig 622\'s at %s', async (at) => {
      expect(await dry('public.tombstone_staff_profile', at)).toStrictEqual(await dry('legacy.tombstone_staff_profile', at))
    })

    it('Europe/Dublin: the real run removes exactly the assignments 622 removes (both rolled back)', async () => {
      const at = '2026-03-29T00:59:00Z'
      const left = async (fn, role) => {
        await runSql('BEGIN')
        try {
          await runSql(`SET LOCAL ROLE ${role}`)
          await db.query(`SELECT ${fn}($1, $2, $3, false)`, [GONE, MASTER, at])
          await runSql('RESET ROLE')
          return (await q(`SELECT id FROM public.shift_assignments WHERE profile_id = $1 ORDER BY id`, [GONE])).map((r) => r.id)
        } finally {
          await runSql('ROLLBACK')
        }
      }
      const kept = await left('public.tombstone_staff_profile', 'service_role')
      expect(kept).toEqual(await left('legacy.tombstone_staff_profile', 'postgres'))
      expect(kept.length).toBeGreaterThan(0)
      expect(kept.length).toBeLessThan(GRID.length)
    })

    /** What the summary must say, from a JS Intl oracle: started = (date, start) <= p_now on the block's clock. */
    function oracle(at, zoneOf) {
      const nowMs = Date.parse(at)
      const removed = []
      const kept = []
      for (const g of GRID) {
        const local = wall(zoneOf(g.loc), nowMs)
        const notStarted = `${g.date}T${pad(g.override ?? g.start)}` > local
        const history = g.arrived || g.attended
        if (notStarted && !history) removed.push(g.assignment)
        else if (g.date >= local.slice(0, 10)) kept.push({ id: g.assignment, reason: notStarted ? 'arrived' : 'started' })
      }
      return { removed: removed.sort(), kept: kept.sort((a, b) => a.id.localeCompare(b.id)) }
    }
    const summaryOf = (s) => ({
      removed: ids(s.removed_shifts),
      kept: s.kept_today_shifts.map((x) => ({ id: x.assignment_id, reason: x.reason })).sort((a, b) => a.id.localeCompare(b.id)),
    })

    it.each(SAMPLES)('the oracle agrees with Europe/Dublin at %s (both studios Dublin)', async (at) => {
      expect(summaryOf(await dry('public.tombstone_staff_profile', at))).toEqual(oracle(at, () => DUB))
    })

    it.each(SAMPLES)('a New York block is judged on the New York clock, a Dublin one on Dublin\'s, from one p_now (%s)', async (at) => {
      await setZone(LOC_N, NY)
      try {
        const s = await dry('public.tombstone_staff_profile', at)
        expect(summaryOf(s)).toEqual(oracle(at, (loc) => (loc === LOC_N ? NY : DUB)))
        // The Dublin studio's verdicts are exactly 622's, NY or not.
        const legacyS = await dry('legacy.tombstone_staff_profile', at)
        const dublinOnly = (x) => x.filter((r) => r.location_id === LOC_D)
        expect(dublinOnly(s.removed_shifts)).toStrictEqual(dublinOnly(legacyS.removed_shifts))
        expect(dublinOnly(s.kept_today_shifts)).toStrictEqual(dublinOnly(legacyS.kept_today_shifts))
        // Leave stays on the Dublin date (TZ.15 changed only the shift test).
        expect(s.cancelled_time_off).toStrictEqual(legacyS.cancelled_time_off)
      } finally {
        await setZone(LOC_N, DUB)
      }
    })

    it('17:30 EDT: a NY 18:00 shift has NOT started (removed); on Dublin\'s clock (22:30) it had', async () => {
      await setZone(LOC_N, NY)
      try {
        const at = '2026-09-19T21:30:00Z'
        await runSql(`INSERT INTO public.shift_blocks (id, location_id, block_date, start_time, end_time, roster_id) VALUES
            ('23000000-0000-0000-0000-000000000001', '${LOC_N}', '2026-09-19', '18:00', '21:00', '${R_PUB}');
          INSERT INTO public.shift_assignments (id, block_id, profile_id) VALUES
            ('34000000-0000-0000-0000-000000000001', '23000000-0000-0000-0000-000000000001', '${GONE}')`)
        const s = await dry('public.tombstone_staff_profile', at)
        expect(ids(s.removed_shifts)).toContain('34000000-0000-0000-0000-000000000001')
        const old = await dry('legacy.tombstone_staff_profile', at)
        expect(ids(old.removed_shifts)).not.toContain('34000000-0000-0000-0000-000000000001')
        expect(old.kept_today_shifts.map((x) => [x.assignment_id, x.reason])).toContainEqual(['34000000-0000-0000-0000-000000000001', 'started'])
      } finally {
        await runSql(`DELETE FROM public.shift_blocks WHERE id = '23000000-0000-0000-0000-000000000001'`)
        await setZone(LOC_N, DUB)
      }
    })
  })

  // ── hyrox_coaches_on_shift ───────────────────────────────────────────────
  describe('hyrox_coaches_on_shift', () => {
    // PEER (active) and GONE (the function does not judge activity) are on
    // every grid block; GONE carries the grid's start overrides.
    beforeAll(async () => {
      await runSql(`INSERT INTO public.shift_assignments (id, block_id, profile_id) VALUES
        ${GRID.map((g) => `('${g.peer}', '${g.block}', '${PEER}')`).join(',\n')}`)
    })
    afterAll(async () => { await runSql(`DELETE FROM public.shift_assignments WHERE profile_id = '${PEER}'`) })
    const coaches = async (fn, loc, at, mins = 60) => (await q(
      `SELECT profile_id FROM ${fn}($1, $2::timestamptz, $2::timestamptz + make_interval(mins => $3)) ORDER BY 1`, [loc, at, mins])).map((r) => r.profile_id)
    // Every 30 min across both 2026 DST days in each zone, plus the samples.
    const INSTANTS = [...SAMPLES]
    for (const day of ['2026-03-08', '2026-03-29', '2026-10-25', '2026-11-01']) {
      for (let m = 0; m < 30 * 60; m += 30) INSTANTS.push(new Date(Date.parse(`${day}T00:00:00Z`) - 3 * 3600_000 + m * 60_000).toISOString())
    }

    it('Europe/Dublin: the same coaches as mig 448 at every instant (both 15- and 60-minute windows), and the oracle agrees', async () => {
      for (const at of INSTANTS) {
        expect(await coaches('public.hyrox_coaches_on_shift', LOC_N, at, 60), at).toEqual(oracleCoaches(DUB, at, 60))
        for (const mins of [15, 60]) {
          expect(await coaches('public.hyrox_coaches_on_shift', LOC_D, at, mins), `${at} ${mins}`)
            .toEqual(await coaches('legacy.hyrox_coaches_on_shift', LOC_D, at, mins))
        }
      }
    }, 120_000)

    /** Oracle: a block covers [s, e) on the studio's wall clock (block_date = local date of s). */
    function oracleCoaches(zone, at, mins) {
      const s = wall(zone, Date.parse(at))
      const e = wall(zone, Date.parse(at) + mins * 60_000)
      const on = new Set()
      for (const g of GRID) {
        if (g.loc !== LOC_N || g.date !== s.slice(0, 10)) continue
        if (`${g.date}T${pad(g.start)}` < e && `${g.date}T${pad(g.end)}` > s) on.add(PEER)
        if (`${g.date}T${pad(g.override ?? g.start)}` < e && `${g.date}T${pad(g.end)}` > s) on.add(GONE)
      }
      return [...on].sort()
    }

    it('America/New_York: a class instant finds the coaches rostered on the NY wall clock', async () => {
      await setZone(LOC_N, NY)
      try {
        for (const at of INSTANTS) {
          for (const mins of [15, 60]) {
            expect(await coaches('public.hyrox_coaches_on_shift', LOC_N, at, mins), `${at} ${mins}`).toEqual(oracleCoaches(NY, at, mins))
          }
        }
        // 16:15Z on 8 Mar is 12:15 EDT (after spring-forward): inside NY's 12:00-13:00 block.
        // On Dublin's clock (16:15 GMT) no block covers it.
        expect(await coaches('public.hyrox_coaches_on_shift', LOC_N, '2026-03-08T16:15:00Z', 30)).toContain(PEER)
        expect(await coaches('legacy.hyrox_coaches_on_shift', LOC_N, '2026-03-08T16:15:00Z', 30)).toEqual([])
      } finally {
        await setZone(LOC_N, DUB)
      }
    }, 120_000)
  })

  // ── list_health_monthly_stats / email_sends_monthly_stats ───────────────
  describe('the monthly stats bucket on the studio\'s calendar', () => {
    const CAMPAIGN = '50000000-0000-0000-0000-000000000001'
    beforeAll(async () => {
      // Sends and consent rows a minute either side of every Dublin and NY
      // month boundary in 2026, at studio N.
      const instants = []
      for (let m = 0; m < 12; m++) {
        const first = `2026-${String(m + 1).padStart(2, '0')}-01`
        for (const zone of [DUB, NY]) {
          const r = (await q(`SELECT extract(epoch FROM ($1::timestamp AT TIME ZONE $2)) * 1000 AS ms`, [first, zone]))[0]
          for (const d of [-60_000, 60_000]) instants.push(new Date(Number(r.ms) + d).toISOString())
        }
      }
      instants.push(...SAMPLES)
      await runSql(`INSERT INTO public.campaigns VALUES ('${CAMPAIGN}', '${LOC_N}')`)
      for (const [i, at] of instants.entries()) {
        await db.query(`INSERT INTO public.campaign_recipients (campaign_id, sent_at, bounce_type, opened_at) VALUES ($1, $2, $3, $4)`,
          [CAMPAIGN, at, i % 3 === 0 ? 'hard' : null, i % 2 === 0 ? at : null])
        await db.query(`INSERT INTO public.email_sends (location_id, source_type, sent_at, bounce_type) VALUES ($1, $2, $3, $4)`,
          [LOC_N, i % 2 ? 'sequence' : 'transactional', at, i % 4 === 0 ? 'soft' : null])
        await db.query(`INSERT INTO public.consent_log (contact_id, location_id, channel, action, source, created_at) VALUES ($1, NULL, 'email_marketing', $2, $3, $4)`,
          [CONTACT_M, i % 2 ? 'opt_in' : 'opt_out', i % 3 ? 'admin_panel' : 'bulk_import', at])
      }
    })
    const NOWS = ['2026-12-31T23:30:00Z', '2026-11-01T04:30:00Z', '2026-10-31T23:30:00Z', '2026-03-31T23:30:00Z', '2026-07-01T03:59:00Z']
    const listHealth = (fn, months) => q(`SELECT * FROM ${fn}($1, $2, '{admin_panel}', '{}', '{}', '{bulk_import}')`, [LOC_N, months])
    const emailSends = (fn, months) => q(`SELECT * FROM ${fn}($1, $2)`, [LOC_N, months])

    it.each(NOWS)('Europe/Dublin: both return exactly what 517/521 return (now = %s; 1, 12 and 36 months)', async (at) => {
      pinClock(at)
      try {
        for (const months of [1, 12, 36]) {
          expect(await listHealth('public.list_health_monthly_stats', months)).toStrictEqual(await listHealth('legacy.list_health_monthly_stats', months))
          expect(await emailSends('public.email_sends_monthly_stats', months)).toStrictEqual(await emailSends('legacy.email_sends_monthly_stats', months))
        }
      } finally { pinClock('2026-10-11T12:00:00Z') }
    })

    it('America/New_York: NY midnight splits the months; the last month is NY\'s', async () => {
      await setZone(LOC_N, NY)
      pinClock('2026-11-01T03:30:00Z') // 31 Oct 23:30 EDT; already 1 Nov in Dublin
      try {
        const lh = (await listHealth('public.list_health_monthly_stats', 12)).map((r) => ({ ...r, month: isoDate(r.month.getTime()) }))
        expect(lh.at(-1).month).toBe('2026-10-01')
        expect(isoDate((await listHealth('legacy.list_health_monthly_stats', 12)).at(-1).month.getTime())).toBe('2026-11-01')
        // A send at 1 Oct 03:59 UTC is 30 Sep 23:59 EDT: September in NY.
        const expectNy = await q(`SELECT date_trunc('month', sent_at AT TIME ZONE 'America/New_York')::date::text AS m, count(*)::int AS n
          FROM public.campaign_recipients GROUP BY 1`)
        for (const row of lh) {
          const want = expectNy.find((r) => r.m === row.month)?.n ?? 0
          expect(Number(row.sends), row.month).toBe(want)
        }
        const es = await emailSends('public.email_sends_monthly_stats', 12)
        const byMonth = {}
        for (const r of es) byMonth[isoDate(r.month.getTime())] = (byMonth[isoDate(r.month.getTime())] ?? 0) + Number(r.sends)
        const wantEs = await q(`SELECT date_trunc('month', sent_at AT TIME ZONE 'America/New_York')::date::text AS m, count(*)::int AS n
          FROM public.email_sends WHERE sent_at >= ('2025-11-01'::timestamp AT TIME ZONE 'America/New_York') GROUP BY 1`)
        for (const [m, n] of Object.entries(byMonth)) expect(n, m).toBe(wantEs.find((r) => r.m === m)?.n ?? 0)
        expect(Object.keys(byMonth).sort().at(-1)).toBe('2026-10-01')
      } finally {
        pinClock('2026-10-11T12:00:00Z')
        await setZone(LOC_N, DUB)
      }
    })
  })

  // ── claim_shift_offer ────────────────────────────────────────────────────
  describe('claim_shift_offer: the claimant-overlap check', () => {
    // The offered shift: studio D, 29 Mar 2026 (EU spring-forward), 10:00-12:00.
    beforeAll(async () => {
      await runSql(`INSERT INTO public.shift_blocks (id, location_id, block_date, start_time, end_time, min_coaches, max_coaches, roster_id) VALUES
        ('${OFFER_BLOCK}', '${LOC_D}', '2026-03-29', '10:00', '12:00', 1, 3, '${R_PUB}')`)
    })
    const OTHER = '24000000-0000-0000-0000-000000000001'
    /** The outcome of claiming the offered shift while PEER works [date start, end) at `loc` (rolled back). */
    async function outcome(fn, role, { loc, date, start, end }, offerBlock = OFFER_BLOCK) {
      await runSql('BEGIN')
      try {
        await db.query(`INSERT INTO public.shift_blocks (id, location_id, block_date, start_time, end_time, roster_id) VALUES ($1, $2, $3, $4, $5, $6)`,
          [OTHER, loc, date, start, end, R_PUB])
        await db.query(`INSERT INTO public.shift_assignments (block_id, profile_id) VALUES ($1, $2)`, [OTHER, PEER])
        const [{ id }] = (await db.query(`INSERT INTO public.shift_offers (location_id, block_id, offered_by, status) VALUES ($1, $2, $3, 'open') RETURNING id`,
          [LOC_D, offerBlock, MASTER])).rows
        await runSql(`SET LOCAL ROLE ${role}`)
        try {
          return (await db.query(`SELECT ${fn}($1, $2) AS r`, [id, PEER])).rows[0].r.outcome
        } catch (e) {
          return String(e.message).split(':')[0]
        }
      } finally {
        await runSql('ROLLBACK')
      }
    }
    const SHIFT_TIMES = [['08:00', '10:00'], ['08:00', '10:01'], ['09:00', '11:00'], ['10:00', '12:00'], ['10:30', '11:00'],
      ['11:59', '13:00'], ['12:00', '14:00'], ['00:00', '00:30'], ['23:00', '23:59:59'], ['01:00', '03:00']]

    it('Europe/Dublin: every scenario has 641\'s outcome (other studio, same zone; dates -2..+2)', async () => {
      let overlaps = 0
      for (const loc of [LOC_D, LOC_N]) {
        for (const k of [-2, -1, 0, 1, 2]) {
          for (const [start, end] of SHIFT_TIMES) {
            const sc = { loc, date: addDays('2026-03-29', k), start, end }
            const got = await outcome('public.claim_shift_offer', 'service_role', sc)
            expect(got, JSON.stringify(sc)).toBe(await outcome('legacy.claim_shift_offer', 'postgres', sc))
            if (got === 'claimant_overlap') overlaps++
          }
        }
      }
      expect(overlaps).toBe(2 * 5) // 08:00-10:01, 09-11, 10-12, 10:30-11, 11:59-13 on the same date, at each studio
    }, 120_000)

    it('America/New_York: shifts in different zones overlap on instants, across a date line', async () => {
      await setZone(LOC_N, NY)
      try {
        // 29 Mar 10:00-12:00 Dublin (IST, from 01:00Z that day) = 09:00-11:00Z = 05:00-07:00 EDT.
        expect(await outcome('public.claim_shift_offer', 'service_role', { loc: LOC_N, date: '2026-03-29', start: '05:00', end: '06:00' })).toBe('claimant_overlap')
        expect(await outcome('legacy.claim_shift_offer', 'postgres', { loc: LOC_N, date: '2026-03-29', start: '05:00', end: '06:00' })).toBe('claimed')
        // Same wall clock, different instants: no longer an overlap.
        expect(await outcome('public.claim_shift_offer', 'service_role', { loc: LOC_N, date: '2026-03-29', start: '10:00', end: '12:00' })).toBe('claimed')
        expect(await outcome('legacy.claim_shift_offer', 'postgres', { loc: LOC_N, date: '2026-03-29', start: '10:00', end: '12:00' })).toBe('claimant_overlap')
        // Ends that only touch (07:00 EDT = 11:00Z, the offered end; 05:00 EDT = 09:00Z, its start) are not an overlap.
        expect(await outcome('public.claim_shift_offer', 'service_role', { loc: LOC_N, date: '2026-03-29', start: '07:00', end: '08:00' })).toBe('claimed')
        expect(await outcome('public.claim_shift_offer', 'service_role', { loc: LOC_N, date: '2026-03-29', start: '04:00', end: '05:00' })).toBe('claimed')
        // Across a date line: a NY shift on the PREVIOUS local date overlaps an early Dublin one.
        await runSql(`INSERT INTO public.shift_blocks (id, location_id, block_date, start_time, end_time, roster_id) VALUES
          ('21000000-0000-0000-0000-000000000002', '${LOC_D}', '2026-03-29', '04:00', '05:00', '${R_PUB}')`)
        try {
          // 29 Mar 04:00-05:00 IST = 03:00-04:00Z; NY 28 Mar 23:00-23:59:59 EDT = 29 Mar 03:00-03:59:59Z.
          expect(await outcome('public.claim_shift_offer', 'service_role', { loc: LOC_N, date: '2026-03-28', start: '23:00', end: '23:59:59' },
            '21000000-0000-0000-0000-000000000002')).toBe('claimant_overlap')
          expect(await outcome('legacy.claim_shift_offer', 'postgres', { loc: LOC_N, date: '2026-03-28', start: '23:00', end: '23:59:59' },
            '21000000-0000-0000-0000-000000000002')).toBe('claimed')
        } finally {
          await runSql(`DELETE FROM public.shift_blocks WHERE id = '21000000-0000-0000-0000-000000000002'`)
        }
      } finally {
        await setZone(LOC_N, DUB)
      }
    }, 60_000)
  })

  // ── challenges_read ──────────────────────────────────────────────────────
  describe('challenges_read', () => {
    const MEMBER_CLAIMS_ = { sub: MEMBER_UID, role: 'authenticated' }

    it('only USING changed: still the one PERMISSIVE SELECT policy TO public, no WITH CHECK', async () => {
      const after = await policies()
      expect(after.map(({ qual: _q, ...r }) => r)).toEqual(polBefore.map(({ qual: _q, ...r }) => r))
      expect(after).toHaveLength(1)
      expect(after[0].qual).not.toMatch(/Europe\/Dublin/)
      expect(after[0].qual).toContain('private.location_tz(mc.location_id)')
    })

    it.each(CH_INSTANTS)('Europe/Dublin: member, staff and master read exactly what they read under 686 (%s)', async (at) => {
      pinClock(at)
      try {
        await seedChallenges()
        const before = challengeReadsBefore.get(at)
        expect(await readIds(MEMBER_CLAIMS_)).toEqual(before.member)
        expect(await readIds(STAFF_CLAIMS)).toEqual(before.staff)
        expect(await readIds(MASTER_CLAIMS)).toEqual(before.master)
        expect(before.member.length).toBeGreaterThan(0)
      } finally { pinClock('2026-10-11T12:00:00Z') }
    })

    it.each(CH_INSTANTS)('America/New_York: a NY member\'s window is 14 NY days; equals private.location_tz(challenges.location_id) per row (%s)', async (at) => {
      pinClock(at)
      await setZone(LOC_N, NY)
      try {
        await seedChallenges()
        const got = await readIds(MEMBER_CLAIMS_)
        const want = (await q(`SELECT c.id FROM public.challenges c WHERE c.location_id = $1
            AND c.ends_on >= ((now() AT TIME ZONE private.location_tz(c.location_id))::date - 14) ORDER BY 1`, [LOC_N])).map((r) => r.id)
        expect(got).toEqual(want)
        const nyEdge = (await q(`SELECT ((now() AT TIME ZONE 'America/New_York')::date - 14)::text AS d,
          ((now() AT TIME ZONE 'Europe/Dublin')::date - 14)::text AS dub`))[0]
        const { rows } = await db.query(`SELECT id FROM public.challenges WHERE location_id = $1 AND ends_on = $2::date`, [LOC_N, nyEdge.d])
        expect(got).toContain(rows[0].id) // the 14th NY day is still shown
        if (nyEdge.d !== nyEdge.dub) {
          // Dublin is already a day ahead: on 686's clock this row had gone.
          const legacyVisible = await q(`SELECT 1 FROM public.challenges WHERE id = $1 AND ends_on >= ((now() AT TIME ZONE 'Europe/Dublin')::date - 14)`, [rows[0].id])
          expect(legacyVisible).toEqual([])
        }
      } finally {
        await setZone(LOC_N, DUB)
        pinClock('2026-10-11T12:00:00Z')
      }
    })

    it('the zone lookup is an InitPlan (once per statement), not a per-row SubPlan', async () => {
      const plan = (await as('authenticated', 'EXPLAIN (COSTS OFF) SELECT id FROM public.challenges', [], MEMBER_CLAIMS_)).map((r) => r['QUERY PLAN']).join('\n')
      // The member window reads `now() AT TIME ZONE (InitPlan n).col1`: one zone per statement.
      expect(plan).toMatch(/now\(\) AT TIME ZONE \(InitPlan \d+\)\.col1/)
    })

    it('a login with no contact reads nothing; anon is refused by the grant', async () => {
      expect(await readIds({ sub: '20000000-0000-0000-0000-0000000000ff', role: 'authenticated' })).toEqual([])
      await expect(as('anon', 'SELECT id FROM public.challenges')).rejects.toThrow(/permission denied for table challenges/)
    })
  })

  it('the verify script (tests/sql/tz-721.sql) runs whole, and its section B fingerprints are identical before and after', async () => {
    expect(verifyBefore).toHaveLength(4)
    expect(verifyBefore[3]).toEqual([{ window_mismatches: 0 }])
    expect(verifyBefore[2][0].profiles).toBeGreaterThan(0)
    expect(verifyAfter).toEqual(verifyBefore)
    await expect(runSql(VERIFY)).resolves.toBeDefined()
  }, 120_000)

  it('a second run passes and changes nothing', async () => {
    const cat = await catalog()
    const pol = await policies()
    await expect(runSql(MIG_721)).resolves.toBeDefined()
    expect(await catalog()).toEqual(cat)
    expect(await policies()).toEqual(pol)
  })
})

// ═════════════════════════════════════════════════════════════════════════
describe('721 aborts the whole file, with nothing applied', () => {
  afterEach(async () => { if (db && !db.closed) await db.close() })

  async function expectAbort(before, message) {
    await bootPre721({ before })
    const cat = await catalog()
    const pol = await policies()
    await expect(runSql(MIG_721)).rejects.toThrow(message)
    await runSql('ROLLBACK') // the failed multi-statement run leaves its BEGIN open and aborted
    expect(await catalog()).toEqual(cat)
    expect(await policies()).toEqual(pol)
  }

  it('when a body is not the migration body (a hand edit on prod)', () => expectAbort(
    `CREATE OR REPLACE FUNCTION public.hyrox_coaches_on_shift(p_location uuid, p_start timestamptz, p_end timestamptz)
       RETURNS TABLE(profile_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$ SELECT NULL::uuid WHERE false $$;`,
    /mig 721: not the body this file was written against: public\.hyrox_coaches_on_shift/,
  ), 120_000)

  it('when challenges_read is not 686\'s', () => expectAbort(
    `ALTER POLICY challenges_read ON public.challenges USING (true);`,
    /mig 721: public\.challenges did not start with exactly mig 686's challenges_read/,
  ), 120_000)

  it('when the file would move an ACL (a stray client grant its REVOKE would drop)', () => expectAbort(
    `GRANT EXECUTE ON FUNCTION public.claim_shift_offer(uuid, uuid) TO authenticated;`,
    /mig 721: more than the body moved \(ACL, signature, SECURITY, search_path, owner or language\): claim_shift_offer/,
  ), 120_000)

  it('when private.location_tz (mig 719) is missing', () => expectAbort(
    `DROP FUNCTION private.location_tz(uuid);`,
    /mig 721: private\.location_tz\(uuid\) is missing; apply mig 719 first/,
  ), 120_000)

  it('starts with BEGIN + a 5s lock_timeout and ends with COMMIT', () => {
    expect(MIG_721).toMatch(/^BEGIN;\nSET LOCAL lock_timeout = '5s';\n/m)
    expect(MIG_721).toMatch(/^COMMIT;\s*$/m)
  })
})
