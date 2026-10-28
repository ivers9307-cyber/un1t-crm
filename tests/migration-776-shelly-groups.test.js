// SHELLYGROUPS.2 — behavioural test for migration 776 (shelly_groups + group_id).
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) through tests/helpers/member-write-
// sweep.js (Supabase's default privileges, the private helpers) and adds
// shelly_devices reduced to the columns the checks touch, with mig 562's RLS
// on. It proves:
//
//   * shelly_groups is service_role only: no client privilege (anon,
//     authenticated, PUBLIC; table and column level), RLS on, no policy;
//   * the same-location trigger refuses a group from another location on
//     INSERT, on UPDATE OF group_id and on UPDATE OF location_id, and lets a
//     NULL group and a same-location group through;
//   * a group's location_id never changes (members would be stranded);
//   * deleting a group nulls group_id and keeps the device; deleting the
//     location takes its groups with it;
//   * (location_id, name) is unique (23505), the name, icon and schedule_mode
//     CHECKs hold;
//   * the self-check aborts the whole file without its REVOKE and on a
//     policy, and a second run is a no-op.
//
// Every describe runs in BOTH prod states (before and after mig 677).
// Fictional ids only: the repo is public.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, policiesOf, clientPrivileges, rlsOn, serviceRoleDml, abortMessage,
  IDS, denied, PROD_STATES } from './helpers/member-write-sweep.js'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/776_shelly_groups.sql'), 'utf8')
const T = 'shelly_groups'
const DEV_A = '77600000-0000-0000-0000-00000000000a'
const DEV_B = '77600000-0000-0000-0000-00000000000b'
const GRP_A = '77600000-0000-0000-0000-0000000000a1'
const GRP_B = '77600000-0000-0000-0000-0000000000b1'

// shelly_devices as mig 562 made it, reduced to the columns these checks use.
const TABLES = `
  CREATE TABLE public.shelly_devices (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    device_id   text NOT NULL,
    channel     smallint NOT NULL DEFAULT 0,
    name        text,
    CONSTRAINT shelly_devices_device_channel_unique UNIQUE (device_id, channel)
  );
  ALTER TABLE public.shelly_devices ENABLE ROW LEVEL SECURITY;
`
const SEED = `
  INSERT INTO public.shelly_devices (id, location_id, device_id) VALUES
    ('${DEV_A}', '${IDS.LOC_A}', 'aabbccddee01'),
    ('${DEV_B}', '${IDS.LOC_B}', 'aabbccddee02');
`
const GROUPS = `
  INSERT INTO public.shelly_groups (id, location_id, name) VALUES
    ('${GRP_A}', '${IDS.LOC_A}', 'Gym floor'),
    ('${GRP_B}', '${IDS.LOC_B}', 'Gym floor');
`
const OPEN_POLICY = `CREATE POLICY sg_open ON public.shelly_groups FOR ALL TO authenticated USING (true) WITH CHECK (true);`

const bootAt = (state, extra = {}) => boot({ tables: TABLES, policies: '', seed: SEED, after677: state.after677, ...extra })
const migrated = async (state) => {
  const db = await bootAt(state, { migrate: [MIG] })
  await db.exec(GROUPS)
  return db
}

/** Run SQL; return the Postgres error { code, message } it raised, or null. */
async function pgError(db, sql) {
  try {
    await db.exec(sql)
    return null
  } catch (e) {
    return { code: e.code, message: String(e.message || e) }
  }
}

describe.each(PROD_STATES)('mig 776 — $label', (state) => {
  it('shelly_groups is service_role only: no client privilege, RLS on, no policy', async () => {
    const db = await bootAt(state, { migrate: [MIG] })
    expect(await clientPrivileges(db, T)).toEqual([])
    const { rows } = await db.query(
      `SELECT grantee, privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = $1 AND grantee IN ('anon', 'authenticated', 'PUBLIC')`, [T])
    expect(rows).toEqual([])
    expect(await rlsOn(db, T)).toBe(true)
    expect(await policiesOf(db, [T])).toEqual([])
    expect(await serviceRoleDml(db, T)).toBe(true)
    await db.close()
  })

  it('signed-in and anon sessions are refused by the grant, even with a permissive policy', async () => {
    const db = await migrated(state)
    await db.exec(OPEN_POLICY)
    for (const stmt of [
      `SELECT id FROM public.${T}`,
      `INSERT INTO public.${T} (location_id, name) VALUES ('${IDS.LOC_A}', 'Studio')`,
      `UPDATE public.${T} SET name = 'x' WHERE id = '${GRP_A}'`,
      `DELETE FROM public.${T} WHERE id = '${GRP_A}'`,
    ]) {
      await expect(asUser(db, IDS.OWNER_A, stmt), stmt).rejects.toThrow(denied(T))
      await expect(asRole(db, 'anon', stmt), stmt).rejects.toThrow(denied(T))
    }
    await db.close()
  })

  it('defaults: icon bulb, sort 0, disabled, mode none, empty windows and rule', async () => {
    const db = await migrated(state)
    const { rows } = await db.query(
      `SELECT icon, sort_order, enabled, schedule_mode, fixed_windows, class_rule, override, last_applied, created_by
         FROM public.shelly_groups WHERE id = $1`, [GRP_A])
    expect(rows).toEqual([{ icon: 'bulb', sort_order: 0, enabled: false, schedule_mode: 'none',
      fixed_windows: [], class_rule: {}, override: null, last_applied: null, created_by: null }])
    await db.close()
  })

  it('a device takes a group at its own location, and NULL', async () => {
    const db = await migrated(state)
    expect(await pgError(db, `UPDATE public.shelly_devices SET group_id = '${GRP_A}' WHERE id = '${DEV_A}'`)).toBeNull()
    expect(await pgError(db, `UPDATE public.shelly_devices SET group_id = NULL WHERE id = '${DEV_A}'`)).toBeNull()
    expect(await pgError(db,
      `INSERT INTO public.shelly_devices (location_id, device_id, group_id) VALUES ('${IDS.LOC_A}', 'aabbccddee03', '${GRP_A}')`)).toBeNull()
    await db.close()
  })

  it('a group from another location is refused on insert, on group_id and on location_id', async () => {
    const db = await migrated(state)
    const viaInsert = await pgError(db,
      `INSERT INTO public.shelly_devices (location_id, device_id, group_id) VALUES ('${IDS.LOC_A}', 'aabbccddee04', '${GRP_B}')`)
    expect(viaInsert?.code).toBe('23514')
    expect(viaInsert?.message).toMatch(/shelly group .* belongs to another location/)

    const viaGroup = await pgError(db, `UPDATE public.shelly_devices SET group_id = '${GRP_B}' WHERE id = '${DEV_A}'`)
    expect(viaGroup?.code).toBe('23514')

    await db.exec(`UPDATE public.shelly_devices SET group_id = '${GRP_A}' WHERE id = '${DEV_A}'`)
    const viaLocation = await pgError(db, `UPDATE public.shelly_devices SET location_id = '${IDS.LOC_B}' WHERE id = '${DEV_A}'`)
    expect(viaLocation?.code).toBe('23514')

    const { rows } = await db.query(`SELECT location_id, group_id FROM public.shelly_devices WHERE id = $1`, [DEV_A])
    expect(rows).toEqual([{ location_id: IDS.LOC_A, group_id: GRP_A }])
    await db.close()
  })

  it('an unrelated device update still passes with a group set', async () => {
    const db = await migrated(state)
    await db.exec(`UPDATE public.shelly_devices SET group_id = '${GRP_A}' WHERE id = '${DEV_A}'`)
    expect(await pgError(db, `UPDATE public.shelly_devices SET name = 'Mirror lights' WHERE id = '${DEV_A}'`)).toBeNull()
    await db.close()
  })

  it('a group never moves location', async () => {
    const db = await migrated(state)
    const err = await pgError(db, `UPDATE public.shelly_groups SET location_id = '${IDS.LOC_B}' WHERE id = '${GRP_A}'`)
    expect(err?.code).toBe('23514')
    expect(err?.message).toMatch(/never moves location/)
    expect(await pgError(db, `UPDATE public.shelly_groups SET name = 'Main floor', sort_order = 2 WHERE id = '${GRP_A}'`)).toBeNull()
    await db.close()
  })

  it('deleting a group nulls group_id and keeps the device', async () => {
    const db = await migrated(state)
    await db.exec(`UPDATE public.shelly_devices SET group_id = '${GRP_A}' WHERE id = '${DEV_A}'`)
    await db.exec(`DELETE FROM public.shelly_groups WHERE id = '${GRP_A}'`)
    const { rows } = await db.query(`SELECT id, group_id FROM public.shelly_devices WHERE id = $1`, [DEV_A])
    expect(rows).toEqual([{ id: DEV_A, group_id: null }])
    await db.close()
  })

  it('deleting a location takes its groups with it', async () => {
    const db = await migrated(state)
    await db.exec(`DELETE FROM public.shelly_devices WHERE location_id = '${IDS.LOC_B}'`)
    await db.exec(`DELETE FROM public.locations WHERE id = '${IDS.LOC_B}'`)
    const { rows } = await db.query(`SELECT id FROM public.shelly_groups ORDER BY id`)
    expect(rows).toEqual([{ id: GRP_A }])
    await db.close()
  })

  it('a duplicate name at one location is 23505; the same name at another is fine', async () => {
    const db = await migrated(state)
    const dup = await pgError(db, `INSERT INTO public.shelly_groups (location_id, name) VALUES ('${IDS.LOC_A}', 'Gym floor')`)
    expect(dup?.code).toBe('23505')
    // GROUPS already put 'Gym floor' at both A and B.
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.shelly_groups WHERE name = 'Gym floor'`)
    expect(rows[0].n).toBe(2)
    await db.close()
  })

  it.each([
    ['an empty name', `INSERT INTO public.shelly_groups (location_id, name) VALUES ('${IDS.LOC_A}', '')`],
    ['a 61-character name', `INSERT INTO public.shelly_groups (location_id, name) VALUES ('${IDS.LOC_A}', repeat('x', 61))`],
    ['an unknown icon', `INSERT INTO public.shelly_groups (location_id, name, icon) VALUES ('${IDS.LOC_A}', 'Lamps', 'lamp')`],
    ['an unknown schedule_mode', `INSERT INTO public.shelly_groups (location_id, name, schedule_mode) VALUES ('${IDS.LOC_A}', 'Lamps', 'sunset')`],
  ])('the CHECKs refuse %s', async (_label, sql) => {
    const db = await migrated(state)
    expect((await pgError(db, sql))?.code).toBe('23514')
    await db.close()
  })

  it('the CHECKs accept a 60-character name and every icon', async () => {
    const db = await migrated(state)
    expect(await pgError(db, `INSERT INTO public.shelly_groups (location_id, name) VALUES ('${IDS.LOC_A}', repeat('x', 60))`)).toBeNull()
    for (const icon of ['bulb', 'fan', 'tv', 'plug', 'droplet']) {
      expect(await pgError(db,
        `INSERT INTO public.shelly_groups (location_id, name, icon) VALUES ('${IDS.LOC_A}', 'Icon ${icon}', '${icon}')`), icon).toBeNull()
    }
    await db.close()
  })

  it('a second run is a no-op', async () => {
    const db = await migrated(state)
    await db.exec(`UPDATE public.shelly_devices SET group_id = '${GRP_A}' WHERE id = '${DEV_A}'`)
    expect(await abortMessage(db, MIG)).toBeNull()
    const { rows } = await db.query(`SELECT group_id FROM public.shelly_devices WHERE id = $1`, [DEV_A])
    expect(rows).toEqual([{ group_id: GRP_A }])
    const { rows: groups } = await db.query(`SELECT count(*)::int AS n FROM public.shelly_groups`)
    expect(groups[0].n).toBe(2)
    expect(await clientPrivileges(db, T)).toEqual([])
    const { rows: trig } = await db.query(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'shelly_devices_group_same_location' AND NOT tgisinternal`)
    expect(trig[0].n).toBe(1)
    await db.close()
  })

  it('the self-check aborts the whole file on a policy', async () => {
    const db = await bootAt(state, { migrate: [MIG] })
    await db.exec(OPEN_POLICY)
    expect(await abortMessage(db, MIG)).toMatch(/should have no policy: sg_open/)
    await db.close()
  })
})

describe('mig 776 — before 677 only', () => {
  it('the file without its REVOKE aborts on its own self-check, and rolls back whole', async () => {
    const mutant = MIG.replace(/^REVOKE ALL ON public\.shelly_groups FROM anon, authenticated, PUBLIC;$/m, '')
    expect(mutant).not.toBe(MIG)
    const db = await bootAt(PROD_STATES[0])
    expect(await abortMessage(db, mutant)).toMatch(/client roles still hold privileges on public\.shelly_groups/)
    const { rows } = await db.query(`SELECT to_regclass('public.shelly_groups') AS t`)
    expect(rows[0].t).toBeNull()
    const { rows: col } = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'shelly_devices' AND column_name = 'group_id'`)
    expect(col[0].n).toBe(0)
    await db.close()
  })
})
