// SWAPS.2 — behavioural test for migration 615.
//
// Same approach as migration-613/614: boot an in-process Postgres (PGlite),
// recreate the minimum tables the functions touch (column names as in prod:
// mig 010 swap row, mig 067 blocks/assignments + unique key, mig 099 partial
// overrides, mig 603 ON DELETE SET NULL, mig 609 arrival stamp), apply the
// REAL mig 604 overlap guard, 612 and 615 files, then drive the three approve
// functions the way the route does (service_role, the only role granted
// EXECUTE).

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { SWAP_MOVE_CLEARS } from '../src/lib/swap-lifecycle'

const mig = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_604 = mig('604_shift_assignment_overlap_guard.sql')
const MIG_612 = mig('612_approve_reciprocal_shift_swap.sql')
const MIG_615 = mig('615_swap_moves_clear_adjustments.sql')

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const REQ = '10000000-0000-0000-0000-000000000001'
const TAKER = '10000000-0000-0000-0000-000000000002'
const OTHER = '10000000-0000-0000-0000-000000000003'
const MGR = '10000000-0000-0000-0000-000000000009'
const TPL = '40000000-0000-0000-0000-000000000001'
const BLK1 = '20000000-0000-0000-0000-000000000001'
const BLK2 = '20000000-0000-0000-0000-000000000002'
const A_REQ = '30000000-0000-0000-0000-000000000001' // REQ on BLK1
const A_TGT = '30000000-0000-0000-0000-000000000002' // TAKER on BLK2
const SWAP = '50000000-0000-0000-0000-000000000001'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text);
  CREATE TABLE public.shift_templates (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY,
    location_id uuid REFERENCES public.locations(id),
    template_id uuid REFERENCES public.shift_templates(id),
    block_date date NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL
  );
  CREATE TABLE public.shift_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    block_id uuid NOT NULL REFERENCES public.shift_blocks(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.profiles(id),
    status text DEFAULT 'scheduled',
    start_time_override time,
    end_time_override time,
    partial_reason text,
    arrived_at timestamptz,
    arrival_source text,
    CONSTRAINT shift_assignments_block_id_profile_id_key UNIQUE (block_id, profile_id)
  );
  CREATE TABLE public.shift_swap_requests (
    id uuid PRIMARY KEY,
    location_id uuid NOT NULL REFERENCES public.locations(id),
    requester_shift_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
    requester_id uuid NOT NULL REFERENCES public.profiles(id),
    target_shift_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
    target_id uuid REFERENCES public.profiles(id),
    status text DEFAULT 'pending',
    reviewed_by uuid REFERENCES public.profiles(id),
    reviewed_at timestamptz,
    review_note text
  );
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}');
  INSERT INTO public.profiles VALUES ('${REQ}', 'Req'), ('${TAKER}', 'Taker'), ('${OTHER}', 'Other'), ('${MGR}', 'Mgr');
  INSERT INTO public.shift_templates VALUES ('${TPL}', 'Morning');
  INSERT INTO public.shift_blocks VALUES
    ('${BLK1}', '${LOC}', '${TPL}', '2099-01-01', '06:00', '10:00'),
    ('${BLK2}', '${LOC}', '${TPL}', '2099-01-02', '06:00', '10:00');
  INSERT INTO public.shift_assignments (id, block_id, profile_id, status, start_time_override, end_time_override, partial_reason, arrived_at, arrival_source) VALUES
    ('${A_REQ}', '${BLK1}', '${REQ}', 'scheduled', '07:00', '09:00', 'left early', '2099-01-01T06:58:00Z', 'geofence'),
    ('${A_TGT}', '${BLK2}', '${TAKER}', 'scheduled', '06:30', NULL, 'late start', '2099-01-02T06:31:00Z', 'manual');
`

let db
// PGlite's multi-statement runner (PGlite#exec — a SQL call, no shell).
const runSql = (text) => db.exec(text)

/** Run one statement as service_role in its own committed tx; a raise rolls it back. */
async function asService(sql, params = []) {
  await runSql('BEGIN')
  try {
    await runSql('SET LOCAL ROLE service_role')
    const res = await db.query(sql, params)
    await runSql('COMMIT')
    return res.rows
  } catch (e) {
    await runSql('ROLLBACK')
    throw e
  }
}

const REVIEW = [MGR, '2099-01-01T00:00:00Z', 'ok']
const reciprocal = (req = REQ, tgt = TAKER) => asService(
  'SELECT * FROM public.approve_reciprocal_shift_swap($1, $2, $3, $4, $5, $6)', [SWAP, ...REVIEW, req, tgt])
const reassign = (req = REQ, tgt = TAKER) => asService(
  'SELECT * FROM public.approve_reassign_shift_swap($1, $2, $3, $4, $5, $6)', [SWAP, ...REVIEW, req, tgt])
const drop = (req = REQ) => asService(
  'SELECT * FROM public.approve_drop_shift_swap($1, $2, $3, $4, $5)', [SWAP, ...REVIEW, req])

const assignment = async (id) => (await db.query('SELECT * FROM public.shift_assignments WHERE id = $1', [id])).rows[0]
const swapRow = async () => (await db.query('SELECT * FROM public.shift_swap_requests WHERE id = $1', [SWAP])).rows[0]

function insertSwap({ targetId = null, targetShiftId = null, status = 'awaiting_approval' } = {}) {
  return runSql(`INSERT INTO public.shift_swap_requests (id, location_id, requester_shift_id, requester_id, target_shift_id, target_id, status)
    VALUES ('${SWAP}', '${LOC}', '${A_REQ}', '${REQ}', ${targetShiftId ? `'${targetShiftId}'` : 'NULL'}, ${targetId ? `'${targetId}'` : 'NULL'}, '${status}')`)
}

// Makes the final "approve the swap row" write fail, to prove the move before
// it rolls back with it.
const FAIL_APPROVAL = `
  CREATE OR REPLACE FUNCTION public.fail_approve_fn() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'approval write failed'; END $$;
  CREATE TRIGGER fail_approve BEFORE UPDATE ON public.shift_swap_requests
    FOR EACH ROW WHEN (NEW.status = 'approved') EXECUTE FUNCTION public.fail_approve_fn();`

// The route-side description of the move (swap-lifecycle) must match what the
// SQL actually clears.
const CLEARED = SWAP_MOVE_CLEARS

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIG_604)
  await runSql(MIG_612)
  await runSql(MIG_615)
}, 60_000)

beforeEach(async () => {
  await runSql('DROP TRIGGER IF EXISTS fail_approve ON public.shift_swap_requests')
  await runSql('TRUNCATE public.shift_swap_requests, public.shift_assignments, public.shift_blocks, public.shift_templates, public.profiles, public.locations CASCADE')
  await runSql(SEED)
})

afterAll(async () => { await db?.close() })

describe('migration 615 — function posture', () => {
  it.each([
    ['approve_reciprocal_shift_swap(uuid, uuid, timestamptz, text, uuid, uuid)'],
    ['approve_reassign_shift_swap(uuid, uuid, timestamptz, text, uuid, uuid)'],
    ['approve_drop_shift_swap(uuid, uuid, timestamptz, text, uuid)'],
  ])('%s: EXECUTE for service_role only, SECURITY INVOKER, empty search_path', async (sig) => {
    const { rows } = await db.query(`
      SELECT has_function_privilege('service_role', 'public.${sig}', 'EXECUTE') AS service,
             has_function_privilege('authenticated', 'public.${sig}', 'EXECUTE') AS authed,
             has_function_privilege('anon', 'public.${sig}', 'EXECUTE') AS anon,
             p.prosecdef, p.proconfig
        FROM pg_proc p WHERE p.oid = 'public.${sig}'::regprocedure`)
    expect(rows[0]).toMatchObject({ service: true, authed: false, anon: false, prosecdef: false })
    expect(rows[0].proconfig).toEqual(['search_path=""'])
  })
})

describe('approve_reciprocal_shift_swap (615 replacement)', () => {
  it('swaps both coaches, clears both rows\' adjustments and approves', async () => {
    await insertSwap({ targetId: TAKER, targetShiftId: A_TGT })
    const [row] = await reciprocal()
    expect(row.status).toBe('approved')
    expect(row.reviewed_by).toBe(MGR)
    expect(await assignment(A_REQ)).toMatchObject({ profile_id: TAKER, status: 'swapped', ...CLEARED })
    expect(await assignment(A_TGT)).toMatchObject({ profile_id: REQ, status: 'swapped', ...CLEARED })
  })

  it('still refuses a stale read with swap_stale and changes nothing', async () => {
    await insertSwap({ targetId: TAKER, targetShiftId: A_TGT })
    await expect(reciprocal(REQ, OTHER)).rejects.toThrow(/^swap_stale:/)
    expect(await assignment(A_REQ)).toMatchObject({ profile_id: REQ, partial_reason: 'left early' })
    expect((await swapRow()).status).toBe('awaiting_approval')
  })

  it('leaves the overlap-guard GUC as the caller had it', async () => {
    await insertSwap({ targetId: TAKER, targetShiftId: A_TGT })
    await runSql('BEGIN')
    try {
      await runSql("SELECT set_config('app.allow_overlap', 'caller', true)")
      await db.query('SELECT public.approve_reciprocal_shift_swap($1, $2, $3, $4, $5, $6)', [SWAP, ...REVIEW, REQ, TAKER])
      const { rows } = await db.query("SELECT current_setting('app.allow_overlap', true) AS v")
      expect(rows[0].v).toBe('caller')
    } finally {
      await runSql('ROLLBACK')
    }
  })
})

describe('approve_reassign_shift_swap', () => {
  it('moves the shift to the taker, clears the adjustments, approves', async () => {
    await insertSwap({ targetId: TAKER })
    const [row] = await reassign()
    expect(row).toMatchObject({ status: 'approved', reviewed_by: MGR, review_note: 'ok' })
    expect(await assignment(A_REQ)).toMatchObject({ profile_id: TAKER, status: 'swapped', block_id: BLK1, ...CLEARED })
    // The taker's own other shift is untouched.
    expect(await assignment(A_TGT)).toMatchObject({ profile_id: TAKER, partial_reason: 'late start' })
  })

  it('swap_not_found for an unknown id', async () => {
    await expect(reassign()).rejects.toThrow(/^swap_not_found:/)
  })

  it('swap_not_open when already decided', async () => {
    await insertSwap({ targetId: TAKER, status: 'approved' })
    await expect(reassign()).rejects.toThrow(/^swap_not_open:/)
  })

  it('swap_shift_missing when the assignment is gone', async () => {
    await insertSwap({ targetId: TAKER })
    await runSql(`DELETE FROM public.shift_assignments WHERE id = '${A_REQ}'`)
    await expect(reassign()).rejects.toThrow(/^swap_shift_missing:/)
  })

  it('swap_stale when the shift changed hands', async () => {
    await insertSwap({ targetId: TAKER })
    await runSql(`UPDATE public.shift_assignments SET profile_id = '${OTHER}' WHERE id = '${A_REQ}'`)
    await expect(reassign()).rejects.toThrow(/^swap_stale:/)
  })

  it('swap_stale when a different coach now holds the claim', async () => {
    await insertSwap({ targetId: OTHER })
    await expect(reassign(REQ, TAKER)).rejects.toThrow(/^swap_stale:/)
    expect(await assignment(A_REQ)).toMatchObject({ profile_id: REQ })
  })

  it('swap_stale when the swap is really a reciprocal one', async () => {
    await insertSwap({ targetId: TAKER, targetShiftId: A_TGT })
    await expect(reassign()).rejects.toThrow(/^swap_stale:/)
  })

  it('swap_conflict when the taker is already on that block', async () => {
    await insertSwap({ targetId: TAKER })
    await runSql(`INSERT INTO public.shift_assignments (block_id, profile_id) VALUES ('${BLK1}', '${TAKER}')`)
    await expect(reassign()).rejects.toThrow(/^swap_conflict:/)
    expect(await assignment(A_REQ)).toMatchObject({ profile_id: REQ })
    expect((await swapRow()).status).toBe('awaiting_approval')
  })

  it('rolls the move back when the approval write fails (atomic)', async () => {
    await insertSwap({ targetId: TAKER })
    await runSql(FAIL_APPROVAL)
    await expect(reassign()).rejects.toThrow(/approval write failed/)
    expect(await assignment(A_REQ)).toMatchObject({ profile_id: REQ, status: 'scheduled', partial_reason: 'left early', arrival_source: 'geofence' })
    expect((await swapRow()).status).toBe('awaiting_approval')
  })
})

describe('approve_drop_shift_swap', () => {
  it('deletes the shift and approves the swap, which survives with a null shift pointer', async () => {
    await insertSwap({ status: 'pending' })
    const [row] = await drop()
    expect(row).toMatchObject({ status: 'approved', reviewed_by: MGR, requester_shift_id: null })
    expect(await assignment(A_REQ)).toBeUndefined()
  })

  it('swap_stale when someone claimed it since the read, and nothing is deleted', async () => {
    await insertSwap({ targetId: TAKER })
    await expect(drop()).rejects.toThrow(/^swap_stale:/)
    expect(await assignment(A_REQ)).toBeTruthy()
    expect((await swapRow()).status).toBe('awaiting_approval')
  })

  it('swap_stale when the shift is no longer the requester\'s', async () => {
    await insertSwap({ status: 'pending' })
    await expect(drop(OTHER)).rejects.toThrow(/^swap_stale:/)
  })

  it('swap_not_open, then swap_shift_missing', async () => {
    await insertSwap({ status: 'cancelled' })
    await expect(drop()).rejects.toThrow(/^swap_not_open:/)
    await runSql(`UPDATE public.shift_swap_requests SET status = 'pending', requester_shift_id = NULL`)
    await expect(drop()).rejects.toThrow(/^swap_shift_missing:/)
  })

  it('rolls the delete back when the approval write fails (atomic)', async () => {
    await insertSwap({ status: 'pending' })
    await runSql(FAIL_APPROVAL)
    await expect(drop()).rejects.toThrow(/approval write failed/)
    expect(await assignment(A_REQ)).toBeTruthy()
    expect(await swapRow()).toMatchObject({ status: 'pending', requester_shift_id: A_REQ })
  })
})
