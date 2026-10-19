// UN1TRADAR.2 — migration 749 deletes Hatch Street's Glofox-shaped snapshot
// history (spec B §6 "Legacy rows", Claude's call 8). A text guard on the file,
// then PGlite runs it against stub tables: the un1t.online location by
// membership_source, the boundary row, and every self-check.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const DIR = path.resolve(import.meta.dirname, '../supabase/migrations')
const readMigration = (re) => {
  const name = readdirSync(DIR).find((f) => re.test(f))
  if (!name) throw new Error(`no migration matching ${re}`)
  return { name, sql: readFileSync(path.join(DIR, name), 'utf8') }
}
const { name: FILE, sql: SQL } = readMigration(/hatch_drop_glofox_shaped_snapshots/)
// The guard reads statements, not the header prose.
const CODE = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('migration file', () => {
  it('is number 749', () => expect(FILE).toBe('749_hatch_drop_glofox_shaped_snapshots.sql'))
  it('migration is DML only, scoped by membership_source, self-checking', () => {
    expect(CODE).toMatch(/membership_source\s*=\s*'un1t_online'/)
    expect(CODE.match(/RAISE EXCEPTION/g).length).toBeGreaterThanOrEqual(5)
    expect(CODE).toMatch(/RAISE NOTICE/)
    expect(CODE).not.toMatch(/\b(CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE)\b/i)
    expect(CODE).toMatch(/2026-10-18/)
  })
})

const HATCH = '28c78d6b-0000-4000-8000-000000000001'
const STILL = '28c78d6b-0000-4000-8000-000000000002'
let db

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE public.locations (id uuid PRIMARY KEY, membership_source text);
    CREATE TABLE public.membership_snapshots (id serial PRIMARY KEY, location_id uuid, snapshot_date date, total_members int);
    CREATE TABLE public.churn_radar_snapshots (id serial PRIMARY KEY, location_id uuid, captured_at timestamptz);
    CREATE TABLE public.lead_radar_snapshots (id serial PRIMARY KEY, location_id uuid, captured_at timestamptz);
    INSERT INTO public.locations VALUES ('${HATCH}', 'un1t_online'), ('${STILL}', 'glofox');
    INSERT INTO public.membership_snapshots (location_id, snapshot_date, total_members) VALUES
      ('${HATCH}', '2026-10-10', 0), ('${HATCH}', '2026-10-17', 0), ('${HATCH}', '2026-10-18', 26), ('${HATCH}', '2026-10-19', 26),
      ('${STILL}', '2026-06-02', 900), ('${STILL}', '2026-10-17', 1000);
    INSERT INTO public.churn_radar_snapshots (location_id, captured_at) VALUES
      ('${HATCH}', '2026-09-28 06:00+00'), ('${HATCH}', '2026-10-05 06:00+00'), ('${STILL}', '2026-10-05 06:00+00');
    INSERT INTO public.lead_radar_snapshots (location_id, captured_at) VALUES
      ('${HATCH}', '2026-10-05 06:30+00'), ('${STILL}', '2026-10-05 06:30+00');
  `)
}, 60_000)
afterEach(async () => { await db?.close() })

const count = async (table, loc) => (await db.query(`SELECT count(*)::int AS n FROM public.${table} WHERE location_id = $1`, [loc])).rows[0].n

describe('running the migration', () => {
  it('deletes Hatch radar history and pre-boundary membership rows; keeps the boundary row on and every other studio', async () => {
    await db.exec(SQL)
    expect(await count('churn_radar_snapshots', HATCH)).toBe(0)
    expect(await count('lead_radar_snapshots', HATCH)).toBe(0)
    const left = (await db.query(`SELECT snapshot_date::text AS d FROM public.membership_snapshots WHERE location_id = $1 ORDER BY 1`, [HATCH])).rows.map((r) => r.d)
    expect(left).toEqual(['2026-10-18', '2026-10-19'])
    expect(await count('membership_snapshots', STILL)).toBe(2)
    expect(await count('churn_radar_snapshots', STILL)).toBe(1)
    expect(await count('lead_radar_snapshots', STILL)).toBe(1)
  })

  it('aborts when more than one location is on un1t.online', async () => {
    await db.exec(`UPDATE public.locations SET membership_source = 'un1t_online' WHERE id = '${STILL}'`)
    await expect(db.exec(SQL)).rejects.toThrow(/exactly one/)
  })

  it('a database with no un1t.online location (a fresh replay) is a no-op, not an error', async () => {
    await db.exec(`UPDATE public.locations SET membership_source = 'glofox'`)
    await expect(db.exec(SQL)).resolves.toBeDefined()
    expect(await count('membership_snapshots', HATCH)).toBe(4)
    expect(await count('churn_radar_snapshots', HATCH)).toBe(2)
    expect(await count('lead_radar_snapshots', HATCH)).toBe(1)
    expect(await count('membership_snapshots', STILL)).toBe(2)
  })

  it('refuses a location with real pre-boundary members (membership_source pointed at the wrong studio); nothing deleted', async () => {
    // an operator flips Stillorgan to un1t_online and Hatch off it; Stillorgan's
    // pre-boundary history has members, so it is not Glofox-shaped noise
    await db.exec(`UPDATE public.locations SET membership_source = CASE WHEN id = '${STILL}' THEN 'un1t_online' ELSE 'glofox' END`)
    await db.exec(`INSERT INTO public.membership_snapshots (location_id, snapshot_date, total_members) VALUES ('${STILL}', '2026-10-18', 1000)`)
    await expect(db.exec(SQL)).rejects.toThrow(/total_members > 0/)
    expect(await count('membership_snapshots', STILL)).toBe(3)
    expect(await count('churn_radar_snapshots', STILL)).toBe(1)
    expect(await count('lead_radar_snapshots', STILL)).toBe(1)
  })

  it('refuses when even one pre-boundary row at Hatch has members (nothing deleted)', async () => {
    await db.exec(`UPDATE public.membership_snapshots SET total_members = 3 WHERE location_id = '${HATCH}' AND snapshot_date = '2026-10-10'`)
    await expect(db.exec(SQL)).rejects.toThrow(/total_members > 0/)
    expect(await count('membership_snapshots', HATCH)).toBe(4)
    expect(await count('churn_radar_snapshots', HATCH)).toBe(2)
  })

  it('aborts when the first un1t-shaped membership row is missing (nothing deleted)', async () => {
    await db.exec(`DELETE FROM public.membership_snapshots WHERE location_id = '${HATCH}' AND snapshot_date = '2026-10-18'`)
    await expect(db.exec(SQL)).rejects.toThrow(/2026-10-18/)
    expect(await count('churn_radar_snapshots', HATCH)).toBe(2)
  })

  it('aborts when a radar row at Hatch is on or after the boundary', async () => {
    await db.exec(`INSERT INTO public.churn_radar_snapshots (location_id, captured_at) VALUES ('${HATCH}', '2026-10-19 06:00+00')`)
    await expect(db.exec(SQL)).rejects.toThrow(/on or after/)
    expect(await count('membership_snapshots', HATCH)).toBe(4)
  })

  it('aborts when the 2026-10-18 row is still Glofox-shaped (no members)', async () => {
    await db.exec(`UPDATE public.membership_snapshots SET total_members = 0 WHERE location_id = '${HATCH}' AND snapshot_date = '2026-10-18'`)
    await expect(db.exec(SQL)).rejects.toThrow(/members > 0/)
  })

  it('is safe to re-run (the second run deletes nothing)', async () => {
    await db.exec(SQL)
    await db.exec(SQL)
    expect(await count('membership_snapshots', HATCH)).toBe(2)
  })
})
