// REPLACE.1a review 6 — behavioural test for migration 640, mirroring 639's.
//
// Boots PGlite, runs the REAL mig 053 (cron_heartbeats + cron_health), adds mig
// 315's last_outcome column, runs 640, and proves:
//   * the row exists under the name the route stamps (read from the code);
//   * the thresholds page when they should and not before (via cron_health);
//   * replay RE-ARMS (ON CONFLICT DO UPDATE): last_ok_at moves to now(), the
//     schedule is rewritten, last_outcome survives;
//   * the self-check reads the POST-state and aborts the WHOLE file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { REPLACE_NOTICES_HEARTBEAT } from '@/lib/cron-arm-health'

const read = (name) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', name), 'utf8')
const MIG_053 = read('053_cron_heartbeats.sql')
const MIG_640 = read('640_replace_notice_heartbeat.sql')

let db
const runSql = (text) => db.exec(text)

const row = async (name) => (await db.query(
  `SELECT name, expected_interval_seconds, grace_seconds, notes, last_ok_at, last_outcome FROM public.cron_heartbeats WHERE name = $1`, [name],
)).rows[0]

const staleAfter = async (name, seconds) => {
  await db.query(`UPDATE public.cron_heartbeats SET last_ok_at = now() - ($2::int * interval '1 second') WHERE name = $1`, [name, seconds])
  return (await db.query(`SELECT is_stale FROM public.cron_health WHERE name = $1`, [name])).rows[0].is_stale
}

const ageSeconds = async (name) => (await db.query(
  `SELECT EXTRACT(EPOCH FROM (now() - last_ok_at))::int AS s FROM public.cron_heartbeats WHERE name = $1`, [name],
)).rows[0].s

beforeEach(async () => {
  db = new PGlite()
  await runSql('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;')
  await runSql(MIG_053)
  await runSql('ALTER TABLE public.cron_heartbeats ADD COLUMN last_outcome JSONB;')
}, 60_000)

afterEach(async () => { await db?.close() })

describe('mig 640 seeds the held replace-notice arm row', () => {
  it('under the name the code stamps, on the */5 arm cadence, born healthy', async () => {
    await runSql(MIG_640)
    expect(REPLACE_NOTICES_HEARTBEAT).toBe('replace-notices')
    expect(await row(REPLACE_NOTICES_HEARTBEAT)).toMatchObject({ expected_interval_seconds: 300, grace_seconds: 900 })
    expect((await db.query(`SELECT is_stale FROM public.cron_health WHERE name = $1`, [REPLACE_NOTICES_HEARTBEAT])).rows[0].is_stale).toBe(false)
    expect((await row(REPLACE_NOTICES_HEARTBEAT)).notes).toMatch(/send-push-reminders/)
    expect((await row(REPLACE_NOTICES_HEARTBEAT)).notes).toMatch(/stamp_failed/)
  })

  it('says in its header that it is applied right AFTER the deploy', () => {
    expect(MIG_640).toMatch(/APPLY THIS MIGRATION RIGHT AFTER THE REPLACE\.1a CODE DEPLOYS/)
  })

  it('two missed ticks (15 min) never page; 20 min without a clean run does', async () => {
    await runSql(MIG_640)
    expect(await staleAfter(REPLACE_NOTICES_HEARTBEAT, 15 * 60 + 30)).toBe(false)
    expect(await staleAfter(REPLACE_NOTICES_HEARTBEAT, 19 * 60)).toBe(false)
    expect(await staleAfter(REPLACE_NOTICES_HEARTBEAT, 21 * 60)).toBe(true)
  })

  it('touches no other row', async () => {
    const before = (await db.query(`SELECT name, last_ok_at, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats ORDER BY name`)).rows
    await runSql(MIG_640)
    const after = (await db.query(`SELECT name, last_ok_at, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats WHERE name <> $1 ORDER BY name`,
      [REPLACE_NOTICES_HEARTBEAT])).rows
    expect(after).toEqual(before)
  })
})

describe('replay re-arms (ON CONFLICT DO UPDATE, as migs 601/623/633)', () => {
  it('re-arms a stale row, keeps the schedule and the arm\'s last_outcome', async () => {
    await runSql(MIG_640)
    const outcome = { rows: 2, groups: 1, told: 2, silent: 0, started: 0, gone: 0, quiet: 0, fresh: 0, undelivered: 0, send_failed: 0, stamp_failed: 0, errors: 0 }
    await db.query(`UPDATE public.cron_heartbeats SET last_outcome = $2::jsonb WHERE name = $1`, [REPLACE_NOTICES_HEARTBEAT, JSON.stringify(outcome)])
    expect(await staleAfter(REPLACE_NOTICES_HEARTBEAT, 30 * 60)).toBe(true)
    await runSql(MIG_640)
    expect(await ageSeconds(REPLACE_NOTICES_HEARTBEAT)).toBeLessThan(5)
    expect(await row(REPLACE_NOTICES_HEARTBEAT)).toMatchObject({ expected_interval_seconds: 300, grace_seconds: 900, last_outcome: outcome })
    expect((await db.query(`SELECT count(*)::int AS n FROM public.cron_heartbeats WHERE name = $1`, [REPLACE_NOTICES_HEARTBEAT])).rows[0].n).toBe(1)
  })

  it('rewrites a hand-tuned or pre-existing cadence back to the intended one', async () => {
    await db.query(`INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) VALUES ($1, 60, 60, 'stray')`, [REPLACE_NOTICES_HEARTBEAT])
    await runSql(MIG_640)
    expect(await row(REPLACE_NOTICES_HEARTBEAT)).toMatchObject({ expected_interval_seconds: 300, grace_seconds: 900 })
    expect((await row(REPLACE_NOTICES_HEARTBEAT)).notes).toMatch(/^REPLACE\.1a/)
  })
})

describe('the self-check reads the post-state', () => {
  it('a row that does not END UP on the intended schedule aborts the WHOLE file', async () => {
    await runSql(`
      CREATE FUNCTION public.bend_grace() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'replace-notices' THEN NEW.grace_seconds := 60; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bend_grace BEFORE INSERT OR UPDATE ON public.cron_heartbeats
        FOR EACH ROW EXECUTE FUNCTION public.bend_grace();
    `)
    await expect(runSql(MIG_640)).rejects.toThrow(/mig 640: cron_heartbeats row replace-notices .*300.*900/)
    expect(await row(REPLACE_NOTICES_HEARTBEAT)).toBeUndefined()
  })
})
