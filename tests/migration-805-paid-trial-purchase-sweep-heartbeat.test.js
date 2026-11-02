// PAIDTRIALTRIGGER.1 — behavioural test for migration 805 (the 757/791 pattern).
//
// Boots PGlite, runs the REAL mig 053 (cron_heartbeats + cron_health), adds mig
// 315's last_outcome column, runs 805, and proves:
//   * the row exists under the name the route stamps (read from the code);
//   * two missed ticks never page, three do (the welcome sweep's sizing);
//   * replay RE-ARMS (ON CONFLICT DO UPDATE) and keeps last_outcome;
//   * the self-check reads the POST-state and aborts the WHOLE file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(import.meta.dirname, '..')
const read = (name) => readFileSync(path.join(root, 'supabase/migrations', name), 'utf8')
const MIG_053 = read('053_cron_heartbeats.sql')
const MIG_805 = read('805_un1t_paid_trial_purchase_sweep_heartbeat.sql')
const ROUTE = readFileSync(path.join(root, 'src/app/api/cron/un1t-online-sync/route.js'), 'utf8')
const NAME = 'un1t-paid-trial-purchase-sweep'

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

describe('mig 805 seeds the €39 purchase sweep arm row', () => {
  it('under the name the route stamps, on the */15 cadence, born healthy', async () => {
    expect(ROUTE).toMatch(new RegExp(`PURCHASE_HEARTBEAT = '${NAME}'`))
    expect(ROUTE).toMatch(/stampHeartbeat\(PURCHASE_HEARTBEAT, purchaseTotals\)/)
    await runSql(MIG_805)
    const r = await row()
    expect(r).toMatchObject({ expected_interval_seconds: 900, grace_seconds: 1800 })
    expect(r.notes).toMatch(/un1t-online-sync/)
    expect(r.notes).toMatch(/sweepPaidTrialPurchases/)
    expect((await db.query(`SELECT is_stale FROM public.cron_health WHERE name = $1`, [NAME])).rows[0].is_stale).toBe(false)
  })

  it('is sized for the parent cron\'s schedule (a change to it re-sizes this row in the same PR)', () => {
    const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'))
    expect(vercel.crons.filter((c) => c.path === '/api/cron/un1t-online-sync').map((c) => c.schedule)).toEqual(['*/15 * * * *'])
  })

  it('says in its header that it is applied right AFTER the deploy', () => {
    expect(MIG_805).toMatch(/APPLY THIS MIGRATION RIGHT AFTER THE CODE DEPLOYS/)
  })

  it('two missed ticks never page; three do', async () => {
    await runSql(MIG_805)
    expect(await staleAfter(30 * 60)).toBe(false)
    expect(await staleAfter(44 * 60)).toBe(false)
    expect(await staleAfter(46 * 60)).toBe(true)
  })

  it('replay re-arms a stale row and keeps last_outcome', async () => {
    await runSql(MIG_805)
    const outcome = { locations: 1, checked: 2, enrolled: 1, already: 1, failed: 0 }
    await db.query(`UPDATE public.cron_heartbeats SET last_outcome = $2::jsonb, grace_seconds = 60 WHERE name = $1`, [NAME, JSON.stringify(outcome)])
    expect(await staleAfter(60 * 60)).toBe(true)
    await runSql(MIG_805)
    const r = await row()
    expect(r).toMatchObject({ expected_interval_seconds: 900, grace_seconds: 1800, last_outcome: outcome })
    expect(Date.now() - new Date(r.last_ok_at).getTime()).toBeLessThan(5_000)
    expect((await db.query(`SELECT count(*)::int AS n FROM public.cron_heartbeats WHERE name = $1`, [NAME])).rows[0].n).toBe(1)
  })

  it('a row that does not END UP on 900 + 1800 aborts the WHOLE file', async () => {
    await runSql(`
      CREATE FUNCTION public.bend_grace() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = 'un1t-paid-trial-purchase-sweep' THEN NEW.grace_seconds := 60; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bend_grace BEFORE INSERT OR UPDATE ON public.cron_heartbeats
        FOR EACH ROW EXECUTE FUNCTION public.bend_grace();
    `)
    await expect(runSql(MIG_805)).rejects.toThrow(/mig 805: cron_heartbeats row un1t-paid-trial-purchase-sweep .*900.*1800/)
    expect(await row()).toBeUndefined()
  })
})
