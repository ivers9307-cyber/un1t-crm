// REVPAY.3 — behavioural test for migration 773 (the 755 pattern).
//
// Boots PGlite, runs the REAL mig 053 (cron_heartbeats + cron_health), adds mig
// 315's last_outcome column, runs 773, and proves:
//   * the row exists under the name the route stamps (read from the route);
//   * one missed tick never pages, two in a row do (via cron_health);
//   * replay RE-ARMS (ON CONFLICT DO UPDATE) and keeps last_outcome;
//   * the self-check reads the POST-state and aborts the WHOLE file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(import.meta.dirname, '..')
const read = (name) => readFileSync(path.join(root, 'supabase/migrations', name), 'utf8')
const MIG_053 = read('053_cron_heartbeats.sql')
const MIG_773 = read('773_revolut_reconcile_heartbeat.sql')
const ROUTE = readFileSync(path.join(root, 'src/app/api/cron/revolut-reconcile/route.js'), 'utf8')
const NAME = 'revolut-reconcile'

let db
const runSql = (text) => db.exec(text)
const row = async () => (await db.query(
  `SELECT name, expected_interval_seconds, grace_seconds, notes, last_ok_at, last_outcome FROM public.cron_heartbeats WHERE name = $1`, [NAME],
)).rows[0]
const staleAfter = async (seconds) => {
  await db.query(`UPDATE public.cron_heartbeats SET last_ok_at = now() - ($2::int * interval '1 second') WHERE name = $1`, [NAME, seconds])
  return (await db.query(`SELECT is_stale FROM public.cron_health WHERE name = $1`, [NAME])).rows[0].is_stale
}

beforeEach(async () => {
  db = new PGlite()
  await runSql('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;')
  await runSql(MIG_053)
  await runSql('ALTER TABLE public.cron_heartbeats ADD COLUMN last_outcome JSONB;')
}, 60_000)

afterEach(async () => { await db?.close() })

describe('mig 773 seeds the reconcile row', () => {
  it('under the name the route stamps, on the */15 cadence, born healthy', async () => {
    expect(ROUTE).toMatch(/const HEARTBEAT = 'revolut-reconcile'/)
    expect(ROUTE).toMatch(/stampHeartbeat\(HEARTBEAT, counts\)/)
    await runSql(MIG_773)
    expect(await row()).toMatchObject({
      expected_interval_seconds: 900, grace_seconds: 1200,
      notes: 'REVPAY.3 backstop: settles Revolut payments whose webhook never landed',
    })
    expect((await db.query(`SELECT is_stale FROM public.cron_health WHERE name = $1`, [NAME])).rows[0].is_stale).toBe(false)
  })

  it('says in its header that it is applied right AFTER the deploy', () => {
    expect(MIG_773).toMatch(/APPLY THIS MIGRATION RIGHT AFTER THE REVPAY\.3 CODE DEPLOYS/)
  })

  it('one missed tick never pages; 35 minutes without a clean run does', async () => {
    await runSql(MIG_773)
    // One missed tick: ~30 min between stamps plus a 5-min maxDuration run.
    expect(await staleAfter(30 * 60 + 60)).toBe(false)
    expect(await staleAfter(34 * 60)).toBe(false)
    expect(await staleAfter(36 * 60)).toBe(true)
  })

  it('replay re-arms a stale row and keeps last_outcome', async () => {
    await runSql(MIG_773)
    const outcome = { candidates: 3, checked: 2, settled: 1, errors: 0 }
    await db.query(`UPDATE public.cron_heartbeats SET last_outcome = $2::jsonb, grace_seconds = 60 WHERE name = $1`, [NAME, JSON.stringify(outcome)])
    expect(await staleAfter(60 * 60)).toBe(true)
    await runSql(MIG_773)
    const r = await row()
    expect(r).toMatchObject({ expected_interval_seconds: 900, grace_seconds: 1200, last_outcome: outcome })
    expect(Date.now() - new Date(r.last_ok_at).getTime()).toBeLessThan(5_000)
    expect((await db.query(`SELECT count(*)::int AS n FROM public.cron_heartbeats WHERE name = $1`, [NAME])).rows[0].n).toBe(1)
  })

  it('a row that does not END UP on 900 + 1200 aborts the WHOLE file', async () => {
    await runSql(`
      CREATE FUNCTION public.bend_grace() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'revolut-reconcile' THEN NEW.grace_seconds := 60; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bend_grace BEFORE INSERT OR UPDATE ON public.cron_heartbeats
        FOR EACH ROW EXECUTE FUNCTION public.bend_grace();
    `)
    await expect(runSql(MIG_773)).rejects.toThrow(/mig 773: cron_heartbeats row revolut-reconcile .*900.*1200/)
    expect(await row()).toBeUndefined()
  })
})
