// HOSTPAGE.2 — migration 824 seeds the heartbeat row of the rating-request
// arm (an arm gets its own row), replayed on PGlite.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/824_event_rating_requests_heartbeat.sql'), 'utf8')
const SCHEMA = `CREATE TABLE public.cron_heartbeats (name text PRIMARY KEY, last_ok_at timestamptz, expected_interval_seconds int NOT NULL, grace_seconds int NOT NULL, notes text, last_outcome jsonb);`
let db
beforeEach(async () => { db = new PGlite(); await db.exec(SCHEMA); await db.exec(MIG) })

describe('migration 824 — event-rating-requests heartbeat row', () => {
  it('seeds the row born healthy on a daily clock with a 6h grace, naming the parent cron', async () => {
    const { rows: [r] } = await db.query(`SELECT expected_interval_seconds, grace_seconds, last_ok_at IS NOT NULL AS healthy, notes FROM public.cron_heartbeats WHERE name = 'event-rating-requests'`)
    expect(r).toMatchObject({ expected_interval_seconds: 86400, grace_seconds: 21600, healthy: true })
    expect(r.notes).toMatch(/event-reminders/)
    expect(r.notes).toMatch(/morning after/)
  })
  it('re-applies cleanly and re-arms the row', async () => {
    await db.query(`UPDATE public.cron_heartbeats SET last_ok_at = '2020-01-01' WHERE name = 'event-rating-requests'`)
    await expect(db.exec(MIG)).resolves.not.toThrow()
    const { rows: [r] } = await db.query(`SELECT last_ok_at > '2025-01-01' AS rearmed FROM public.cron_heartbeats WHERE name = 'event-rating-requests'`)
    expect(r.rearmed).toBe(true)
  })
})
