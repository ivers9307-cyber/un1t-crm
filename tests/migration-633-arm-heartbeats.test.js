// HEARTBEAT.1 — behavioural test for migration 633.
//
// No local Supabase stack, so this boots an in-process Postgres (PGlite), runs
// the REAL mig 053 (cron_heartbeats + the cron_health view the health-check
// reads), adds mig 315's last_outcome column, then runs 633, and proves:
//   * both rows exist under the names the routes stamp (read from the code,
//     so a typo on either side is a red test, not a silent 0-row stamp);
//   * the thresholds page when they should and not before (via cron_health);
//   * replay RE-ARMS (ON CONFLICT DO UPDATE, the 601/623 shape): last_ok_at
//     moves to now(), the schedule is rewritten to the intended one, and the
//     arm's last_outcome survives;
//   * the self-check reads the POST-state and aborts the WHOLE file when a row
//     does not end up on the intended schedule.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { SHIFT_REMINDERS_HEARTBEAT, ROSTER_RUNWAY_HEARTBEAT } from '@/lib/cron-arm-health'

const read = (name) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', name), 'utf8')
const MIG_053 = read('053_cron_heartbeats.sql')
const MIG_633 = read('633_shift_reminders_roster_runway_heartbeats.sql')

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell and no
// child process), in one implicit transaction, as apply_migration runs a file.
const runSql = (text) => db.exec(text)

const row = async (name) => (await db.query(
  `SELECT name, expected_interval_seconds, grace_seconds, notes, last_ok_at, last_outcome FROM public.cron_heartbeats WHERE name = $1`, [name],
)).rows[0]

/** Put last_ok_at `seconds` in the past and ask the health view. */
const staleAfter = async (name, seconds) => {
  await db.query(`UPDATE public.cron_heartbeats SET last_ok_at = now() - ($2::int * interval '1 second') WHERE name = $1`, [name, seconds])
  return (await db.query(`SELECT is_stale FROM public.cron_health WHERE name = $1`, [name])).rows[0].is_stale
}

/** Whole seconds since the row's last_ok_at (~0 = just re-armed). */
const ageSeconds = async (name) => (await db.query(
  `SELECT EXTRACT(EPOCH FROM (now() - last_ok_at))::int AS s FROM public.cron_heartbeats WHERE name = $1`, [name],
)).rows[0].s

const armStale = async () => (await db.query(
  `SELECT name, is_stale FROM public.cron_health WHERE name = ANY($1) ORDER BY name`,
  [[SHIFT_REMINDERS_HEARTBEAT, ROSTER_RUNWAY_HEARTBEAT]],
)).rows

beforeEach(async () => {
  db = new PGlite()
  await runSql('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;') // mig 053's policies name them
  await runSql(MIG_053)
  await runSql('ALTER TABLE public.cron_heartbeats ADD COLUMN last_outcome JSONB;') // mig 315:35
}, 60_000)

afterEach(async () => { await db?.close() })

describe('mig 633 seeds the two arm rows', () => {
  it('under the names the code stamps, with each arm\'s cadence, born healthy', async () => {
    await runSql(MIG_633)
    expect(await row(SHIFT_REMINDERS_HEARTBEAT)).toMatchObject({ expected_interval_seconds: 300, grace_seconds: 900 })
    expect(await row(ROSTER_RUNWAY_HEARTBEAT)).toMatchObject({ expected_interval_seconds: 86400, grace_seconds: 43200 })
    expect(await armStale()).toEqual([{ name: 'roster-runway', is_stale: false }, { name: 'shift-reminders', is_stale: false }])
    expect((await row(SHIFT_REMINDERS_HEARTBEAT)).notes).toMatch(/send-push-reminders/)
    expect((await row(ROSTER_RUNWAY_HEARTBEAT)).notes).toMatch(/contract-reminders/)
  })

  it('shift-reminders: two missed ticks (15 min) never page; 20 min without a clean run does', async () => {
    await runSql(MIG_633)
    expect(await staleAfter(SHIFT_REMINDERS_HEARTBEAT, 15 * 60 + 30)).toBe(false)
    expect(await staleAfter(SHIFT_REMINDERS_HEARTBEAT, 19 * 60)).toBe(false)
    expect(await staleAfter(SHIFT_REMINDERS_HEARTBEAT, 21 * 60)).toBe(true)
  })

  it('roster-runway: a slow day never pages; a missed daily run pages that evening (36h)', async () => {
    await runSql(MIG_633)
    expect(await staleAfter(ROSTER_RUNWAY_HEARTBEAT, 25 * 3600)).toBe(false)
    expect(await staleAfter(ROSTER_RUNWAY_HEARTBEAT, 35 * 3600)).toBe(false)
    expect(await staleAfter(ROSTER_RUNWAY_HEARTBEAT, 37 * 3600)).toBe(true)
  })

  it('touches no other row', async () => {
    const before = (await db.query(`SELECT name, last_ok_at, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats ORDER BY name`)).rows
    await runSql(MIG_633)
    const after = (await db.query(`SELECT name, last_ok_at, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats WHERE name <> ALL($1) ORDER BY name`,
      [[SHIFT_REMINDERS_HEARTBEAT, ROSTER_RUNWAY_HEARTBEAT]])).rows
    expect(after).toEqual(before)
  })
})

describe('replay re-arms (ON CONFLICT DO UPDATE, as migs 601/623)', () => {
  it('a second run re-arms rows that had gone stale, leaves the schedule unchanged and keeps the arm\'s last_outcome', async () => {
    await runSql(MIG_633)
    const outcome = { quiet_hours: 0, shift_candidates: 1, shift_pushed: 1 }
    await db.query(`UPDATE public.cron_heartbeats SET last_outcome = $2::jsonb WHERE name = $1`, [SHIFT_REMINDERS_HEARTBEAT, JSON.stringify(outcome)])
    expect(await staleAfter(SHIFT_REMINDERS_HEARTBEAT, 30 * 60)).toBe(true) // the deploy lagged past 20 min
    expect(await staleAfter(ROSTER_RUNWAY_HEARTBEAT, 40 * 3600)).toBe(true)

    await runSql(MIG_633)

    expect(await ageSeconds(SHIFT_REMINDERS_HEARTBEAT)).toBeLessThan(5)
    expect(await ageSeconds(ROSTER_RUNWAY_HEARTBEAT)).toBeLessThan(5)
    expect(await row(SHIFT_REMINDERS_HEARTBEAT)).toMatchObject({ expected_interval_seconds: 300, grace_seconds: 900, last_outcome: outcome })
    expect(await row(ROSTER_RUNWAY_HEARTBEAT)).toMatchObject({ expected_interval_seconds: 86400, grace_seconds: 43200 })
    expect(await armStale()).toEqual([{ name: 'roster-runway', is_stale: false }, { name: 'shift-reminders', is_stale: false }])
    expect((await db.query(`SELECT count(*)::int AS n FROM public.cron_heartbeats WHERE name = ANY($1)`,
      [[SHIFT_REMINDERS_HEARTBEAT, ROSTER_RUNWAY_HEARTBEAT]])).rows[0].n).toBe(2)
  })

  it('a replay rewrites a hand-tuned or pre-existing cadence back to the intended one (the DO UPDATE trade-off)', async () => {
    await db.query(`INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) VALUES ($1, 60, 60, 'stray')`, [SHIFT_REMINDERS_HEARTBEAT])
    await runSql(MIG_633)
    expect(await row(SHIFT_REMINDERS_HEARTBEAT)).toMatchObject({ expected_interval_seconds: 300, grace_seconds: 900 })
    expect((await row(SHIFT_REMINDERS_HEARTBEAT)).notes).toMatch(/^HEARTBEAT\.1/)
  })
})

describe('the self-check reads the post-state', () => {
  it('a row that does not END UP on the intended schedule aborts the WHOLE file: nothing is applied', async () => {
    // Something outside the INSERT (here a trigger) bends the upserted row, so
    // the post-state is not what the routes and the comments rely on.
    await runSql(`
      CREATE FUNCTION public.bend_grace() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'shift-reminders' THEN NEW.grace_seconds := 60; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bend_grace BEFORE INSERT OR UPDATE ON public.cron_heartbeats
        FOR EACH ROW EXECUTE FUNCTION public.bend_grace();
    `)
    await expect(runSql(MIG_633)).rejects.toThrow(/mig 633: cron_heartbeats row shift-reminders .*300.*900/)
    expect(await row(ROSTER_RUNWAY_HEARTBEAT)).toBeUndefined()
    expect(await row(SHIFT_REMINDERS_HEARTBEAT)).toBeUndefined()
  })
})
