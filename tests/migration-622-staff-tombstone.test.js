// tests/migration-622-staff-tombstone.test.js
// STAFFDELETE.1 — behavioural test for migration 622, against the REAL file.
// Fixture names are invented (the repo is public).

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_622 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/622_staff_tombstone.sql'), 'utf8')
// The REAL last-master guard (mig 080), not a stand-in: the tombstone demotes
// role, and that trigger is what judges a master -> staff UPDATE.
const MIG_080 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/080_assignment_audit_and_master_guard.sql'), 'utf8')
const MASTER_GUARD = MIG_080.slice(
  MIG_080.indexOf('CREATE OR REPLACE FUNCTION private.guard_at_least_one_master()'),
  MIG_080.indexOf('COMMENT ON FUNCTION private.guard_at_least_one_master()'),
)

// 14:00 on the Dublin wall clock (IST = UTC+1 in September).
const NOW = '2026-09-19T13:00:00Z'
const LOC = 'a0000000-0000-0000-0000-00000000000a'
const GONE = '10000000-0000-0000-0000-000000000001'   // deactivated coach being deleted
const PEER = '10000000-0000-0000-0000-000000000002'
const MASTER = '10000000-0000-0000-0000-000000000009'
const OLD_MASTER = '10000000-0000-0000-0000-000000000008' // deactivated master
const OLD_OWNER = '10000000-0000-0000-0000-000000000007'  // deactivated, profiles.role = 'owner'
const TPL = '40000000-0000-0000-0000-000000000001'
const R_PUB = '60000000-0000-0000-0000-000000000001'
const R_DRAFT = '60000000-0000-0000-0000-000000000002'
const B_PAST = '20000000-0000-0000-0000-000000000001'
const B_PUB = '20000000-0000-0000-0000-000000000002'
const B_DRAFT = '20000000-0000-0000-0000-000000000003'
const B_YDAY = '20000000-0000-0000-0000-000000000004'      // 2026-09-18
const B_TODAY_AM = '20000000-0000-0000-0000-000000000005'  // today 06:00-09:00 — worked
const B_TODAY_NOW = '20000000-0000-0000-0000-000000000006' // today 14:00 — starts EXACTLY at NOW
const B_TODAY_PM = '20000000-0000-0000-0000-000000000007'  // today 18:00 — not started
const B_TMRW = '20000000-0000-0000-0000-000000000008'      // 2026-09-20
const A_PAST = '30000000-0000-0000-0000-000000000001'
const A_PUB = '30000000-0000-0000-0000-000000000002'
const A_DRAFT = '30000000-0000-0000-0000-000000000003'
const A_PEER = '30000000-0000-0000-0000-000000000004'
const A_YDAY = '30000000-0000-0000-0000-000000000005'
const A_TODAY_AM = '30000000-0000-0000-0000-000000000006'
const A_TODAY_NOW = '30000000-0000-0000-0000-000000000007'
const A_TODAY_PM = '30000000-0000-0000-0000-000000000008'
const A_TMRW = '30000000-0000-0000-0000-000000000009'
const S_MINE = '50000000-0000-0000-0000-000000000001'   // GONE asked PEER
const S_THEIRS = '50000000-0000-0000-0000-000000000002' // PEER asked GONE
const S_OLD = '50000000-0000-0000-0000-000000000003'    // approved long ago
const T_PAST = '70000000-0000-0000-0000-000000000001'
const T_PENDING = '70000000-0000-0000-0000-000000000002'
const T_EXPIRED = '70000000-0000-0000-0000-000000000003'
const T_APPROVED = '70000000-0000-0000-0000-000000000004'
const INV = '80000000-0000-0000-0000-000000000001'

// FK actions are the catalog's (mig 004, 010, 011, 023, 067, 101, 152, 236, 417,
// 485, 603, 607) — CASCADE where prod cascades, so a DELETE would show.
const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);

  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
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

  CREATE TABLE public.shift_templates (id uuid PRIMARY KEY, name text, start_time time, end_time time);
  CREATE TABLE public.rosters (id uuid PRIMARY KEY, status text NOT NULL);
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY, location_id uuid REFERENCES public.locations(id), template_id uuid REFERENCES public.shift_templates(id),
    block_date date NOT NULL, start_time time NOT NULL, end_time time NOT NULL, roster_id uuid REFERENCES public.rosters(id)
  );
  CREATE TABLE public.shift_assignments (
    id uuid PRIMARY KEY, block_id uuid NOT NULL REFERENCES public.shift_blocks(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    status text DEFAULT 'scheduled', start_time_override time, end_time_override time,
    arrived_at timestamptz  -- mig 609 (ARRIVAL.1): a geofence arrival, matched up to 45 min BEFORE the start
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
    type text, start_date date NOT NULL, end_date date NOT NULL, total_days numeric,
    status text NOT NULL DEFAULT 'pending', review_note text, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.staff_allowances (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, year int, total_days numeric, used_days numeric);
  CREATE TABLE public.schedule_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, type text);
  CREATE TABLE public.contractor_invoices (id uuid PRIMARY KEY, contractor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, invoice_amount numeric);
  -- mig 120:79 — a clock-in is matched to the assignment it was worked against.
  CREATE TABLE public.staff_attendance_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    matched_assignment_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL
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
  -- Stand-in for mig 191's audit_mutation trigger: it copies the OLD values
  -- (email, pin_hash) into audit_events on every profiles UPDATE, which is why
  -- the function must redact AFTER it strips.
  CREATE FUNCTION public.test_audit_profiles() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    INSERT INTO public.audit_events (category, action, target_resource, details)
    VALUES ('mutation', 'profiles.updated', 'profiles/' || NEW.id::text,
            jsonb_build_object('before', jsonb_build_object('email', OLD.email, 'pin_hash', OLD.pin_hash)));
    RETURN NULL;
  END $fn$;
  CREATE TRIGGER audit_mutation AFTER UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.test_audit_profiles();
  CREATE SCHEMA private;
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}', 'Studio One');
  INSERT INTO auth.users VALUES ('${GONE}', 'former.coach@example.test'), ('${PEER}', 'peer@example.test'), ('${MASTER}', 'master@example.test'),
    ('${OLD_MASTER}', 'old.master@example.test'), ('${OLD_OWNER}', 'old.owner@example.test');
  INSERT INTO public.profiles (id, email, full_name, role, active, avatar_url, hourly_rate, unifi_user_id, pin_hash, email_signature) VALUES
    ('${GONE}', 'former.coach@example.test', 'Former Coach', 'staff', false, 'https://example.test/a.png', 25, 'unifi-1', 'hash-1', 'Sent from my phone'),
    ('${PEER}', 'peer@example.test', 'Peer Coach', 'staff', true, NULL, 22, NULL, NULL, NULL),
    ('${MASTER}', 'master@example.test', 'Master One', 'master', true, NULL, NULL, NULL, NULL, NULL),
    ('${OLD_MASTER}', 'old.master@example.test', 'Old Master', 'master', false, NULL, NULL, NULL, NULL, NULL),
    ('${OLD_OWNER}', 'old.owner@example.test', 'Old Owner', 'owner', false, NULL, NULL, NULL, NULL, NULL);
  INSERT INTO public.profile_compensation VALUES ('${GONE}', 25);
  INSERT INTO public.profile_locations (profile_id, location_id, role) VALUES ('${GONE}', '${LOC}', 'staff'), ('${PEER}', '${LOC}', 'staff');
  INSERT INTO public.profile_organizations (profile_id) VALUES ('${GONE}');
  INSERT INTO public.device_tokens (user_id, expo_push_token) VALUES ('${GONE}', 'ExponentPushToken[x]');
  INSERT INTO public.widget_tokens (profile_id, token_hash) VALUES ('${GONE}', 'h');
  INSERT INTO public.email_mailbox_access (profile_id) VALUES ('${GONE}');
  INSERT INTO public.mobile_bar_prefs VALUES ('${GONE}', '${LOC}');
  INSERT INTO public.shift_templates VALUES ('${TPL}', 'Morning', '06:00', '07:00');
  INSERT INTO public.rosters VALUES ('${R_PUB}', 'published'), ('${R_DRAFT}', 'draft');
  INSERT INTO public.shift_blocks VALUES
    ('${B_PAST}', '${LOC}', '${TPL}', '2026-09-01', '06:00', '09:00', '${R_PUB}'),
    ('${B_PUB}', '${LOC}', '${TPL}', '2026-10-05', '06:00', '09:00', '${R_PUB}'),
    ('${B_DRAFT}', '${LOC}', '${TPL}', '2026-10-06', '06:00', '09:00', '${R_DRAFT}'),
    ('${B_YDAY}', '${LOC}', '${TPL}', '2026-09-18', '18:00', '21:00', '${R_PUB}'),
    ('${B_TODAY_AM}', '${LOC}', '${TPL}', '2026-09-19', '06:00', '09:00', '${R_PUB}'),
    ('${B_TODAY_NOW}', '${LOC}', '${TPL}', '2026-09-19', '14:00', '17:00', '${R_PUB}'),
    ('${B_TODAY_PM}', '${LOC}', '${TPL}', '2026-09-19', '18:00', '21:00', '${R_PUB}'),
    ('${B_TMRW}', '${LOC}', '${TPL}', '2026-09-20', '06:00', '09:00', '${R_PUB}');
  INSERT INTO public.shift_assignments (id, block_id, profile_id, start_time_override) VALUES
    ('${A_PAST}', '${B_PAST}', '${GONE}', NULL),
    ('${A_PUB}', '${B_PUB}', '${GONE}', '07:00'),
    ('${A_DRAFT}', '${B_DRAFT}', '${GONE}', NULL),
    ('${A_PEER}', '${B_PUB}', '${PEER}', NULL),
    ('${A_YDAY}', '${B_YDAY}', '${GONE}', NULL),
    ('${A_TODAY_AM}', '${B_TODAY_AM}', '${GONE}', NULL),
    ('${A_TODAY_NOW}', '${B_TODAY_NOW}', '${GONE}', NULL),
    ('${A_TODAY_PM}', '${B_TODAY_PM}', '${GONE}', NULL),
    ('${A_TMRW}', '${B_TMRW}', '${GONE}', NULL);
  INSERT INTO public.staff_attendance_events (profile_id, matched_assignment_id) VALUES ('${GONE}', '${A_TODAY_AM}');
  INSERT INTO public.shift_swap_requests (id, location_id, requester_shift_id, requester_id, target_shift_id, target_id, status) VALUES
    ('${S_MINE}', '${LOC}', '${A_PUB}', '${GONE}', NULL, '${PEER}', 'pending'),
    ('${S_THEIRS}', '${LOC}', '${A_PEER}', '${PEER}', NULL, '${GONE}', 'awaiting_approval'),
    ('${S_OLD}', '${LOC}', '${A_PAST}', '${GONE}', NULL, '${PEER}', 'approved');
  INSERT INTO public.time_off_requests (id, profile_id, type, start_date, end_date, total_days, status) VALUES
    ('${T_PAST}', '${GONE}', 'holiday', '2026-06-01', '2026-06-05', 5, 'approved'),
    ('${T_PENDING}', '${GONE}', 'holiday', '2026-10-12', '2026-10-16', 5, 'pending'),
    ('${T_EXPIRED}', '${GONE}', 'sick', '2026-03-02', '2026-03-02', 1, 'pending'),
    ('${T_APPROVED}', '${GONE}', 'holiday', '2026-11-02', '2026-11-03', 2, 'approved');
  INSERT INTO public.staff_allowances (profile_id, year, total_days, used_days) VALUES ('${GONE}', 2026, 20, 7);
  INSERT INTO public.schedule_notifications (profile_id, type) VALUES ('${GONE}', 'shift_published');
  INSERT INTO public.contractor_invoices VALUES ('${INV}', '${GONE}', 480);
  INSERT INTO public.audit_events (category, action, actor_id, actor_label, details) VALUES
    ('business', 'contract.issued', '${GONE}', 'Former Coach <former.coach@example.test>', '{}'),
    ('auth', 'auth.sign_in', '${GONE}', 'Former Coach <former.coach@example.test>', '{"ok": true, "email": "former.coach@example.test"}');
`

let db
// PGlite's multi-statement SQL runner (PGlite#exec — a SQL call, no shell).
const runSql = (text) => db.exec(text)
const rows = async (sql, params = []) => (await db.query(sql, params)).rows
const count = async (table, where) => Number((await rows(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n)

/** Call the function as service_role in its own tx; a raise rolls back. */
async function tombstone(id = GONE, { actor = MASTER, dryRun = false, now = NOW } = {}) {
  await runSql('BEGIN')
  try {
    await runSql('SET LOCAL ROLE service_role')
    const res = await db.query('SELECT public.tombstone_staff_profile($1, $2, $3, $4) AS summary', [id, actor, now, dryRun])
    await runSql('COMMIT')
    return res.rows[0].summary
  } catch (e) {
    await runSql('ROLLBACK')
    throw e
  }
}

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIG_622)
  await runSql(MASTER_GUARD)
  await runSql('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role')
}, 60_000)

beforeEach(async () => {
  await runSql('DROP TRIGGER IF EXISTS fail_strip ON public.profiles')
  await runSql('TRUNCATE auth.users, public.locations, public.shift_templates, public.rosters, public.audit_events, public.roster_change_log CASCADE')
  await runSql(SEED)
})

afterAll(async () => { await db?.close() })

describe('mig 622 — why the auth user is never deleted', () => {
  it('deleting auth.users cascades through profiles and takes the history with it', async () => {
    // The NO ACTION swap FKs would refuse the delete outright — the old route
    // nulled such columns first, which is what opened the door to the cascade.
    await runSql('DELETE FROM public.shift_swap_requests')
    await runSql(`DELETE FROM auth.users WHERE id = '${GONE}'`)
    expect(await count('public.contractor_invoices', `id = '${INV}'`)).toBe(0)
    expect(await count('public.shift_assignments', `id = '${A_PAST}'`)).toBe(0)
    expect(await count('public.time_off_requests', `id = '${T_PAST}'`)).toBe(0)
  })
})

describe('mig 622 — tombstone_staff_profile', () => {
  it('dry run reports what would happen and writes nothing', async () => {
    const s = await tombstone(GONE, { dryRun: true })
    expect(s.dry_run).toBe(true)
    expect(s.removed_shifts.map((x) => x.assignment_id)).toEqual([A_TODAY_PM, A_TMRW, A_PUB, A_DRAFT])
    expect(s.kept_today_shifts.map((x) => x.assignment_id)).toEqual([A_TODAY_AM, A_TODAY_NOW])
    expect(s.role).toEqual({ from: 'staff', to: 'staff' })
    expect(s.removed_shifts[2]).toMatchObject({ block_date: '2026-10-05', start_time: '07:00:00', end_time: '09:00:00', template_name: 'Morning', location_name: 'Studio One', roster_status: 'published' })
    expect(s.cancelled_swaps.map((x) => x.id).sort()).toEqual([S_MINE, S_THEIRS])
    expect(s.cancelled_time_off.map((x) => x.id)).toEqual([T_PENDING])
    // past = everything that has STARTED: 1 Sep, yesterday, today 06:00, today 14:00.
    expect(s.kept).toMatchObject({ past_shifts: 4, time_off_requests: 4, staff_allowances: 1, contractor_invoices: 1 })
    expect(await count('public.shift_assignments', `profile_id = '${GONE}'`)).toBe(8)
    expect((await rows(`SELECT deleted_at, email FROM public.profiles WHERE id = '${GONE}'`))[0]).toEqual({ deleted_at: null, email: 'former.coach@example.test' })
  })

  it('removes NOT-STARTED shifts only (published and draft); started shifts and other people are untouched', async () => {
    await tombstone()
    expect((await rows('SELECT id FROM public.shift_assignments ORDER BY id')).map((r) => r.id))
      .toEqual([A_PAST, A_PEER, A_YDAY, A_TODAY_AM, A_TODAY_NOW])
  })

  // "Upcoming" = NOT STARTED on the Dublin wall clock. NOW is 14:00 Dublin.
  describe('a shift that has started is HISTORY', () => {
    const has = async (id) => (await count('public.shift_assignments', `id = '${id}'`)) === 1
    it('06:00-09:00 today, deleted at 14:00 → kept, and its attendance stays linked', async () => {
      await tombstone()
      expect(await has(A_TODAY_AM)).toBe(true)
      expect(await count('public.staff_attendance_events', `matched_assignment_id = '${A_TODAY_AM}'`)).toBe(1)
    })
    it('18:00 today, deleted at 14:00 → removed, with a change-log row', async () => {
      await tombstone()
      expect(await has(A_TODAY_PM)).toBe(false)
      expect(await count('public.roster_change_log', `block_id = '${B_TODAY_PM}' AND action = 'unassigned' AND coach_id = '${GONE}'`)).toBe(1)
    })
    it('a shift starting EXACTLY at now has started → kept; one second earlier it had not', async () => {
      await tombstone()
      expect(await has(A_TODAY_NOW)).toBe(true)
      expect(await count('public.roster_change_log', `block_id = '${B_TODAY_NOW}'`)).toBe(0)
    })
    it('…one second before its start it is still upcoming → removed', async () => {
      await tombstone(GONE, { now: '2026-09-19T12:59:59Z' })
      expect(await has(A_TODAY_NOW)).toBe(false)
    })
    it('tomorrow → removed; yesterday → kept', async () => {
      await tombstone()
      expect(await has(A_TMRW)).toBe(false)
      expect(await has(A_YDAY)).toBe(true)
    })
    it('the assignment override beats the block time, in both directions', async () => {
      // (A_TODAY_AM is not used here: the seed matched an attendance event to it, which keeps it regardless.)
      await runSql(`UPDATE public.shift_assignments SET start_time_override = '15:00' WHERE id = '${A_TODAY_NOW}';  -- block 14:00, really starts 15:00
                    UPDATE public.shift_assignments SET start_time_override = '13:00' WHERE id = '${A_TODAY_PM}';`) // block 18:00, really started 13:00
      const s = await tombstone()
      expect(await has(A_TODAY_NOW)).toBe(false)
      expect(await has(A_TODAY_PM)).toBe(true)
      expect(s.kept_today_shifts.map((x) => x.assignment_id)).toEqual([A_TODAY_AM, A_TODAY_PM])
    })
    // An arrival can be matched up to 45 min BEFORE the start
    // (GEOFENCE_EARLY_WINDOW_MS, src/lib/staff-attendance.js). A shift someone
    // has already turned up for is history even if the clock says "not started".
    it('not started, but arrived_at is set → kept, reason "arrived", no change-log row', async () => {
      await runSql(`UPDATE public.shift_assignments SET arrived_at = '2026-09-19T12:50:00Z' WHERE id = '${A_TODAY_PM}'`)
      const s = await tombstone()
      expect(await has(A_TODAY_PM)).toBe(true)
      expect(s.removed_shifts.map((x) => x.assignment_id)).not.toContain(A_TODAY_PM)
      expect(s.kept_today_shifts.map((x) => [x.assignment_id, x.reason])).toEqual([[A_TODAY_AM, 'started'], [A_TODAY_NOW, 'started'], [A_TODAY_PM, 'arrived']])
      expect(await count('public.roster_change_log', `block_id = '${B_TODAY_PM}'`)).toBe(0)
      expect(s.kept.past_shifts).toBe(5)
    })
    it('not started, but an attendance event is matched to it → kept, and the event stays linked', async () => {
      await runSql(`INSERT INTO public.staff_attendance_events (profile_id, matched_assignment_id) VALUES ('${GONE}', '${A_TMRW}')`)
      const s = await tombstone()
      expect(await has(A_TMRW)).toBe(true)
      expect(await count('public.staff_attendance_events', `matched_assignment_id = '${A_TMRW}'`)).toBe(1)
      expect(s.kept_today_shifts.find((x) => x.assignment_id === A_TMRW)).toMatchObject({ reason: 'arrived', block_date: '2026-09-20' })
    })
    it('NO attendance event is ever unlinked by a permanent delete', async () => {
      await runSql(`UPDATE public.shift_assignments SET arrived_at = '2026-09-19T12:50:00Z' WHERE id = '${A_TODAY_PM}';
                    INSERT INTO public.staff_attendance_events (profile_id, matched_assignment_id) VALUES ('${GONE}', '${A_TMRW}'), ('${GONE}', '${A_YDAY}')`)
      const before = await count('public.staff_attendance_events', 'matched_assignment_id IS NOT NULL')
      await tombstone()
      expect(await count('public.staff_attendance_events', 'matched_assignment_id IS NOT NULL')).toBe(before)
    })
    it('"today" is the DUBLIN date: 23:30 UTC on the 19th is already the 20th in Dublin', async () => {
      const s = await tombstone(GONE, { dryRun: true, now: '2026-09-19T23:30:00Z' }) // 00:30 IST, 20 Sep
      expect(s.removed_shifts.map((x) => x.assignment_id)).toEqual([A_TMRW, A_PUB, A_DRAFT]) // the 20th at 06:00 has not started
      expect(s.kept_today_shifts).toEqual([])                                                   // the 19th is yesterday now
      expect(s.kept.past_shifts).toBe(5)
    })
    it('DST: the same UTC instant is a different Dublin time on either side of the clock change', async () => {
      // Clocks go back on Sun 25 Oct 2026. 05:30Z is 06:30 IST the day before
      // (a 06:00 shift HAS started) but 05:30 GMT on the day (it has NOT).
      await runSql(`UPDATE public.shift_blocks SET block_date = '2026-10-24' WHERE id = '${B_TODAY_AM}';
                    UPDATE public.shift_blocks SET block_date = '2026-10-25' WHERE id = '${B_TMRW}';`)
      const before = await tombstone(GONE, { dryRun: true, now: '2026-10-24T05:30:00Z' })
      expect(before.kept_today_shifts.map((x) => x.assignment_id)).toEqual([A_TODAY_AM])
      expect(before.removed_shifts.map((x) => x.assignment_id)).toEqual([A_TMRW])
      const onTheDay = await tombstone(GONE, { dryRun: true, now: '2026-10-25T05:30:00Z' })
      expect(onTheDay.removed_shifts.map((x) => x.assignment_id)).toEqual([A_TMRW])
      expect(onTheDay.kept_today_shifts).toEqual([])
      // …and exactly at 06:00 GMT on the day it has started.
      const atStart = await tombstone(GONE, { dryRun: true, now: '2026-10-25T06:00:00Z' })
      expect(atStart.removed_shifts).toEqual([])
      expect(atStart.kept_today_shifts.map((x) => x.assignment_id)).toEqual([A_TMRW])
    })
  })

  // RLS reads profiles.role LIVE (private.auth_is_master(), inline policies),
  // so a tombstone must not keep an elevated role — but history must.
  describe('the role is demoted to the floor, and remembered', () => {
    for (const [id, was] of [[OLD_MASTER, 'master'], [OLD_OWNER, 'owner']]) {
      it(`a deleted ${was}: role = 'staff', deleted_role = '${was}'`, async () => {
        const s = await tombstone(id)
        expect(s.role).toEqual({ from: was, to: 'staff' })
        expect((await rows(`SELECT role, deleted_role FROM public.profiles WHERE id = '${id}'`))[0]).toEqual({ role: 'staff', deleted_role: was })
        // What private.auth_is_master() asks (mig 051:201): is there a profiles row for this uid with role = 'master'?
        expect(await count('public.profiles', `id = '${id}' AND role IN ('master', 'owner', 'manager', 'head_coach')`)).toBe(0)
      })
    }
    it('the dry run REPORTS the demotion and changes nothing', async () => {
      const s = await tombstone(OLD_MASTER, { dryRun: true })
      expect(s.role).toEqual({ from: 'master', to: 'staff' })
      expect((await rows(`SELECT role, deleted_role, deleted_at FROM public.profiles WHERE id = '${OLD_MASTER}'`))[0]).toEqual({ role: 'master', deleted_role: null, deleted_at: null })
    })
    it('the database refuses to re-promote a tombstone, or to forget its role', async () => {
      await tombstone(OLD_MASTER)
      await expect(runSql(`UPDATE public.profiles SET role = 'master' WHERE id = '${OLD_MASTER}'`)).rejects.toThrow(/staff_tombstone_frozen/)
      await expect(runSql(`UPDATE public.profiles SET deleted_role = NULL WHERE id = '${OLD_MASTER}'`)).rejects.toThrow(/staff_tombstone_frozen/)
    })
  })

  // Whatever route forgets to ask, the DATABASE refuses to hand a tombstone a
  // studio role or an organisation-admin grant (RLS reads both tables live).
  describe('a tombstone cannot be re-granted access — refused by the database', () => {
    it('profile_locations: INSERT and UPDATE-onto-a-tombstone are refused; a living profile is unaffected', async () => {
      await tombstone()
      await expect(runSql(`INSERT INTO public.profile_locations (profile_id, location_id, role) VALUES ('${GONE}', '${LOC}', 'owner')`))
        .rejects.toThrow(/staff_tombstone_access/)
      await expect(runSql(`UPDATE public.profile_locations SET profile_id = '${GONE}' WHERE profile_id = '${PEER}'`))
        .rejects.toThrow(/staff_tombstone_access/)
      expect(await count('public.profile_locations', `profile_id = '${GONE}'`)).toBe(0)
      await runSql(`UPDATE public.profile_locations SET role = 'head_coach' WHERE profile_id = '${PEER}'`)
      await runSql(`INSERT INTO public.profile_locations (profile_id, location_id, role) VALUES ('${MASTER}', '${LOC}', 'owner')`)
      expect(await count('public.profile_locations', `profile_id IN ('${PEER}', '${MASTER}')`)).toBe(2)
    })
    it('profile_organizations: INSERT and UPDATE-onto-a-tombstone are refused; a living profile is unaffected', async () => {
      await tombstone()
      await expect(runSql(`INSERT INTO public.profile_organizations (profile_id) VALUES ('${GONE}')`)).rejects.toThrow(/staff_tombstone_access/)
      await runSql(`INSERT INTO public.profile_organizations (profile_id) VALUES ('${PEER}')`)
      await expect(runSql(`UPDATE public.profile_organizations SET profile_id = '${GONE}' WHERE profile_id = '${PEER}'`)).rejects.toThrow(/staff_tombstone_access/)
      expect(await count('public.profile_organizations', `profile_id = '${GONE}'`)).toBe(0)
      expect(await count('public.profile_organizations', `profile_id = '${PEER}'`)).toBe(1)
    })
    it('the guard works for a role with NO read access to profiles (mig 153b revoked SELECT from authenticated)', async () => {
      await tombstone()
      await runSql(`GRANT INSERT ON public.profile_organizations TO authenticated`)
      await runSql('BEGIN'); await runSql('SET LOCAL ROLE authenticated')
      try {
        await expect(runSql(`INSERT INTO public.profile_organizations (profile_id) VALUES ('${GONE}')`)).rejects.toThrow(/staff_tombstone_access/)
      } finally { await runSql('ROLLBACK') }
      await runSql('BEGIN'); await runSql('SET LOCAL ROLE authenticated')
      try { await runSql(`INSERT INTO public.profile_organizations (profile_id) VALUES ('${PEER}')`) } finally { await runSql('ROLLBACK') }
    })
  })

  describe('the REAL last-master guard (mig 080) still holds', () => {
    it('the last ACTIVE master cannot be tombstoned: still active → refused; deactivating them → refused by the guard', async () => {
      await expect(tombstone(MASTER, { actor: PEER })).rejects.toThrow(/staff_still_active/)
      await expect(runSql(`UPDATE public.profiles SET active = false WHERE id = '${MASTER}'`)).rejects.toThrow(/last active master/)
      expect((await rows(`SELECT role, active, deleted_at FROM public.profiles WHERE id = '${MASTER}'`))[0]).toEqual({ role: 'master', active: true, deleted_at: null })
    })
    it('an INACTIVE master is tombstoned while another active master remains', async () => {
      await tombstone(OLD_MASTER)
      expect(await count('public.profiles', `role = 'master' AND active = true`)).toBe(1)
    })
    it('with NO active master left, the guard refuses the demotion and the whole delete rolls back', async () => {
      // Not reachable through the app (the actor is an active master); pinned so
      // a guard refusal can never leave a half-deleted person behind.
      await runSql(`ALTER TABLE public.profiles DISABLE TRIGGER guard_at_least_one_master;
                    UPDATE public.profiles SET active = false WHERE id = '${MASTER}';
                    ALTER TABLE public.profiles ENABLE TRIGGER guard_at_least_one_master;
                    INSERT INTO public.profile_locations (profile_id, location_id, role) VALUES ('${OLD_MASTER}', '${LOC}', 'owner');`)
      await expect(tombstone(OLD_MASTER, { actor: PEER })).rejects.toThrow(/last active master/)
      expect((await rows(`SELECT role, deleted_at FROM public.profiles WHERE id = '${OLD_MASTER}'`))[0]).toEqual({ role: 'master', deleted_at: null })
      expect(await count('public.profile_locations', `profile_id = '${OLD_MASTER}'`)).toBe(1)
    })
  })

  it('logs one roster change per PUBLISHED removal, already stamped notified', async () => {
    await tombstone()
    const log = await rows('SELECT block_id, block_date::text AS block_date, actor_id, coach_id, action, details, notified_at FROM public.roster_change_log ORDER BY block_date DESC')
    expect(log.map((r) => r.block_id)).toEqual([B_PUB, B_TMRW, B_TODAY_PM]) // not the draft, not a started shift
    expect(log.every((r) => r.notified_at !== null)).toBe(true)
    expect(log[0]).toMatchObject({ block_id: B_PUB, block_date: '2026-10-05', actor_id: MASTER, coach_id: GONE, action: 'unassigned', details: { reason: 'staff_permanent_delete' } })
    expect(log[0].notified_at).not.toBeNull()
  })

  it('cancels open swaps on either side; decided swaps are history', async () => {
    await tombstone()
    const swaps = Object.fromEntries((await rows('SELECT id, status, reviewed_by, review_note, requester_shift_id FROM public.shift_swap_requests')).map((r) => [r.id, r]))
    expect(swaps[S_MINE]).toMatchObject({ status: 'cancelled', reviewed_by: MASTER, requester_shift_id: null })
    expect(swaps[S_MINE].review_note).toContain('permanently deleted')
    expect(swaps[S_THEIRS]).toMatchObject({ status: 'cancelled', requester_shift_id: A_PEER })
    expect(swaps[S_OLD]).toMatchObject({ status: 'approved', reviewed_by: null, review_note: null })
  })

  it('cancels pending leave that is still ahead; expired-pending and decided leave are history', async () => {
    await tombstone()
    const leave = Object.fromEntries((await rows('SELECT id, status FROM public.time_off_requests')).map((r) => [r.id, r.status]))
    expect(leave).toEqual({ [T_PAST]: 'approved', [T_PENDING]: 'cancelled', [T_EXPIRED]: 'pending', [T_APPROVED]: 'approved' })
    expect((await rows(`SELECT used_days::int AS used FROM public.staff_allowances WHERE profile_id = '${GONE}'`))[0].used).toBe(7)
  })

  it('HISTORY STAYS, BY NAME — every cascading table still has its row and still joins to the name', async () => {
    const before = (await tombstone(GONE, { dryRun: true })).kept
    const after = (await tombstone()).kept
    expect(after).toEqual(before)
    const named = await rows(`
      SELECT 'invoice' AS what, p.full_name FROM public.contractor_invoices i JOIN public.profiles p ON p.id = i.contractor_id
      UNION ALL SELECT 'shift', p.full_name FROM public.shift_assignments a JOIN public.profiles p ON p.id = a.profile_id WHERE a.id = '${A_PAST}'
      UNION ALL SELECT 'leave', p.full_name FROM public.time_off_requests t JOIN public.profiles p ON p.id = t.profile_id WHERE t.id = '${T_PAST}'
      UNION ALL SELECT 'allowance', p.full_name FROM public.staff_allowances s JOIN public.profiles p ON p.id = s.profile_id
      UNION ALL SELECT 'notification', p.full_name FROM public.schedule_notifications n JOIN public.profiles p ON p.id = n.profile_id
      UNION ALL SELECT 'pay', p.full_name FROM public.profile_compensation c JOIN public.profiles p ON p.id = c.profile_id`)
    expect(named.map((r) => r.what).sort()).toEqual(['allowance', 'invoice', 'leave', 'notification', 'pay', 'shift'])
    expect(new Set(named.map((r) => r.full_name))).toEqual(new Set(['Former Coach']))
  })

  it('strips PII and credentials, keeps name / employment / pay, remembers the role, stamps who and when', async () => {
    await tombstone()
    const p = (await rows(`SELECT * FROM public.profiles WHERE id = '${GONE}'`))[0]
    expect(p).toMatchObject({
      email: `deleted+${GONE}@deleted.invalid`, full_name: 'Former Coach', role: 'staff', deleted_role: 'staff', employment_type: 'fte',
      active: false, avatar_url: null, pin_hash: null, unifi_user_id: null, unifi_door_access: false,
      email_signature: null, email_signature_rich: null, permissions: {}, deleted_by: MASTER,
    })
    expect(Number(p.hourly_rate)).toBe(25)
    expect(p.deleted_at).not.toBeNull()
  })

  it('deletes every access row and token — so no location-scoped list can contain a tombstone', async () => {
    const s = await tombstone()
    for (const [table, col] of [['profile_locations', 'profile_id'], ['profile_organizations', 'profile_id'], ['device_tokens', 'user_id'], ['widget_tokens', 'profile_id'], ['email_mailbox_access', 'profile_id'], ['mobile_bar_prefs', 'profile_id']]) {
      expect(await count(`public.${table}`, `${col} = '${GONE}'`)).toBe(0)
    }
    expect(s.deleted).toEqual({ profile_locations: 1, profile_organizations: 1, device_tokens: 1, widget_tokens: 1, email_mailbox_access: 1, mobile_bar_prefs: 1 })
    expect(await count('public.profile_locations', `profile_id = '${PEER}'`)).toBe(1)
  })

  it('redacts what the audit trigger re-saved, and the email in older audit rows', async () => {
    await tombstone()
    const all = JSON.stringify(await rows('SELECT actor_label, target_label, details FROM public.audit_events'))
    expect(all).not.toContain('former.coach@example.test')
    expect(all).not.toContain('hash-1')
    expect(await count('public.audit_events', `actor_id = '${GONE}' AND actor_label = 'Former Coach'`)).toBe(2)
    expect(await count('public.audit_events', `category = 'mutation' AND details = '{"redacted": "staff_permanent_delete"}'::jsonb`)).toBe(1)
  })

  it('refuses an active profile, a missing profile and a self-delete', async () => {
    await expect(tombstone(PEER)).rejects.toThrow(/staff_still_active/)
    await expect(tombstone('10000000-0000-0000-0000-0000000000ff')).rejects.toThrow(/staff_not_found/)
    await expect(tombstone(MASTER, { actor: MASTER })).rejects.toThrow(/staff_self_delete/)
  })

  it('is atomic — a failure at the strip rolls the shift removals back', async () => {
    await runSql(`
      CREATE OR REPLACE FUNCTION public.fail_strip_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'strip failed'; END $fn$;
      CREATE TRIGGER fail_strip BEFORE UPDATE ON public.profiles
        FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION public.fail_strip_fn();`)
    await expect(tombstone()).rejects.toThrow(/strip failed/)
    expect(await count('public.shift_assignments', `profile_id = '${GONE}'`)).toBe(8)
    expect(await count('public.profile_locations', `profile_id = '${GONE}'`)).toBe(1)
  })

  it('the database refuses to reactivate a tombstone', async () => {
    await tombstone()
    await expect(runSql(`UPDATE public.profiles SET active = true WHERE id = '${GONE}'`)).rejects.toThrow(/staff_tombstone_frozen/)
  })

  // The CHECK alone passes `SET deleted_at = NULL, deleted_role = NULL, active =
  // true` — every row with deleted_at NULL satisfies it. A tombstone is FROZEN:
  // once deleted_at is set, the columns that make it one can never change.
  describe('a tombstone cannot be un-tombstoned', () => {
    it('refuses the un-delete that the CHECK would have let through', async () => {
      await tombstone()
      await expect(runSql(`UPDATE public.profiles SET deleted_at = NULL, deleted_role = NULL, active = true WHERE id = '${GONE}'`))
        .rejects.toThrow(/staff_tombstone_frozen/)
      expect((await rows(`SELECT active, deleted_at IS NOT NULL AS dead FROM public.profiles WHERE id = '${GONE}'`))[0]).toEqual({ active: false, dead: true })
    })
    for (const [col, sql] of [
      ['deleted_at', `deleted_at = now() + interval '1 day'`], ['deleted_by', `deleted_by = '${PEER}'`], ['deleted_role', `deleted_role = 'owner'`],
      ['role', `role = 'owner'`], ['active', 'active = true'], ['email', `email = 'back@example.test'`], ['permissions', `permissions = '{"settings": true}'::jsonb`],
    ]) {
      it(`refuses a change to ${col}`, async () => {
        await tombstone()
        await expect(runSql(`UPDATE public.profiles SET ${sql} WHERE id = '${GONE}'`)).rejects.toThrow(new RegExp(`staff_tombstone_frozen.*${col}`))
      })
    }
    it('the CHECK is still the second lock when the trigger is out of the way', async () => {
      await tombstone()
      await runSql('ALTER TABLE public.profiles DISABLE TRIGGER profiles_tombstone_frozen')
      try {
        await expect(runSql(`UPDATE public.profiles SET active = true WHERE id = '${GONE}'`)).rejects.toThrow(/profiles_tombstone_is_inactive/)
      } finally { await runSql('ALTER TABLE public.profiles ENABLE TRIGGER profiles_tombstone_frozen') }
    })
    it('an unrelated column can still be written, and a LIVING profile is untouched by the freeze', async () => {
      await tombstone()
      await runSql(`UPDATE public.profiles SET updated_at = now(), avatar_url = NULL WHERE id = '${GONE}'`)
      await runSql(`UPDATE public.profiles SET role = 'manager', email = 'peer2@example.test', permissions = '{}'::jsonb WHERE id = '${PEER}'`)
      expect((await rows(`SELECT role FROM public.profiles WHERE id = '${PEER}'`))[0].role).toBe('manager')
    })
    it('a second call is SAFE: it says already tombstoned and changes nothing', async () => {
      await tombstone()
      const snap = async () => JSON.stringify([
        await rows(`SELECT * FROM public.profiles WHERE id = '${GONE}'`),
        await rows('SELECT id FROM public.shift_assignments ORDER BY id'),
        await rows('SELECT id, status, review_note FROM public.shift_swap_requests ORDER BY id'),
        await rows('SELECT id, status FROM public.time_off_requests ORDER BY id'),
        await count('public.roster_change_log', 'true'), await count('public.audit_events', 'true'),
      ])
      const before = await snap()
      for (const dryRun of [true, false]) {
        const again = await tombstone(GONE, { dryRun, now: '2026-12-01T09:00:00Z' })
        expect(again).toMatchObject({ profile_id: GONE, full_name: 'Former Coach', already_tombstoned: true, removed_shifts: [], cancelled_swaps: [], cancelled_time_off: [], role: { from: 'staff', to: 'staff' } })
        expect(again.deleted_at).toBeTruthy()
      }
      expect(await snap()).toBe(before)
    })
  })

  it('EXECUTE is service_role only', async () => {
    const sig = 'public.tombstone_staff_profile(uuid, uuid, timestamptz, boolean)'
    const p = (await rows(`SELECT has_function_privilege('service_role', '${sig}', 'EXECUTE') AS svc, has_function_privilege('authenticated', '${sig}', 'EXECUTE') AS auth, has_function_privilege('anon', '${sig}', 'EXECUTE') AS anon`))[0]
    expect(p).toEqual({ svc: true, auth: false, anon: false })
  })
})
