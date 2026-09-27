// CLASSSYNCHB.1 — behavioural test for migration 644.
//
// Four cron_heartbeats rows drifted from their vercel.json schedule because a
// schedule changed with no heartbeat migration:
//   sync-class-occurrences  */15 but 86400+7200 (migs 285/286 widened it for an
//                           hourly then daily schedule; HR-WAVE1 P0-8 restored */15)
//   ad-insights-sync        0 */4 but 86400+21600 (mig 360 seeded it daily)
//   process-class-bookings  */2 but 60+120   (#894 slowed it from every minute)
//   process-contact-imports */2 but 60+120   (same)
//
// Boots PGlite, runs the REAL mig 053, rebuilds that live drift from the real
// migrations where they are pure heartbeat DML (119, 285, 286, 360) and from
// the exact seed statement where the file also carries unrelated DDL (097,
// 284, 335), then runs 644 and proves:
//   * each row ends on its intended cadence (one missed tick never pages, two do);
//   * last_ok_at and last_outcome are NEVER touched: a late row stays late;
//   * replay is a no-op; a missing row is seeded born healthy;
//   * the self-check reads the post-state and aborts the WHOLE file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const read = (name) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', name), 'utf8')
const MIG_053 = read('053_cron_heartbeats.sql')
const MIG_119 = read('119_cron_heartbeat_fixes.sql')
const MIG_285 = read('285_class_occurrences_sync_hourly.sql')
const MIG_286 = read('286_class_occurrences_sync_daily.sql')
const MIG_360 = read('360_ads_cron_heartbeats.sql')
const MIG_644 = read('644_cron_heartbeat_cadence.sql')

const INTENDED = {
  'ad-insights-sync': { expected_interval_seconds: 14400, grace_seconds: 18000 },
  'process-class-bookings': { expected_interval_seconds: 120, grace_seconds: 240 },
  'process-contact-imports': { expected_interval_seconds: 120, grace_seconds: 240 },
  'sync-class-occurrences': { expected_interval_seconds: 900, grace_seconds: 1200 },
}
const NAMES = Object.keys(INTENDED)

let db
// PGlite's multi-statement SQL runner (in-process, no shell), one implicit
// transaction per call, as apply_migration runs a file.
const runSql = (text) => db.exec(text)

const row = async (name) => (await db.query(
  `SELECT name, expected_interval_seconds, grace_seconds, notes, last_ok_at, last_outcome FROM public.cron_heartbeats WHERE name = $1`, [name],
)).rows[0]

const cadence = async (name) => {
  const r = await row(name)
  return r && { expected_interval_seconds: r.expected_interval_seconds, grace_seconds: r.grace_seconds }
}

/** Put last_ok_at `seconds` in the past and ask the health view. */
const staleAfter = async (name, seconds) => {
  await db.query(`UPDATE public.cron_heartbeats SET last_ok_at = now() - ($2::int * interval '1 second') WHERE name = $1`, [name, seconds])
  return (await db.query(`SELECT is_stale FROM public.cron_health WHERE name = $1`, [name])).rows[0].is_stale
}

/** The live drift of 27 Sep 2026, rebuilt from the migrations that made it. */
async function seedLiveDrift() {
  // mig 097:65-72's seed for process-contact-imports (the file also drops pg_cron)
  await runSql(`INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
                VALUES ('process-contact-imports', 60, 30, 'Vercel cron * * * * * UTC')`)
  await runSql(MIG_119) // its grace 30 → 120
  // mig 284:88-90's seed (the file also creates class_occurrences / automation_fire_log)
  await runSql(`INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
                VALUES ('sync-class-occurrences', 900, 900, NOW()) ON CONFLICT (name) DO NOTHING`)
  await runSql(MIG_285) // → 3600 + 1800
  await runSql(MIG_286) // → 86400 + 7200
  await runSql(MIG_360) // ad-insights-sync 86400 + 21600
  // mig 335:61-63's seed (the file also creates class_booking_requests)
  await runSql(`INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
                VALUES ('process-class-bookings', 60, 120, now()) ON CONFLICT (name) DO NOTHING`)
}

beforeEach(async () => {
  db = new PGlite()
  await runSql('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;') // mig 053's policies name them
  await runSql(MIG_053)
  await runSql('ALTER TABLE public.cron_heartbeats ADD COLUMN last_outcome JSONB;') // mig 315
}, 60_000)

afterEach(async () => { await db?.close() })

describe('the drift 644 repairs', () => {
  it('replaying the migrations reproduces the live rows of 27 Sep', async () => {
    await seedLiveDrift()
    expect(await cadence('sync-class-occurrences')).toEqual({ expected_interval_seconds: 86400, grace_seconds: 7200 })
    expect(await cadence('ad-insights-sync')).toEqual({ expected_interval_seconds: 86400, grace_seconds: 21600 })
    expect(await cadence('process-class-bookings')).toEqual({ expected_interval_seconds: 60, grace_seconds: 120 })
    expect(await cadence('process-contact-imports')).toEqual({ expected_interval_seconds: 60, grace_seconds: 120 })
  })
})

describe('mig 644 puts each row on its real cadence', () => {
  it.each(NAMES)('%s ends on its intended interval + grace, with notes naming the schedule and mig 644', async (name) => {
    await seedLiveDrift()
    await runSql(MIG_644)
    expect(await cadence(name)).toEqual(INTENDED[name])
    expect((await row(name)).notes).toMatch(/CLASSSYNCHB\.1 \(mig 644\)/)
    expect((await row(name)).notes).toMatch(/Vercel cron /)
  })

  it('sync-class-occurrences (*/15): one missed tick never pages, two in a row do (35 min)', async () => {
    await seedLiveDrift(); await runSql(MIG_644)
    expect(await staleAfter('sync-class-occurrences', 31 * 60)).toBe(false)  // one miss + 60 s run
    expect(await staleAfter('sync-class-occurrences', 34 * 60)).toBe(false)
    expect(await staleAfter('sync-class-occurrences', 36 * 60)).toBe(true)
    expect(await staleAfter('sync-class-occurrences', 45 * 60)).toBe(true)   // two misses
  })

  it('ad-insights-sync (0 */4): one missed run never pages, two in a row do (9 h)', async () => {
    await seedLiveDrift(); await runSql(MIG_644)
    expect(await staleAfter('ad-insights-sync', 8 * 3600 + 300)).toBe(false) // one miss + maxDuration
    expect(await staleAfter('ad-insights-sync', 8 * 3600 + 59 * 60)).toBe(false)
    expect(await staleAfter('ad-insights-sync', 9 * 3600 + 60)).toBe(true)
  })

  it.each(['process-class-bookings', 'process-contact-imports'])('%s (*/2): one missed tick never pages; stale after 6 min', async (name) => {
    await seedLiveDrift(); await runSql(MIG_644)
    expect(await staleAfter(name, 200)).toBe(false)  // was already stale under 60 + 120
    expect(await staleAfter(name, 300)).toBe(false)  // one miss + 60 s jitter
    expect(await staleAfter(name, 361)).toBe(true)
  })

  it('touches no other row', async () => {
    await seedLiveDrift()
    const others = `SELECT name, last_ok_at, expected_interval_seconds, grace_seconds, notes FROM public.cron_heartbeats WHERE name <> ALL($1) ORDER BY name`
    const before = (await db.query(others, [NAMES])).rows
    expect(before.length).toBeGreaterThan(3) // 053's, 119's and 360's other seeds are there
    await runSql(MIG_644)
    expect((await db.query(others, [NAMES])).rows).toEqual(before)
  })
})

describe('never re-arms: last_ok_at and last_outcome are left alone', () => {
  it('keeps each row\'s last stamp and outcome byte-for-byte', async () => {
    await seedLiveDrift()
    await db.query(`UPDATE public.cron_heartbeats SET last_ok_at = now() - interval '10 minutes', last_outcome = '{"n":1}'::jsonb WHERE name = ANY($1)`, [NAMES])
    const before = Object.fromEntries(await Promise.all(NAMES.map(async (n) => [n, await row(n)])))
    await runSql(MIG_644)
    for (const n of NAMES) {
      const after = await row(n)
      expect(after.last_ok_at).toEqual(before[n].last_ok_at)
      expect(after.last_outcome).toEqual({ n: 1 })
    }
  })

  it('a class sync that is really dead (2 h since its last stamp) is STALE the moment 644 lands, and was hidden before', async () => {
    await seedLiveDrift()
    expect(await staleAfter('sync-class-occurrences', 2 * 3600)).toBe(false) // 86400 + 7200 hides it
    await runSql(MIG_644)
    expect((await db.query(`SELECT is_stale FROM public.cron_health WHERE name = 'sync-class-occurrences'`)).rows[0].is_stale).toBe(true)
  })
})

describe('replay and a fresh database', () => {
  it('replaying 644 is a no-op', async () => {
    await seedLiveDrift()
    await runSql(MIG_644)
    const snap = async () => (await db.query(`SELECT * FROM public.cron_heartbeats ORDER BY name`)).rows
    const once = await snap()
    await runSql(MIG_644)
    expect(await snap()).toEqual(once)
  })

  it('a row that does not exist yet is seeded born healthy (last_ok_at defaults to now())', async () => {
    await runSql(MIG_644)
    for (const n of NAMES) expect(await cadence(n)).toEqual(INTENDED[n])
    const { rows } = await db.query(`SELECT name FROM public.cron_health WHERE name = ANY($1) AND is_stale`, [NAMES])
    expect(rows).toEqual([])
  })
})

describe('the self-check reads the post-state', () => {
  it('a row that does not END UP on the intended cadence aborts the WHOLE file', async () => {
    await seedLiveDrift()
    await runSql(`
      CREATE FUNCTION public.bend_grace() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'process-contact-imports' THEN NEW.grace_seconds := 60; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bend_grace BEFORE INSERT OR UPDATE ON public.cron_heartbeats
        FOR EACH ROW EXECUTE FUNCTION public.bend_grace();
    `)
    await expect(runSql(MIG_644)).rejects.toThrow(/mig 644: cron_heartbeats row process-contact-imports .*120.*240/)
    // nothing applied: every row still carries its drift
    expect(await cadence('sync-class-occurrences')).toEqual({ expected_interval_seconds: 86400, grace_seconds: 7200 })
    expect(await cadence('ad-insights-sync')).toEqual({ expected_interval_seconds: 86400, grace_seconds: 21600 })
  })
})
