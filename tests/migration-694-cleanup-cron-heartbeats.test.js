// CLEANUP-1 — behavioural test for migration 694 (the heartbeat rows for the
// C47 Glofox-event purge and the C130 car-document orphan sweep).
//
// Boots PGlite, runs the REAL mig 053 (cron_heartbeats + cron_health), adds
// mig 315's last_outcome column, runs 694, and proves:
//   * both rows exist under the names the routes stamp (read from the code);
//   * one missed daily tick never pages; 36 h without a clean run does;
//   * every vercel.json entry for the two routes is a daily schedule;
//   * replay re-arms (ON CONFLICT DO UPDATE) and keeps last_outcome;
//   * the self-check reads the POST-state and aborts the WHOLE file;
//   * the file deletes nothing anywhere.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn() }))

import { HEARTBEAT_NAME as PURGE_NAME } from '@/app/api/cron/purge-glofox-webhook-events/route'
import { HEARTBEAT_NAME as SWEEP_NAME } from '@/app/api/cron/sweep-car-document-orphans/route'

const root = path.resolve(import.meta.dirname, '..')
const read = (name) => readFileSync(path.join(root, 'supabase/migrations', name), 'utf8')
const MIG_053 = read('053_cron_heartbeats.sql')
const MIG_694 = read('694_cleanup_cron_heartbeats.sql')
const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'))

let db
const runSql = (text) => db.exec(text)
const row = async (name) => (await db.query(
  `SELECT name, expected_interval_seconds, grace_seconds, notes, last_ok_at, last_outcome FROM public.cron_heartbeats WHERE name = $1`, [name],
)).rows[0]
const staleAfter = async (name, seconds) => {
  await db.query(`UPDATE public.cron_heartbeats SET last_ok_at = now() - ($2::int * interval '1 second') WHERE name = $1`, [name, seconds])
  return (await db.query(`SELECT is_stale FROM public.cron_health WHERE name = $1`, [name])).rows[0].is_stale
}

beforeEach(async () => {
  db = new PGlite()
  await runSql('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;')
  await runSql(MIG_053)
  await runSql('ALTER TABLE public.cron_heartbeats ADD COLUMN last_outcome JSONB;')
}, 60_000)

afterEach(async () => { await db?.close() })

describe('mig 694 seeds both rows', () => {
  it('under the names the routes stamp, daily, born healthy', async () => {
    await runSql(MIG_694)
    expect(PURGE_NAME).toBe('purge-glofox-webhook-events')
    expect(SWEEP_NAME).toBe('sweep-car-document-orphans')
    for (const name of [PURGE_NAME, SWEEP_NAME]) {
      expect(await row(name)).toMatchObject({ expected_interval_seconds: 86400, grace_seconds: 43200 })
      expect((await db.query(`SELECT is_stale FROM public.cron_health WHERE name = $1`, [name])).rows[0].is_stale).toBe(false)
    }
    expect((await row(PURGE_NAME)).notes).toMatch(/C47 GLOFOXEVENTRETENTION\.1/)
    expect((await row(SWEEP_NAME)).notes).toMatch(/C130 CARDOCORPHANS\.1/)
  })

  it('one missed tick (a day and a bit) never pages; 36 h without a clean run does', async () => {
    await runSql(MIG_694)
    for (const name of [PURGE_NAME, SWEEP_NAME]) {
      expect(await staleAfter(name, 26 * 3600)).toBe(false)
      expect(await staleAfter(name, 35 * 3600)).toBe(false)
      expect(await staleAfter(name, 37 * 3600)).toBe(true)
    }
  })

  it('each route is scheduled exactly once in vercel.json, daily, matching the row', () => {
    for (const name of [PURGE_NAME, SWEEP_NAME]) {
      const entries = vercel.crons.filter((c) => c.path === `/api/cron/${name}`)
      expect(entries).toHaveLength(1)
      expect(entries[0].schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/)
    }
  })

  it('says it is applied right AFTER the deploy and deletes nothing', () => {
    expect(MIG_694).toMatch(/APPLY THIS MIGRATION RIGHT AFTER THE CLEANUP-1 CODE DEPLOYS/)
    // Code only: no comment lines, no string literals (the notes describe the deletes).
    const code = MIG_694.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/'(?:[^']|'')*'/g, "''")
    expect(code).not.toMatch(/\b(DELETE|TRUNCATE|DROP)\b/i)
  })

  it('touches no other row', async () => {
    const before = (await db.query(`SELECT name, last_ok_at, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats ORDER BY name`)).rows
    await runSql(MIG_694)
    const after = (await db.query(`SELECT name, last_ok_at, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats WHERE name NOT IN ($1, $2) ORDER BY name`, [PURGE_NAME, SWEEP_NAME])).rows
    expect(after).toEqual(before)
  })
})

describe('replay re-arms', () => {
  it('re-arms a stale row, keeps last_outcome, and never duplicates', async () => {
    await runSql(MIG_694)
    const outcome = { deleted: 1000, cap_reached: true }
    await db.query(`UPDATE public.cron_heartbeats SET last_outcome = $2::jsonb, grace_seconds = 60 WHERE name = $1`, [PURGE_NAME, JSON.stringify(outcome)])
    expect(await staleAfter(PURGE_NAME, 3 * 86400)).toBe(true)
    await runSql(MIG_694)
    expect(await staleAfter(PURGE_NAME, 0)).toBe(false)
    expect(await row(PURGE_NAME)).toMatchObject({ expected_interval_seconds: 86400, grace_seconds: 43200, last_outcome: outcome })
    expect((await db.query(`SELECT count(*)::int AS n FROM public.cron_heartbeats WHERE name IN ($1, $2)`, [PURGE_NAME, SWEEP_NAME])).rows[0].n).toBe(2)
  })
})

describe('the self-check reads the post-state', () => {
  it('a row that does not END UP on the intended schedule aborts the WHOLE file', async () => {
    await runSql(`
      CREATE FUNCTION public.bend_grace() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'sweep-car-document-orphans' THEN NEW.grace_seconds := 60; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bend_grace BEFORE INSERT OR UPDATE ON public.cron_heartbeats
        FOR EACH ROW EXECUTE FUNCTION public.bend_grace();
    `)
    await expect(runSql(MIG_694)).rejects.toThrow(/mig 694: cron_heartbeats row sweep-car-document-orphans .*86400.*43200/)
    expect(await row(PURGE_NAME)).toBeUndefined()
    expect(await row(SWEEP_NAME)).toBeUndefined()
  })
})
