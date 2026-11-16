// STALEWATCH.1 — behavioural test for migration 843 (and the 844 seed). Boots
// PGlite with cron_heartbeats and the cron_health view as live (16 Nov 2026),
// runs the REAL files. Fictional names only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const mig = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')

const BASE = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.cron_heartbeats (
    name text PRIMARY KEY,
    last_ok_at timestamptz NOT NULL DEFAULT now(),
    expected_interval_seconds integer NOT NULL,
    grace_seconds integer NOT NULL DEFAULT 60,
    notes text,
    last_outcome jsonb
  );
  CREATE VIEW public.cron_health WITH (security_invoker = on) AS
    SELECT name, last_ok_at, expected_interval_seconds, grace_seconds,
      EXTRACT(epoch FROM now() - last_ok_at)::integer AS stale_seconds,
      expected_interval_seconds + grace_seconds AS max_allowed_seconds,
      (now() - last_ok_at) > make_interval(secs => (expected_interval_seconds + grace_seconds)::double precision) AS is_stale
    FROM public.cron_heartbeats;
  GRANT SELECT ON public.cron_health TO service_role;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.cron_health TO authenticated;
  INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds)
    VALUES ('old-job', now() - interval '3 days', 3600, 600), ('fresh-job', now(), 3600, 600);
`

let db
beforeEach(async () => {
  db = new PGlite()
  await db.exec(BASE)
  await db.exec(mig('843_cron_heartbeat_acknowledge_and_alert_state.sql'))
})
afterEach(async () => { await db.close() })

const health = async (name) => (await db.query('SELECT * FROM public.cron_health WHERE name = $1', [name])).rows[0]

describe('843 — acknowledge and alert state', () => {
  it('keeps the old columns first and adds the new ones at the end', async () => {
    const h = await health('old-job')
    expect(Object.keys(h).slice(0, 7)).toEqual(['name', 'last_ok_at', 'expected_interval_seconds', 'grace_seconds', 'stale_seconds', 'max_allowed_seconds', 'is_stale'])
    expect(h).toMatchObject({ is_stale: true, is_acknowledged: false, acknowledged_until: null, stale_alerted_at: null })
  })

  it('an acknowledgement in the future reads as acknowledged, and one in the past does not', async () => {
    await db.exec("UPDATE public.cron_heartbeats SET acknowledged_until = now() + interval '7 days', acknowledged_note = 'known' WHERE name = 'old-job'")
    expect(await health('old-job')).toMatchObject({ is_acknowledged: true, acknowledged_note: 'known' })
    await db.exec("UPDATE public.cron_heartbeats SET acknowledged_until = now() - interval '1 hour' WHERE name = 'old-job'")
    expect((await health('old-job')).is_acknowledged).toBe(false)
  })

  it('the view stays security_invoker, readable by the server and closed to clients', async () => {
    const { rows } = await db.query("SELECT reloptions FROM pg_class WHERE oid = 'public.cron_health'::regclass")
    expect(rows[0].reloptions).toContain('security_invoker=on')
    const { rows: g } = await db.query("SELECT has_table_privilege('service_role', 'public.cron_health', 'SELECT') AS ok, has_table_privilege('authenticated', 'public.cron_health', 'SELECT') AS client")
    expect(g[0]).toEqual({ ok: true, client: false })
  })

  it('844 seeds the watchdog row healthy, and re-running it is safe', async () => {
    await db.exec(mig('844_stale_job_watchdog_heartbeat.sql'))
    await db.exec(mig('844_stale_job_watchdog_heartbeat.sql'))
    expect(await health('stale-job-watchdog')).toMatchObject({ is_stale: false, expected_interval_seconds: 900, grace_seconds: 1800 })
  })

  it('re-running 843 is safe', async () => {
    await db.exec(mig('843_cron_heartbeat_acknowledge_and_alert_state.sql'))
    expect((await health('fresh-job')).is_stale).toBe(false)
  })
})
