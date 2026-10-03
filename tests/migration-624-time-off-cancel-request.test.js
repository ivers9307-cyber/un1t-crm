// LEAVECANCEL.1 — behavioural test for migration 624.
//
// WHY THIS FILE EXISTS
// ────────────────────
// Same reason as the 614/618/622 replays: no local Supabase stack, so DDL
// otherwise gets its first execution on prod. This boots an in-process
// Postgres (PGlite), recreates time_off_requests + staff_allowances as mig 011
// made them, installs the REAL mig 616 file (the allowance trigger's current
// body) and the mig 600 policies, applies the real 624 file verbatim, and
// asserts what its header claims:
//
//   * an OPEN ask leaves status='approved' and does not move the allowance;
//   * approving it (status -> cancelled in the same UPDATE) REFUNDS the days
//     through the mig 011/616 trigger, and rejecting it refunds nothing;
//   * the CHECKs refuse every self-contradicting row and nothing else;
//   * before 624 a manager's browser could cancel their own approved leave and
//     could have forged the decision columns; after it, UPDATE is refused
//     while SELECT (new columns included) still works.
//
// The DDL here is the minimum those pieces touch, not the full schema. The
// prod state is NOT read by this test: grants and the live trigger body are
// "verify on prod" items in the migration's pre-apply checks.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const read = (name) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', name), 'utf8')
const MIG_616 = read('616_time_off_created_by_allowance_seed.sql')
const MIG_624 = read('624_time_off_cancel_request.sql')

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const MANAGER = '10000000-0000-0000-0000-000000000001' // manager at LOC, the requester
const OWNER = '10000000-0000-0000-0000-000000000002'   // owner at LOC, the decider
const COACH = '10000000-0000-0000-0000-000000000003'   // staff at LOC

const LEAVE = '20000000-0000-0000-0000-000000000001'       // MANAGER's approved 3-day holiday
const COACH_LEAVE = '20000000-0000-0000-0000-000000000002' // COACH's approved holiday

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, private, public TO authenticated, anon, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, full_name text, employment_type text);
  CREATE TABLE public.profile_locations (
    profile_id uuid REFERENCES public.profiles(id), location_id uuid REFERENCES public.locations(id),
    role text NOT NULL, PRIMARY KEY (profile_id, location_id)
  );
  CREATE TABLE public.profile_compensation (profile_id uuid PRIMARY KEY REFERENCES public.profiles(id), annual_leave_entitlement numeric);

  -- mig 011, with mig 283's widened type CHECK.
  CREATE TABLE public.staff_allowances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    year int NOT NULL,
    total_days numeric(5,1) NOT NULL DEFAULT 20,
    used_days numeric(5,1) NOT NULL DEFAULT 0,
    carried_over numeric(5,1) NOT NULL DEFAULT 0,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    UNIQUE (profile_id, year)
  );
  CREATE TABLE public.time_off_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    type text NOT NULL CHECK (type = ANY (ARRAY['holiday','sick','unpaid','other','unavailable'])),
    start_date date NOT NULL, end_date date NOT NULL,
    total_days numeric(5,1) NOT NULL DEFAULT 1,
    reason text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
    reviewed_by uuid REFERENCES public.profiles(id), reviewed_at timestamptz, review_note text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    CONSTRAINT valid_date_range CHECK (end_date >= start_date)
  );
  CREATE FUNCTION public.update_holiday_allowance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  CREATE TRIGGER trg_update_holiday_allowance AFTER UPDATE ON public.time_off_requests
    FOR EACH ROW EXECUTE FUNCTION public.update_holiday_allowance();

  -- Supabase's default: table-level DML to the client role, everything to service_role.
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role = 'master')
  $$;
  CREATE FUNCTION private.auth_is_manager_at(p_location_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.profile_locations pl WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = p_location_id AND pl.role IN ('owner','manager','head_coach'))
  $$;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;

  ALTER TABLE public.time_off_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.staff_allowances ENABLE ROW LEVEL SECURITY;

  -- mig 600, verbatim.
  CREATE POLICY "time_off_requests_select" ON public.time_off_requests FOR SELECT TO authenticated
    USING (profile_id = (SELECT auth.uid()) OR private.auth_is_manager_at(location_id));
  CREATE POLICY "time_off_requests_update" ON public.time_off_requests FOR UPDATE TO authenticated
    USING (private.auth_is_manager_at(location_id) OR (profile_id = (SELECT auth.uid()) AND status = 'pending'::text))
    WITH CHECK (private.auth_is_manager_at(location_id) OR status = 'cancelled'::text);
  -- Enough of staff_allowances' policies for the SECURITY INVOKER trigger to
  -- run on the browser path in the "before" proof.
  CREATE POLICY "staff_allowances_all" ON public.staff_allowances FOR ALL TO authenticated USING (true) WITH CHECK (true);
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}');
  INSERT INTO public.profiles (id, role, full_name, employment_type) VALUES
    ('${MANAGER}', 'manager', 'Manager', 'fte'), ('${OWNER}', 'owner', 'Owner', 'fte'), ('${COACH}', 'staff', 'Coach', 'fte');
  INSERT INTO public.profile_locations VALUES
    ('${MANAGER}', '${LOC}', 'manager'), ('${OWNER}', '${LOC}', 'owner'), ('${COACH}', '${LOC}', 'staff');
  INSERT INTO public.staff_allowances (profile_id, year, total_days, used_days) VALUES
    ('${MANAGER}', 2026, 20, 3), ('${COACH}', 2026, 20, 2);
  INSERT INTO public.time_off_requests (id, profile_id, location_id, type, start_date, end_date, total_days, status, reviewed_by, reviewed_at) VALUES
    ('${LEAVE}', '${MANAGER}', '${LOC}', 'holiday', '2026-10-05', '2026-10-07', 3, 'approved', '${OWNER}', now()),
    ('${COACH_LEAVE}', '${COACH}', '${LOC}', 'holiday', '2026-10-12', '2026-10-13', 2, 'approved', '${OWNER}', now());
`

let db

// PGlite's multi-statement SQL runner (PGlite#exec: a SQL call into the
// in-process Postgres, no shell and no child process), as in the 618 replay.
const runSql = (text) => db.exec(text)

/** Run `sql` as an authenticated JWT for `uid` inside a rolled-back tx; returns rows. */
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

/** Run as the table owner (what service_role amounts to here) inside a rolled-back tx. */
async function rolledBack(fn) {
  await runSql('BEGIN')
  try { return await fn() } finally { await runSql('ROLLBACK') }
}

const usedDays = async (profileId) =>
  Number((await db.query(`SELECT used_days FROM public.staff_allowances WHERE profile_id = $1 AND year = 2026`, [profileId])).rows[0].used_days)
const leaveRow = async (id = LEAVE) => (await db.query(`SELECT * FROM public.time_off_requests WHERE id = $1`, [id])).rows[0]

const ASK = `cancel_requested_at = now(), cancel_requested_by = '${MANAGER}', cancel_request_note = 'Plans changed'`
const DECIDED = (decision) => `cancel_decided_at = now(), cancel_decided_by = '${OWNER}', cancel_decision = '${decision}'`

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIG_616) // the real allowance trigger body, as prod should hold it
  await runSql(SEED)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('before 624 — the browser door is real (guards against a vacuous pass)', () => {
  it('a manager\'s own JWT cancels their own APPROVED leave', async () => {
    const rows = await asUser(MANAGER, `UPDATE public.time_off_requests SET status = 'cancelled' WHERE id = '${LEAVE}' RETURNING status`)
    expect(rows).toEqual([{ status: 'cancelled' }])
    // Rolled back by asUser: the seed is intact for everything below.
    expect((await leaveRow()).status).toBe('approved')
  })
})

describe('after 624', () => {
  beforeAll(async () => { await runSql(MIG_624) }, 60_000)

  it('adds the seven columns, all NULL on existing rows', async () => {
    const { rows } = await db.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='time_off_requests' AND column_name LIKE 'cancel\\_%' ORDER BY 1`)
    expect(rows.map((r) => r.column_name)).toEqual([
      'cancel_decided_at', 'cancel_decided_by', 'cancel_decision', 'cancel_decision_note',
      'cancel_request_note', 'cancel_requested_at', 'cancel_requested_by',
    ])
    const row = await leaveRow()
    expect([row.cancel_requested_at, row.cancel_requested_by, row.cancel_decided_at, row.cancel_decision]).toEqual([null, null, null, null])
  })

  it('names its constraints as the migration header says, and neither FK cascades', async () => {
    const { rows } = await db.query(`
      SELECT conname, contype, confdeltype FROM pg_constraint
       WHERE conrelid = 'public.time_off_requests'::regclass AND conname LIKE 'time_off_requests_cancel%' ORDER BY 1`)
    expect(rows.map((r) => r.conname)).toEqual([
      'time_off_requests_cancel_approved_is_cancelled',
      'time_off_requests_cancel_ask_pair',
      'time_off_requests_cancel_decided_by_fkey',
      'time_off_requests_cancel_decision_check',
      'time_off_requests_cancel_decision_needs_ask',
      'time_off_requests_cancel_decision_trio',
      'time_off_requests_cancel_requested_by_fkey',
    ])
    // a = NO ACTION, like reviewed_by. Never c (CASCADE).
    expect(rows.filter((r) => r.contype === 'f').map((r) => r.confdeltype)).toEqual(['a', 'a'])
  })

  it('an OPEN ask leaves the leave approved and the allowance untouched', async () => {
    await rolledBack(async () => {
      await runSql(`UPDATE public.time_off_requests SET ${ASK} WHERE id = '${LEAVE}'`)
      const row = await leaveRow()
      expect(row.status).toBe('approved')
      expect(row.cancel_requested_by).toBe(MANAGER)
      expect(row.cancel_decided_at).toBeNull()
      expect(await usedDays(MANAGER)).toBe(3)
    })
  })

  it('approving the ask (status -> cancelled in the SAME update) refunds the days through the mig 616 trigger', async () => {
    await rolledBack(async () => {
      await runSql(`UPDATE public.time_off_requests SET ${ASK} WHERE id = '${LEAVE}'`)
      await runSql(`UPDATE public.time_off_requests SET status = 'cancelled', ${DECIDED('approved')} WHERE id = '${LEAVE}' AND status = 'approved'`)
      expect((await leaveRow()).status).toBe('cancelled')
      expect(await usedDays(MANAGER)).toBe(0)
      // A second, identical decision matches nothing (the route's zero-row race guard).
      const again = await db.query(`UPDATE public.time_off_requests SET status = 'cancelled' WHERE id = '${LEAVE}' AND status = 'approved' AND cancel_decided_at IS NULL RETURNING id`)
      expect(again.rows).toHaveLength(0)
      expect(await usedDays(MANAGER)).toBe(0)
    })
  })

  it('rejecting the ask keeps the leave approved and refunds nothing; the person may ask again', async () => {
    await rolledBack(async () => {
      await runSql(`UPDATE public.time_off_requests SET ${ASK} WHERE id = '${LEAVE}'`)
      await runSql(`UPDATE public.time_off_requests SET ${DECIDED('rejected')} WHERE id = '${LEAVE}'`)
      expect((await leaveRow()).status).toBe('approved')
      expect(await usedDays(MANAGER)).toBe(3)
      await runSql(`UPDATE public.time_off_requests SET cancel_requested_at = now(), cancel_decided_at = NULL, cancel_decided_by = NULL, cancel_decision = NULL, cancel_decision_note = NULL WHERE id = '${LEAVE}'`)
      expect((await leaveRow()).cancel_decision).toBeNull()
    })
  })

  it('withdrawing (all seven back to NULL) is a legal row', async () => {
    await rolledBack(async () => {
      await runSql(`UPDATE public.time_off_requests SET ${ASK} WHERE id = '${LEAVE}'`)
      await runSql(`UPDATE public.time_off_requests SET cancel_requested_at = NULL, cancel_requested_by = NULL, cancel_request_note = NULL WHERE id = '${LEAVE}'`)
      expect((await leaveRow()).cancel_requested_at).toBeNull()
    })
  })

  it('a colleague cancelling the leave outright while an ask is open is NOT a constraint error (the ask is simply moot)', async () => {
    await rolledBack(async () => {
      await runSql(`UPDATE public.time_off_requests SET ${ASK} WHERE id = '${LEAVE}'`)
      await runSql(`UPDATE public.time_off_requests SET status = 'cancelled' WHERE id = '${LEAVE}'`)
      expect((await leaveRow()).status).toBe('cancelled')
    })
  })

  it('the plain PUT\'s clear (all seven to NULL with ANY status change) is a legal row from every ask state, so it can never trip a CHECK', async () => {
    const CLEAR = `cancel_requested_at = NULL, cancel_requested_by = NULL, cancel_request_note = NULL,
      cancel_decided_at = NULL, cancel_decided_by = NULL, cancel_decision = NULL, cancel_decision_note = NULL`
    for (const to of ['cancelled', 'rejected', 'pending']) {
      await rolledBack(async () => {
        await runSql(`UPDATE public.time_off_requests SET ${ASK} WHERE id = '${LEAVE}'`)                       // open ask
        await runSql(`UPDATE public.time_off_requests SET status = '${to}', ${CLEAR} WHERE id = '${LEAVE}' AND status = 'approved'`)
        await runSql(`UPDATE public.time_off_requests SET status = 'approved' WHERE id = '${LEAVE}'`)          // reinstated
        const row = await leaveRow()
        // The bug this pins: the old ask must NOT be open again.
        expect([row.status, row.cancel_requested_at, row.cancel_decided_at]).toEqual(['approved', null, null])
      })
    }
    await rolledBack(async () => {
      await runSql(`UPDATE public.time_off_requests SET ${ASK} WHERE id = '${LEAVE}'`)
      await runSql(`UPDATE public.time_off_requests SET ${DECIDED('rejected')} WHERE id = '${LEAVE}'`)         // declined ask
      await runSql(`UPDATE public.time_off_requests SET status = 'cancelled', ${CLEAR} WHERE id = '${LEAVE}'`)
      expect((await leaveRow()).cancel_decision).toBeNull()
    })
  })

  it('reviving leave whose cancellation was approved is refused UNLESS the old ask is cleared with it (the PUT does)', async () => {
    await rolledBack(async () => {
      await runSql(`UPDATE public.time_off_requests SET ${ASK} WHERE id = '${LEAVE}'`)
      await runSql(`UPDATE public.time_off_requests SET status = 'cancelled', ${DECIDED('approved')} WHERE id = '${LEAVE}'`)
      await runSql('SAVEPOINT s')
      await expect(runSql(`UPDATE public.time_off_requests SET status = 'approved' WHERE id = '${LEAVE}'`)).rejects.toThrow(/cancel_approved_is_cancelled/)
      await runSql('ROLLBACK TO SAVEPOINT s')
      await runSql(`UPDATE public.time_off_requests SET status = 'approved',
        cancel_requested_at = NULL, cancel_requested_by = NULL, cancel_request_note = NULL,
        cancel_decided_at = NULL, cancel_decided_by = NULL, cancel_decision = NULL, cancel_decision_note = NULL WHERE id = '${LEAVE}'`)
      expect((await leaveRow()).status).toBe('approved')
      // approved -> cancelled refunded 3; cancelled -> approved charges them again.
      expect(await usedDays(MANAGER)).toBe(3)
    })
  })

  describe('the CHECKs refuse a row that contradicts itself', () => {
    const refuses = (name, set, constraint) => it(name, async () => {
      await rolledBack(async () => {
        await expect(runSql(`UPDATE public.time_off_requests SET ${set} WHERE id = '${LEAVE}'`)).rejects.toThrow(constraint)
      })
    })
    refuses('an ask with no asker', `cancel_requested_at = now()`, /cancel_ask_pair/)
    refuses('an asker with no ask', `cancel_requested_by = '${MANAGER}'`, /cancel_ask_pair/)
    refuses('a decision with no ask', DECIDED('rejected'), /cancel_decision_needs_ask/)
    refuses('half a decision (no decider)', `${ASK}, cancel_decided_at = now(), cancel_decision = 'rejected'`, /cancel_decision_trio/)
    refuses('half a decision (no verdict)', `${ASK}, cancel_decided_at = now(), cancel_decided_by = '${OWNER}'`, /cancel_decision_trio/)
    refuses('a verdict outside approved|rejected', `${ASK}, cancel_decided_at = now(), cancel_decided_by = '${OWNER}', cancel_decision = 'maybe'`, /cancel_decision_check/)
    refuses('an APPROVED cancellation on leave that is still in force', `${ASK}, ${DECIDED('approved')}`, /cancel_approved_is_cancelled/)
  })

  describe('the browser role', () => {
    it('can no longer UPDATE: not its own approved leave, not the decision columns, not a colleague\'s row', async () => {
      await expect(asUser(MANAGER, `UPDATE public.time_off_requests SET status = 'cancelled' WHERE id = '${LEAVE}'`)).rejects.toThrow(/permission denied/)
      await expect(asUser(MANAGER, `UPDATE public.time_off_requests SET ${ASK}, status = 'cancelled', ${DECIDED('approved')} WHERE id = '${LEAVE}'`)).rejects.toThrow(/permission denied/)
      await expect(asUser(OWNER, `UPDATE public.time_off_requests SET review_note = 'x' WHERE id = '${COACH_LEAVE}'`)).rejects.toThrow(/permission denied/)
    })

    it('still reads exactly the rows it could, the new columns included', async () => {
      const mine = await asUser(COACH, `SELECT id, cancel_requested_at, cancel_decision FROM public.time_off_requests`)
      expect(mine.map((r) => r.id)).toEqual([COACH_LEAVE])
      const managers = await asUser(MANAGER, `SELECT id FROM public.time_off_requests ORDER BY 1`)
      expect(managers.map((r) => r.id)).toEqual([LEAVE, COACH_LEAVE])
    })

    it('holds no UPDATE privilege at table or column level; service_role keeps its own', async () => {
      const { rows } = await db.query(`
        SELECT has_table_privilege('authenticated','public.time_off_requests','UPDATE') AS auth_upd,
               has_table_privilege('anon','public.time_off_requests','UPDATE') AS anon_upd,
               has_table_privilege('authenticated','public.time_off_requests','SELECT') AS auth_sel,
               has_table_privilege('service_role','public.time_off_requests','UPDATE') AS svc_upd,
               has_column_privilege('authenticated','public.time_off_requests','cancel_decided_by','UPDATE') AS auth_col_upd`)
      expect(rows[0]).toEqual({ auth_upd: false, anon_upd: false, auth_sel: true, svc_upd: true, auth_col_upd: false })
    })
  })

  it('is re-runnable', async () => {
    await expect(runSql(MIG_624)).resolves.toBeDefined()
  })
})
