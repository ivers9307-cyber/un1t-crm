// SCREENMODE.1 — behavioural test for migration 765 (the 'screen' role on
// fleet_devices and the columns that carry a screen's display link, last
// heartbeat, reported mode and manual override).
//
// PGlite (PostgreSQL 17): the tables mig 765 touches, reduced to what it
// needs (locations; tv_displays as mig 160 made it; fleet_devices as mig 474
// made it), then the real 765 file. Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const SQL = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/765_fleet_screens.sql'), 'utf8')

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const TV = 'b0000000-0000-0000-0000-00000000000b'

const SETUP_SQL = `
    CREATE TABLE public.locations (id uuid PRIMARY KEY);
    INSERT INTO public.locations VALUES ('${LOC}');

    CREATE TABLE public.tv_displays (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
      label text NOT NULL,
      token text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
      active boolean NOT NULL DEFAULT true);
    INSERT INTO public.tv_displays (id, location_id, label) VALUES ('${TV}', '${LOC}', 'Hatch screen 1');

    CREATE TABLE public.fleet_devices (
      device_name     TEXT PRIMARY KEY,
      location_id     UUID REFERENCES public.locations(id) ON DELETE RESTRICT,
      role            TEXT CHECK (role IN ('kiosk', 'bridge')),
      label           TEXT,
      api_token_hash  TEXT,
      token_issued_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW());
`

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)

beforeAll(async () => {
  db = new PGlite()
  await runSql(SETUP_SQL)
  await runSql(SQL)
}, 60_000)
afterAll(() => db?.close())

describe('mig 765 — the screen role on fleet_devices', () => {
  it("role accepts 'screen' and still refuses a made-up role", async () => {
    await db.query(`INSERT INTO public.fleet_devices (device_name, location_id, role) VALUES ('hatch-screen1', '${LOC}', 'screen')`)
    await expect(db.query(`INSERT INTO public.fleet_devices (device_name, role) VALUES ('x', 'toaster')`)).rejects.toMatchObject({ code: '23514' })
  })

  it('still admits the two roles mig 474 allowed, and an unclaimed (NULL) role', async () => {
    await db.query(`INSERT INTO public.fleet_devices (device_name, location_id, role) VALUES ('hatch-tv1', '${LOC}', 'kiosk')`)
    await db.query(`INSERT INTO public.fleet_devices (device_name, location_id, role) VALUES ('hatch-bridge', '${LOC}', 'bridge')`)
    await db.query(`INSERT INTO public.fleet_devices (device_name) VALUES ('unclaimed')`)
  })

  it('a screen links to a display and the link clears when the display is deleted', async () => {
    await db.query(`UPDATE public.fleet_devices SET tv_display_id = '${TV}' WHERE device_name = 'hatch-screen1'`)
    await db.query(`DELETE FROM public.tv_displays WHERE id = '${TV}'`)
    const { rows } = await db.query(`SELECT tv_display_id FROM public.fleet_devices WHERE device_name = 'hatch-screen1'`)
    expect(rows[0].tv_display_id).toBeNull()
  })

  it('reported_mode and override_mode are CHECKed', async () => {
    await expect(db.query(`UPDATE public.fleet_devices SET reported_mode = 'off' WHERE device_name = 'hatch-screen1'`)).rejects.toMatchObject({ code: '23514' })
    await expect(db.query(`UPDATE public.fleet_devices SET override_mode = 'unknown' WHERE device_name = 'hatch-screen1'`)).rejects.toMatchObject({ code: '23514' })
    // The accepted values land.
    await db.query(`UPDATE public.fleet_devices SET reported_mode = 'unknown', reported_version = '1.0.0', last_heartbeat_at = now() WHERE device_name = 'hatch-screen1'`)
    for (const m of ['class_app', 'marketing']) {
      await db.query(`UPDATE public.fleet_devices SET reported_mode = '${m}', override_mode = '${m}', override_until = now() + interval '1 hour' WHERE device_name = 'hatch-screen1'`)
    }
    const { rows } = await db.query(`SELECT reported_mode, override_mode FROM public.fleet_devices WHERE device_name = 'hatch-screen1'`)
    expect(rows[0]).toEqual({ reported_mode: 'marketing', override_mode: 'marketing' })
  })

  it('all six columns are nullable, so existing kiosk and bridge rows are untouched', async () => {
    const { rows } = await db.query(`
      SELECT tv_display_id, last_heartbeat_at, reported_mode, reported_version, override_mode, override_until
        FROM public.fleet_devices WHERE device_name = 'hatch-tv1'`)
    expect(rows[0]).toEqual({
      tv_display_id: null, last_heartbeat_at: null, reported_mode: null,
      reported_version: null, override_mode: null, override_until: null,
    })
  })

  it('indexes screens by location, partial on role = screen', async () => {
    const { rows } = await db.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'fleet_devices_screen_idx'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toContain('(location_id)')
    expect(rows[0].indexdef).toContain(`'screen'`)
  })

  it('seeds nothing and writes no grants', async () => {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.fleet_devices WHERE device_name LIKE 'hatch-screen%'`)
    expect(rows[0].n).toBe(1) // only the one this test inserted
    const g = await db.query(`
      SELECT count(*)::int AS n FROM information_schema.table_privileges
       WHERE table_name = 'fleet_devices' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`)
    expect(g.rows[0].n).toBe(0)
  })

  it('the file is re-runnable', async () => {
    await expect(runSql(SQL)).resolves.toBeDefined()
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.fleet_devices'::regclass AND contype = 'c'`)
    expect(rows[0].n).toBe(3)
  })

  it('aborts when the role CHECK does not admit screen', async () => {
    const probe = new PGlite()
    try {
      await probe['exec'](SETUP_SQL)
      const broken = SQL.replace("CHECK (role IN ('kiosk', 'bridge', 'screen'))", "CHECK (role IN ('kiosk', 'bridge'))")
      expect(broken).not.toBe(SQL)
      await expect(probe['exec'](broken)).rejects.toThrow(/does not admit screen/)
    } finally {
      await probe.close()
    }
  })
})
