// TZ.6 — mig 720: the cron_daily_slot_claims table only. Closed to clients,
// service_role holds exactly SELECT + INSERT, the scope/location rule, the
// at-most-once primary key, no seed, and no cron_heartbeats change (the
// converted crons stamp only on a slot tick, so the rows keep their legacy
// daily/weekly clocks). Run against PGlite. Fictional values only.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/720_cron_daily_slot_claims.sql'), 'utf8')
const DUB = 'a0000000-0000-4000-8000-0000000000a1'
const NYC = 'a0000000-0000-4000-8000-0000000000a2'

async function fresh() {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE TABLE public.locations (id uuid PRIMARY KEY, timezone text);
    INSERT INTO public.locations VALUES ('${DUB}', 'Europe/Dublin'), ('${NYC}', 'America/New_York');`)
  return db
}

describe('mig 720 — the claim table', () => {
  it('RLS on; service_role holds exactly SELECT + INSERT; anon/authenticated nothing', async () => {
    const db = await fresh()
    await db.exec(MIG)
    const { rows: rls } = await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'cron_daily_slot_claims'`)
    expect(rls[0].relrowsecurity).toBe(true)
    const { rows } = await db.query(`SELECT grantee, privilege_type FROM information_schema.table_privileges
      WHERE table_name = 'cron_daily_slot_claims' AND grantee IN ('anon','authenticated','service_role') ORDER BY 1, 2`)
    expect(rows).toEqual([{ grantee: 'service_role', privilege_type: 'INSERT' }, { grantee: 'service_role', privilege_type: 'SELECT' }])
  })

  it('the primary key is the at-most-once guard (an upsert that ignores duplicates claims once)', async () => {
    const db = await fresh()
    await db.exec(MIG)
    const ins = `INSERT INTO public.cron_daily_slot_claims (cron_name, scope, slot_day, location_id, zone)
      VALUES ('notify-winback', '${NYC}', '2026-11-01', '${NYC}', 'America/New_York') ON CONFLICT (cron_name, scope, slot_day) DO NOTHING RETURNING scope`
    expect((await db.query(ins)).rows).toHaveLength(1)
    expect((await db.query(ins)).rows).toHaveLength(0)
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

  it('seeds nothing, touches no cron_heartbeats row, and replays as a no-op', async () => {
    expect(MIG).not.toMatch(/cron_heartbeats\s+(h\s+)?set|update\s+public\.cron_heartbeats|insert\s+into\s+public\.cron_heartbeats/i)
    const db = await fresh()
    await db.exec(MIG)
    await db.exec(MIG)
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.cron_daily_slot_claims`)
    expect(rows[0].n).toBe(0)
  })

  it('refuses (nothing applied) when service_role could not insert', async () => {
    const db = await fresh()
    const broken = MIG.replace('grant select, insert on public.cron_daily_slot_claims to service_role;', 'grant select on public.cron_daily_slot_claims to service_role;')
    await expect(db.exec(broken)).rejects.toThrow(/service_role cannot SELECT \+ INSERT/)
    const { rows } = await db.query(`SELECT to_regclass('public.cron_daily_slot_claims') AS t`)
    expect(rows[0].t).toBeNull()
  })
})
