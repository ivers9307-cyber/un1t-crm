// TZ.6 — mig 720: the cron_daily_slot_claims table (closed to clients, the
// scope/location rule, the at-most-once primary key), the deploy-day seed of
// legacy slots already past today, and the twelve heartbeat rows moved to an
// hourly clock behind a pre-check that refuses to land a row that would page.
// Run against PGlite with the minimal tables it touches. Fictional values only.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { DAILY_SLOTS } from '../src/lib/cron-daily-slot.js'
import { instantToZonedParts } from '../src/lib/location-time.js'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/720_cron_heartbeats_hourly_daily_slots.sql'), 'utf8')
const DUB = 'a0000000-0000-4000-8000-0000000000a1'
const NYC = 'a0000000-0000-4000-8000-0000000000a2'
const NAMES = Object.keys(DAILY_SLOTS).filter((n) => n !== 'receipt-coverage-weekly')

async function fresh({ stale = [], missing = [] } = {}) {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE TABLE public.locations (id uuid PRIMARY KEY, timezone text);
    CREATE TABLE public.cron_heartbeats (
      name text PRIMARY KEY, last_ok_at timestamptz NOT NULL DEFAULT now(),
      expected_interval_seconds int NOT NULL, grace_seconds int NOT NULL DEFAULT 60, notes text);
    INSERT INTO public.locations VALUES ('${DUB}', 'Europe/Dublin'), ('${NYC}', 'America/New_York');
    INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) VALUES
      ('receipt-coverage-weekly', 604800, 7200, 'weekly');`)
  for (const name of NAMES) {
    if (missing.includes(name)) continue
    const age = stale.includes(name) ? "now() - interval '3 hours'" : "now() - interval '10 minutes'"
    await db.query(`INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds) VALUES ($1, ${age}, 86400, 7200)`, [name])
  }
  return db
}

/** The claims the seed should write at instant `ms` (mirrors the SQL, from DAILY_SLOTS + vercel minutes). */
function expectedSeed(ms) {
  const minute = { 'notify-onboarding-pace': 30 }
  const utc = instantToZonedParts(ms, 'UTC')
  const dub = instantToZonedParts(ms, 'Europe/Dublin')
  const out = []
  for (const [cron, slot] of Object.entries(DAILY_SLOTS)) {
    const clock = slot.anchor === 'local' ? dub : utc
    const passed = clock.minuteOfDay >= slot.hour * 60 + (minute[cron] || 0)
    if (passed && (slot.weekday == null || clock.weekday === slot.weekday)) {
      for (const scope of [DUB, 'none']) out.push(`${cron}|${scope}|${clock.dateKey}`)
    }
  }
  return out.sort()
}

describe('mig 720 — the claim table', () => {
  it('is closed to clients, RLS on, and the primary key is the at-most-once guard', async () => {
    const db = await fresh()
    await db.exec(MIG)
    const { rows: rls } = await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'cron_daily_slot_claims'`)
    expect(rls[0].relrowsecurity).toBe(true)
    const { rows: grants } = await db.query(`SELECT grantee FROM information_schema.table_privileges WHERE table_name = 'cron_daily_slot_claims' AND grantee IN ('anon','authenticated')`)
    expect(grants).toEqual([])
    await db.exec(`DELETE FROM public.cron_daily_slot_claims`)
    const ins = `INSERT INTO public.cron_daily_slot_claims (cron_name, scope, slot_day, location_id, zone) VALUES ('notify-winback', '${NYC}', '2026-11-01', '${NYC}', 'America/New_York')`
    await db.exec(ins)
    await expect(db.exec(ins)).rejects.toThrow(/duplicate key/)
  })

  it("scope is the location id, or 'none' with no location", async () => {
    const db = await fresh()
    await db.exec(MIG)
    const row = (scope, loc) => db.exec(`INSERT INTO public.cron_daily_slot_claims (cron_name, scope, slot_day, location_id, zone) VALUES ('x', '${scope}', '2026-01-01', ${loc ? `'${loc}'` : 'NULL'}, 'UTC')`)
    await row('none', null)
    await row(DUB, DUB)
    await expect(row('none', DUB)).rejects.toThrow(/check/)
    await expect(row(NYC, DUB)).rejects.toThrow(/check/)
    await expect(row(DUB, null)).rejects.toThrow(/check/)
  })
})

describe('mig 720 — the deploy-day seed', () => {
  it('claims today every legacy slot already past, for each Europe/Dublin location and "none", never another zone', async () => {
    const db = await fresh()
    const before = Date.now()
    await db.exec(MIG)
    const after = Date.now()
    const { rows } = await db.query(`SELECT cron_name, scope, slot_day::text AS day FROM public.cron_daily_slot_claims`)
    const got = rows.map((r) => `${r.cron_name}|${r.scope}|${r.day}`).sort()
    const want = expectedSeed(before)
    if (JSON.stringify(want) === JSON.stringify(expectedSeed(after))) expect(got).toEqual(want) // not across a slot boundary
    expect(got.some((k) => k.includes(NYC))).toBe(false)
  })
})

describe('mig 720 — heartbeats', () => {
  it('moves exactly the twelve rows to 3600 + 4800 and leaves receipt-coverage-weekly on its weekly clock', async () => {
    const db = await fresh()
    await db.exec(MIG)
    const { rows } = await db.query(`SELECT name, expected_interval_seconds AS i, grace_seconds AS g FROM public.cron_heartbeats ORDER BY name`)
    for (const r of rows) {
      if (r.name === 'receipt-coverage-weekly') expect([r.i, r.g]).toEqual([604800, 7200])
      else expect([r.name, r.i, r.g]).toEqual([r.name, 3600, 4800])
    }
    expect(rows).toHaveLength(13)
  })

  it('refuses (nothing applied) when a row is already older than the new window: applied too early', async () => {
    const db = await fresh({ stale: ['morning-briefing'] })
    await expect(db.exec(MIG)).rejects.toThrow(/would page on landing: morning-briefing/)
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.cron_heartbeats WHERE expected_interval_seconds = 3600`)
    expect(rows[0].n).toBe(0)
    const { rows: t } = await db.query(`SELECT to_regclass('public.cron_daily_slot_claims') AS t`)
    expect(t[0].t).toBeNull()
  })

  it('refuses when a heartbeat row is missing (a name differs from the route), nothing applied', async () => {
    const db = await fresh({ missing: ['ad-report-email'] })
    await expect(db.exec(MIG)).rejects.toThrow(/ad-report-email is missing/)
  })

  it('replays as a no-op', async () => {
    const db = await fresh()
    await db.exec(MIG)
    const { rows: a } = await db.query(`SELECT count(*)::int AS n FROM public.cron_daily_slot_claims`)
    await db.exec(MIG)
    const { rows: b } = await db.query(`SELECT count(*)::int AS n FROM public.cron_daily_slot_claims`)
    expect(b[0].n).toBe(a[0].n)
  })
})
