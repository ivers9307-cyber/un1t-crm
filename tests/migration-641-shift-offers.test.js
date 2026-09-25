// REPLACE.1b — behavioural test for migration 641 (shift_offers + claim_shift_offer).
//
// No local Supabase stack, so this boots an in-process Postgres (PGlite),
// recreates the minimum tables the function touches (column names as in prod:
// mig 010/067 blocks + assignments + the (block_id, profile_id) key, mig 177
// min_coaches, mig 628 kind, mig 622 deleted_at, mig 626's active), applies
// the REAL mig 604 (overlap guard) and 641, then drives claim_shift_offer the
// way the route does (service_role, the only role granted EXECUTE). PGlite is
// one connection, so the two-claimers race is proven by what the lock leaves
// behind: the second claim reads 'claimed'.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { offerTargetCount } from '@shared/offer-to-team'

const mig = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_604 = mig('604_shift_assignment_overlap_guard.sql')
const MIG_641 = mig('641_shift_offers.sql')

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const LOC_OTHER = 'a0000000-0000-4000-8000-00000000000b'
const MGR = '10000000-0000-4000-8000-000000000009'
const C1 = '10000000-0000-4000-8000-000000000001'
const C2 = '10000000-0000-4000-8000-000000000002'
const OUT = '10000000-0000-4000-8000-000000000003' // member of another studio only
const GONE = '10000000-0000-4000-8000-000000000004' // deactivated
const NULLACTIVE = '10000000-0000-4000-8000-000000000005' // active IS NULL (mig 626: still staff)
const ROSTER_PUB = '60000000-0000-4000-8000-000000000001'
const ROSTER_DRAFT = '60000000-0000-4000-8000-000000000002'
const TPL_CLASS = '40000000-0000-4000-8000-000000000001'
const TPL_ADMIN = '40000000-0000-4000-8000-000000000002'
const BLK = '20000000-0000-4000-8000-000000000001'
const BLK_ADMIN = '20000000-0000-4000-8000-000000000002'
const BLK_DRAFT = '20000000-0000-4000-8000-000000000003'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text, timezone text);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid REFERENCES public.profiles(id), location_id uuid REFERENCES public.locations(id), role text, PRIMARY KEY (profile_id, location_id));
  CREATE TABLE public.rosters (id uuid PRIMARY KEY, status text);
  CREATE TABLE public.shift_templates (id uuid PRIMARY KEY, name text, kind text NOT NULL DEFAULT 'class');
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY,
    location_id uuid NOT NULL REFERENCES public.locations(id),
    template_id uuid REFERENCES public.shift_templates(id),
    block_date date NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL,
    min_coaches smallint NOT NULL DEFAULT 1,
    max_coaches smallint NOT NULL DEFAULT 15,
    roster_id uuid REFERENCES public.rosters(id)
  );
  CREATE TABLE public.shift_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    block_id uuid NOT NULL REFERENCES public.shift_blocks(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.profiles(id),
    status text NOT NULL DEFAULT 'scheduled',
    notes text,
    assigned_by uuid REFERENCES public.profiles(id),
    assigned_at timestamptz NOT NULL DEFAULT now(),
    start_time_override time,
    end_time_override time,
    CONSTRAINT shift_assignments_block_id_profile_id_key UNIQUE (block_id, profile_id)
  );
  -- Supabase's default privileges: the browser roles hold ALL on a new table
  -- and EXECUTE on a new function unless the migration takes them away.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}', 'Studio North', 'Europe/Dublin'), ('${LOC_OTHER}', 'Studio South', 'Europe/Dublin');
  INSERT INTO public.profiles (id, full_name, active) VALUES
    ('${MGR}', 'Manager', true), ('${C1}', 'Coach A', true), ('${C2}', 'Coach B', true), ('${OUT}', 'Coach C', true),
    ('${GONE}', 'Coach D', false), ('${NULLACTIVE}', 'Coach E', NULL);
  INSERT INTO public.profile_locations VALUES
    ('${MGR}', '${LOC}', 'manager'), ('${C1}', '${LOC}', 'staff'), ('${C2}', '${LOC}', 'staff'),
    ('${OUT}', '${LOC_OTHER}', 'staff'), ('${GONE}', '${LOC}', 'staff'), ('${NULLACTIVE}', '${LOC}', 'staff');
  INSERT INTO public.rosters VALUES ('${ROSTER_PUB}', 'published'), ('${ROSTER_DRAFT}', 'draft');
  INSERT INTO public.shift_templates VALUES ('${TPL_CLASS}', 'Morning', 'class'), ('${TPL_ADMIN}', 'Front desk', 'admin');
  INSERT INTO public.shift_blocks (id, location_id, template_id, block_date, start_time, end_time, min_coaches, max_coaches, roster_id) VALUES
    ('${BLK}', '${LOC}', '${TPL_CLASS}', '2099-01-01', '06:00', '07:00', 2, 3, '${ROSTER_PUB}'),
    ('${BLK_ADMIN}', '${LOC}', '${TPL_ADMIN}', '2099-01-01', '09:00', '12:00', 0, 2, '${ROSTER_PUB}'),
    ('${BLK_DRAFT}', '${LOC}', '${TPL_CLASS}', '2099-01-02', '06:00', '07:00', 1, 3, '${ROSTER_DRAFT}');
`

let db
const runSql = (text) => db.exec(text) // PGlite's multi-statement runner (a SQL call, no shell)

/** One statement as service_role in its own committed tx; a raise rolls it back. */
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
const offer = async (block, status = 'open') => (await asService(
  `INSERT INTO public.shift_offers (location_id, block_id, offered_by, status, closed_at) VALUES ($1, $2, $3, $4::text, CASE WHEN $4::text = 'open' THEN NULL ELSE now() END) RETURNING id`,
  [LOC, block, MGR, status],
))[0].id
const claim = async (offerId, who) => (await asService('SELECT public.claim_shift_offer($1, $2) AS r', [offerId, who]))[0].r
const offerRow = async (id) => (await db.query('SELECT * FROM public.shift_offers WHERE id = $1', [id])).rows[0]
const liveOn = async (block) => (await db.query(`SELECT profile_id FROM public.shift_assignments WHERE block_id = $1 AND status <> 'cancelled' ORDER BY profile_id`, [block])).rows.map((r) => r.profile_id)

beforeEach(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIG_604)
  await runSql(SEED)
  await runSql(MIG_641)
}, 60_000)

afterEach(async () => { await db?.close() })

describe('mig 641 — the table', () => {
  it('RLS on, no policy, and the browser roles hold NOTHING (service role only), despite default privileges', async () => {
    expect((await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.shift_offers'::regclass`)).rows).toEqual([{ relrowsecurity: true }])
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'shift_offers'`)).rows[0].n).toBe(0)
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect((await db.query(`SELECT has_table_privilege($1, 'public.shift_offers', $2) AS ok`, [role, priv])).rows[0].ok).toBe(false)
      }
    }
    expect((await db.query(`SELECT has_table_privilege('service_role', 'public.shift_offers', 'UPDATE') AS ok`)).rows[0].ok).toBe(true)
  })

  it('ONE open offer per shift (race-proof), any number of closed ones', async () => {
    await offer(BLK)
    await expect(offer(BLK)).rejects.toThrow(/shift_offers_one_open_per_block|duplicate key/)
    await asService(`UPDATE public.shift_offers SET status = 'withdrawn', closed_at = now() WHERE block_id = $1`, [BLK])
    await expect(offer(BLK)).resolves.toBeTruthy()
  })

  it('refuses a status it does not know, an open offer with a closed_at, a claim with no time', async () => {
    await expect(asService(`INSERT INTO public.shift_offers (location_id, block_id, status, closed_at) VALUES ($1, $2, 'bogus', now())`, [LOC, BLK])).rejects.toThrow(/shift_offers_status/)
    await expect(asService(`INSERT INTO public.shift_offers (location_id, block_id, status, closed_at) VALUES ($1, $2, 'open', now())`, [LOC, BLK])).rejects.toThrow(/shift_offers_closed_pair/)
    await expect(asService(`INSERT INTO public.shift_offers (location_id, block_id, status, closed_at) VALUES ($1, $2, 'claimed', now())`, [LOC, BLK])).rejects.toThrow(/shift_offers_claim_pair/)
  })

  it('a deleted shift takes its offers with it', async () => {
    await offer(BLK)
    await runSql(`DELETE FROM public.shift_blocks WHERE id = '${BLK}'`)
    expect((await db.query('SELECT count(*)::int AS n FROM public.shift_offers')).rows[0].n).toBe(0)
  })
})

describe('mig 641 — claim_shift_offer', () => {
  it('the first claim wins: an assignment for the claimant, the offer closed as claimed', async () => {
    const id = await offer(BLK)
    const r = await claim(id, C1)
    expect(r).toMatchObject({ outcome: 'claimed', offer_id: id, block_id: BLK, block_date: '2099-01-01', location_id: LOC })
    expect(await liveOn(BLK)).toEqual([C1])
    const row = await offerRow(id)
    expect(row).toMatchObject({ status: 'claimed', claimed_by: C1, claimed_assignment_id: r.assignment_id, notice_attempts: 0, notice_lease_until: null })
    expect(row.closed_at).not.toBeNull()
    expect(row.claimed_at).not.toBeNull()
    const a = (await db.query('SELECT assigned_by, status FROM public.shift_assignments WHERE id = $1', [r.assignment_id])).rows[0]
    expect(a).toEqual({ assigned_by: C1, status: 'scheduled' })
  })

  it('a claim resets the lease: the "taken" notice is a new phase', async () => {
    const id = await offer(BLK)
    await asService(`UPDATE public.shift_offers SET notice_attempts = 3, notice_lease_until = now() + interval '5 minutes' WHERE id = $1`, [id])
    await claim(id, C1)
    expect(await offerRow(id)).toMatchObject({ notice_attempts: 0, notice_lease_until: null })
  })

  it('review 5 — the SAME claimer\'s second claim is theirs, not "someone else\'s": offer_already_yours', async () => {
    const id = await offer(BLK)
    await claim(id, C1)
    await expect(claim(id, C1)).rejects.toThrow(/^offer_already_yours/)
    expect(await liveOn(BLK)).toEqual([C1])
  })

  it('the second claimer reads the first one\'s lock: offer_not_open, nothing inserted', async () => {
    const id = await offer(BLK)
    await claim(id, C1)
    await expect(claim(id, C2)).rejects.toThrow(/^offer_not_open: offer is already claimed/)
    expect(await liveOn(BLK)).toEqual([C1])
  })

  it('an unknown offer, a missing argument', async () => {
    await expect(claim('90000000-0000-4000-8000-000000000009', C1)).rejects.toThrow(/^offer_not_found/)
    await expect(claim(null, C1)).rejects.toThrow(/^offer_bad_request/)
  })

  it('only a rosterable member of the offer\'s studio may claim (a NULL active still counts, mig 626)', async () => {
    const id = await offer(BLK)
    await expect(claim(id, OUT)).rejects.toThrow(/^offer_not_eligible/)
    await expect(claim(id, GONE)).rejects.toThrow(/^offer_not_eligible/)
    await runSql(`UPDATE public.profiles SET deleted_at = now() WHERE id = '${C2}'`)
    await expect(claim(id, C2)).rejects.toThrow(/^offer_not_eligible/)
    expect((await offerRow(id)).status).toBe('open')
    expect((await claim(id, NULLACTIVE)).outcome).toBe('claimed')
  })

  it('someone already on the shift cannot claim it again', async () => {
    await runSql(`INSERT INTO public.shift_assignments (block_id, profile_id) VALUES ('${BLK}', '${C1}')`)
    const id = await offer(BLK)
    await expect(claim(id, C1)).rejects.toThrow(/^offer_already_on/)
  })

  it('a shift on a draft roster cannot be claimed', async () => {
    const id = await offer(BLK_DRAFT)
    await expect(claim(id, C1)).rejects.toThrow(/^offer_not_published/)
  })

  it('filled meanwhile: the offer closes as filled, the claim is refused (no raise, so the close sticks)', async () => {
    await runSql(`INSERT INTO public.shift_assignments (block_id, profile_id) VALUES ('${BLK}', '${MGR}'), ('${BLK}', '${C2}')`)
    const id = await offer(BLK)
    expect(await claim(id, C1)).toEqual({ outcome: 'filled', offer_id: id })
    expect((await offerRow(id)).status).toBe('filled')
    expect(await liveOn(BLK)).toEqual([MGR, C2].sort())
  })

  it('a class shift short by one: one claim fills the place (target = its minimum)', async () => {
    await runSql(`INSERT INTO public.shift_assignments (block_id, profile_id) VALUES ('${BLK}', '${MGR}')`)
    const id = await offer(BLK)
    expect((await claim(id, C1)).outcome).toBe('claimed')
  })

  it('an admin shift (minimum 0) can be claimed only while EMPTY', async () => {
    const id = await offer(BLK_ADMIN)
    expect((await claim(id, C1)).outcome).toBe('claimed')
    const again = await offer(BLK_ADMIN)
    expect(await claim(again, C2)).toEqual({ outcome: 'filled', offer_id: again })
  })

  it('a class shift with minimum 0 still wants one coach', async () => {
    await runSql(`UPDATE public.shift_blocks SET min_coaches = 0 WHERE id = '${BLK}'`)
    const id = await offer(BLK)
    expect((await claim(id, C1)).outcome).toBe('claimed')
    const again = await offer(BLK)
    expect((await claim(again, C2)).outcome).toBe('filled')
  })

  it('the SQL target agrees with shared/offer-to-team.js offerTargetCount (the button and the lock use one rule)', async () => {
    const sqlTarget = `CASE WHEN COALESCE(t.kind, 'class') = 'admin' THEN 1 ELSE GREATEST(COALESCE(b.min_coaches, 1), 1) END`
    expect(MIG_641).toContain(`v_target := CASE WHEN v_block.kind = 'admin' THEN 1 ELSE GREATEST(COALESCE(v_block.min_coaches, 1), 1) END`)
    for (const [kind, min] of [['class', 0], ['class', 1], ['class', 3], ['admin', 0], ['admin', 2]]) {
      await runSql(`UPDATE public.shift_templates SET kind = '${kind}' WHERE id = '${TPL_CLASS}'; UPDATE public.shift_blocks SET min_coaches = ${min} WHERE id = '${BLK}'`)
      const { target } = (await db.query(`SELECT ${sqlTarget} AS target FROM public.shift_blocks b LEFT JOIN public.shift_templates t ON t.id = b.template_id WHERE b.id = $1`, [BLK])).rows[0]
      expect(target).toBe(offerTargetCount({ min_coaches: min, shift_templates: { kind } }))
    }
  })

  it('a cancelled tombstone of the claimant is cleared, not a unique-key error', async () => {
    await runSql(`INSERT INTO public.shift_assignments (block_id, profile_id, status) VALUES ('${BLK}', '${C1}', 'cancelled')`)
    const id = await offer(BLK)
    expect((await claim(id, C1)).outcome).toBe('claimed')
    expect(await liveOn(BLK)).toEqual([C1])
  })

  it('EXECUTE is service_role only; the function is SECURITY INVOKER with an empty search_path', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query(`SELECT has_function_privilege($1, 'public.claim_shift_offer(uuid, uuid)', 'EXECUTE') AS ok`, [role])).rows[0].ok).toBe(false)
    }
    expect((await db.query(`SELECT has_function_privilege('service_role', 'public.claim_shift_offer(uuid, uuid)', 'EXECUTE') AS ok`)).rows[0].ok).toBe(true)
    const fn = (await db.query(`SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.claim_shift_offer(uuid, uuid)'::regprocedure`)).rows[0]
    expect(fn.prosecdef).toBe(false)
    expect(fn.proconfig).toEqual(['search_path=""'])
  })
})

// REPLACE.1b review 2 — DELETE /api/schedule/blocks/[id] locks the SHIFT and
// its ON DELETE CASCADE then locks the offer. A claim that locked the offer
// first and the shift second could deadlock against it. PGlite is one
// connection, so the order is pinned on the function's own text (as the
// catalog stores it) and the outcomes it leads to are driven for real.
describe('mig 641 — lock order (review 2): the shift, then the offer', () => {
  const body = async () => (await db.query(`SELECT prosrc FROM pg_proc WHERE oid = 'public.claim_shift_offer(uuid, uuid)'::regprocedure`)).rows[0].prosrc
  it('the shift is locked FOR UPDATE before the offer is, and the claimant\'s advisory lock before either (review 5)', async () => {
    const src = await body()
    const advisory = src.search(/pg_advisory_xact_lock\(pg_catalog\.hashtextextended\('claim_shift_offer:'/)
    const shiftLock = src.search(/FROM public\.shift_blocks[\s\S]*?FOR UPDATE/)
    const offerLock = src.search(/FROM public\.shift_offers[^;]*WHERE id = p_offer_id[^;]*FOR UPDATE/)
    expect(advisory).toBeGreaterThan(-1)
    expect(shiftLock).toBeGreaterThan(advisory)
    expect(offerLock).toBeGreaterThan(shiftLock)
    // The only read of the offer before the shift lock takes no lock.
    const firstOfferRead = src.search(/FROM public\.shift_offers/)
    expect(src.slice(firstOfferRead, src.indexOf(';', firstOfferRead))).not.toMatch(/FOR UPDATE/)
  })
  it('the header no longer claims a lock order with no cycle for offer-then-shift', () => {
    expect(MIG_641).toMatch(/DELETE \/api\/schedule\/blocks/)
    expect(MIG_641).not.toMatch(/Lock order: offer, then shift/)
  })
  it('a shift deleted before the claim: offer_not_found (the cascade took the offer)', async () => {
    const id = await offer(BLK)
    await runSql(`DELETE FROM public.shift_blocks WHERE id = '${BLK}'`)
    await expect(claim(id, C1)).rejects.toThrow(/^offer_not_found/)
  })
  it('the offer read and the offer locked must be the same shift\'s', async () => {
    const src = await body()
    expect(src).toMatch(/v_offer\.block_id IS DISTINCT FROM v_block_id/)
  })
})

// REPLACE.1b review 5 — the same coach claiming two overlapping offers at
// once: each claim's route check read the other shift as free. Inside the
// function, under a per-claimant advisory lock, the claimant's live PUBLISHED
// shifts that day are checked against the offered window (effective windows;
// ends that only touch are not an overlap). A draft never refuses (review 4).
describe('mig 641 — the claimant is not already working then (review 5)', () => {
  const TPL_OTHER = '40000000-0000-4000-8000-000000000009'
  const other = async ({ id, start, end, roster = ROSTER_PUB, loc = LOC, date = '2099-01-01' }) => runSql(`
    INSERT INTO public.shift_templates VALUES ('${id.replace(/^2/, '4')}', 'Other ${id.slice(-2)}', 'class') ON CONFLICT DO NOTHING;
    INSERT INTO public.shift_blocks (id, location_id, template_id, block_date, start_time, end_time, min_coaches, max_coaches, roster_id)
      VALUES ('${id}', '${loc}', '${id.replace(/^2/, '4')}', '${date}', '${start}', '${end}', 1, 3, '${roster}');`)
  const on = async (block, who, over = '') => runSql(`INSERT INTO public.shift_assignments (block_id, profile_id${over ? ', start_time_override' : ''}) VALUES ('${block}', '${who}'${over ? `, '${over}'` : ''})`)

  it('a live published shift overlapping the offered one refuses: claimant_overlap, nothing inserted, the offer stays open', async () => {
    await other({ id: '20000000-0000-4000-8000-000000000011', start: '06:30', end: '08:00' })
    await on('20000000-0000-4000-8000-000000000011', C1)
    const id = await offer(BLK)
    await expect(claim(id, C1)).rejects.toThrow(/^claimant_overlap/)
    expect(await liveOn(BLK)).toEqual([])
    expect((await offerRow(id)).status).toBe('open')
  })
  it('at ANOTHER studio too (they cannot be in two places)', async () => {
    await other({ id: '20000000-0000-4000-8000-000000000012', start: '05:30', end: '06:30', loc: LOC_OTHER })
    await on('20000000-0000-4000-8000-000000000012', C1)
    await expect(claim(await offer(BLK), C1)).rejects.toThrow(/^claimant_overlap/)
  })
  it('an override that stretches another shift over this one counts (effective window)', async () => {
    await other({ id: '20000000-0000-4000-8000-000000000013', start: '07:00', end: '09:00' })
    await on('20000000-0000-4000-8000-000000000013', C1, '06:30')
    await expect(claim(await offer(BLK), C1)).rejects.toThrow(/^claimant_overlap/)
  })
  it('ends that only touch, another day, a cancelled row or a DRAFT shift never refuse', async () => {
    await other({ id: '20000000-0000-4000-8000-000000000014', start: '05:00', end: '06:00' })
    await other({ id: '20000000-0000-4000-8000-000000000015', start: '06:00', end: '07:00', date: '2099-01-02' })
    await other({ id: '20000000-0000-4000-8000-000000000016', start: '06:00', end: '07:00', roster: ROSTER_DRAFT })
    await other({ id: '20000000-0000-4000-8000-000000000017', start: '06:15', end: '06:45' })
    await on('20000000-0000-4000-8000-000000000014', C1)
    await on('20000000-0000-4000-8000-000000000015', C1)
    await on('20000000-0000-4000-8000-000000000016', C1)
    await runSql(`INSERT INTO public.shift_assignments (block_id, profile_id, status) VALUES ('20000000-0000-4000-8000-000000000017', '${C1}', 'cancelled')`)
    expect((await claim(await offer(BLK), C1)).outcome).toBe('claimed')
  })
  it('two offers the same coach claims back to back: the second, overlapping, is refused', async () => {
    await other({ id: '20000000-0000-4000-8000-000000000018', start: '06:30', end: '07:30' })
    const first = await offer(BLK)
    const second = await asService(`INSERT INTO public.shift_offers (location_id, block_id, offered_by) VALUES ($1, $2, $3) RETURNING id`, [LOC, '20000000-0000-4000-8000-000000000018', MGR])
    expect((await claim(first, C1)).outcome).toBe('claimed')
    await expect(claim(second[0].id, C1)).rejects.toThrow(/^claimant_overlap/)
  })
})

describe('mig 641 — replay', () => {
  it('replaying the file is safe and changes nothing', async () => {
    const id = await offer(BLK)
    await runSql(MIG_641)
    expect((await offerRow(id)).status).toBe('open')
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'shift_offers_one_open_per_block'`)).rows[0].n).toBe(1)
    expect((await db.query(`SELECT has_table_privilege('authenticated', 'public.shift_offers', 'SELECT') AS ok`)).rows[0].ok).toBe(false)
  })

  it('seeds NO heartbeat row: that is mig 642, applied after the deploy', () => {
    expect(MIG_641).not.toMatch(/cron_heartbeats/i)
  })
})
