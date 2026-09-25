// SNAPSHOT.1 — behavioural test for migration 634, against the REAL file.
//
// Same reason as the 613/618/622/624/628/632 replays: there is no local
// Supabase stack, so without this the DDL would get its first execution on
// prod. Boots PGlite, recreates the three API roles and Supabase's DEFAULT
// privileges (every new table and function in public is granted to anon,
// authenticated and service_role), applies the real 634 file, and proves the
// header's claims: browser roles hold nothing, the service role can only
// SELECT and INSERT, and nobody (the owner included) can rewrite a snapshot.
// (PGlite's db.exec runs SQL text; it is not child_process.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_634 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/634_roster_publish_snapshots.sql'),
  'utf8',
)

const LOC = '20000000-0000-0000-0000-000000000001'
const R1 = '30000000-0000-0000-0000-000000000001'
const R2 = '30000000-0000-0000-0000-000000000002'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  -- What Supabase does for every table and function created in public. The
  -- migration must undo it itself.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.rosters (
    id uuid PRIMARY KEY,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'published'
  );
  INSERT INTO public.locations (id) VALUES ('${LOC}');
  INSERT INTO public.rosters (id, location_id) VALUES ('${R1}', '${LOC}'), ('${R2}', '${LOC}');
`

function snapshotJson(blocks) {
  return JSON.stringify({
    v: 1,
    period_start: '2026-09-14',
    period_end: '2026-09-20',
    blocks: Array.from({ length: blocks }, (_, i) => ({ slot: `t${i}|2026-09-14`, coaches: [] })),
  })
}

function insertSql(rosterId, { blocks = 1, blockCount = blocks, snapshot = snapshotJson(blocks), periodEnd = '2026-09-20' } = {}) {
  return `INSERT INTO public.roster_publish_snapshots
      (roster_id, location_id, period_start, period_end, published_at, block_count, assignment_count, snapshot)
    VALUES ('${rosterId}', '${LOC}', '2026-09-14', '${periodEnd}', now(), ${blockCount}, 0, '${snapshot}'::jsonb)`
}

let db
beforeAll(async () => {
  db = new PGlite()
  await db.exec(BASE_SCHEMA)
  await db.exec(MIG_634)
}, 60_000)

afterAll(async () => { await db?.close() })

async function inTx(fn) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}

async function asRole(role, fn) {
  await db.exec(`SET ROLE ${role}`)
  try { return await fn() } finally { await db.exec('RESET ROLE') }
}

describe('migration 634 — roster_publish_snapshots', () => {
  it('has exactly the documented shape', async () => {
    const { rows } = await db.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'roster_publish_snapshots' ORDER BY column_name`)
    expect(rows).toEqual([
      { column_name: 'assignment_count', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'block_count', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'format_version', data_type: 'smallint', is_nullable: 'NO' },
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'location_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'period_end', data_type: 'date', is_nullable: 'NO' },
      { column_name: 'period_start', data_type: 'date', is_nullable: 'NO' },
      { column_name: 'published_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'published_by', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'roster_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'snapshot', data_type: 'jsonb', is_nullable: 'NO' },
    ])
  })

  it('has RLS on and NO policies', async () => {
    const rls = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.roster_publish_snapshots'::regclass`)
    expect(rls.rows).toEqual([{ relrowsecurity: true }])
    const pol = await db.query(`SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'public.roster_publish_snapshots'::regclass`)
    expect(pol.rows).toEqual([{ n: 0 }])
  })

  it('takes every privilege away from anon and authenticated, despite the default grants', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const { rows } = await db.query(`SELECT has_table_privilege($1, 'public.roster_publish_snapshots', $2) AS ok`, [role, priv])
        expect(rows[0].ok, `${role} still holds ${priv}`).toBe(false)
      }
    }
  })

  it('leaves the service role SELECT and INSERT, and nothing that could rewrite or remove a row', async () => {
    for (const [priv, want] of [['SELECT', true], ['INSERT', true], ['UPDATE', false], ['DELETE', false], ['TRUNCATE', false]]) {
      const { rows } = await db.query(`SELECT has_table_privilege('service_role', 'public.roster_publish_snapshots', $1) AS ok`, [priv])
      expect(rows[0].ok, `service_role ${priv}`).toBe(want)
    }
  })

  it('the service role writes and reads a snapshot', async () => {
    await inTx(async () => {
      await asRole('service_role', async () => {
        await db.exec(insertSql(R1, { blocks: 2 }))
        const { rows } = await db.query(`SELECT block_count, format_version, jsonb_array_length(snapshot->'blocks') AS n
          FROM public.roster_publish_snapshots WHERE roster_id = '${R1}'`)
        expect(rows).toEqual([{ block_count: 2, format_version: 1, n: 2 }])
      })
    })
  })

  it('the browser role is refused outright, not shown an empty table', async () => {
    await asRole('authenticated', async () => {
      await expect(db.query('SELECT * FROM public.roster_publish_snapshots')).rejects.toThrow(/permission denied/)
    })
  })

  it('the service role cannot rewrite a snapshot (no UPDATE privilege)', async () => {
    await inTx(async () => {
      await db.exec(insertSql(R1))
      await asRole('service_role', async () => {
        // A savepoint around the refused statement: without it the error
        // aborts the transaction and asRole's RESET ROLE is refused too.
        await db.exec('SAVEPOINT refused')
        await expect(db.exec(`UPDATE public.roster_publish_snapshots SET block_count = 0 WHERE roster_id = '${R1}'`))
          .rejects.toThrow(/permission denied/)
        await db.exec('ROLLBACK TO SAVEPOINT refused')
      })
    })
  })

  it('the owner cannot rewrite one either: the trigger refuses every UPDATE', async () => {
    await inTx(async () => {
      await db.exec(insertSql(R1))
      await expect(db.exec(`UPDATE public.roster_publish_snapshots SET published_by = NULL WHERE roster_id = '${R1}'`))
        .rejects.toThrow(/immutable/)
    })
  })

  it('one snapshot per roster row', async () => {
    await inTx(async () => {
      await db.exec(insertSql(R1))
      await expect(db.exec(insertSql(R1))).rejects.toThrow(/roster_publish_snapshots_roster_id_key/)
    })
    await inTx(async () => {
      await db.exec(insertSql(R1))
      await db.exec(insertSql(R2))
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.roster_publish_snapshots`)
      expect(rows).toEqual([{ n: 2 }])
    })
  })

  it('refuses a document whose block list does not match block_count, or is not an object with a blocks array', async () => {
    await expect(db.exec(insertSql(R1, { blocks: 2, blockCount: 3 }))).rejects.toThrow(/roster_publish_snapshots_shape_check/)
    await expect(db.exec(insertSql(R1, { blockCount: 0, snapshot: '[]' }))).rejects.toThrow(/roster_publish_snapshots_shape_check/)
    await expect(db.exec(insertSql(R1, { blockCount: 0, snapshot: '{"blocks":{}}' }))).rejects.toThrow(/roster_publish_snapshots_shape_check/)
  })

  it('refuses a period that ends before it starts', async () => {
    await expect(db.exec(insertSql(R1, { periodEnd: '2026-09-13' }))).rejects.toThrow(/roster_publish_snapshots_period_check/)
  })

  it('goes with its roster (a rejected draft is deleted by the service role; the cascade needs no DELETE grant)', async () => {
    await inTx(async () => {
      await db.exec(insertSql(R2))
      await asRole('service_role', async () => {
        await db.exec(`DELETE FROM public.rosters WHERE id = '${R2}'`)
      })
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.roster_publish_snapshots`)
      expect(rows).toEqual([{ n: 0 }])
    })
  })

  it('the trigger function is not callable by the browser roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      const { rows } = await db.query(
        `SELECT has_function_privilege($1, 'public.roster_publish_snapshots_refuse_update()', 'EXECUTE') AS ok`, [role])
      expect(rows[0].ok, `${role} can execute the trigger function`).toBe(false)
    }
  })

  it('re-running the file is a no-op', async () => {
    await db.exec(MIG_634)
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgrelid = 'public.roster_publish_snapshots'::regclass AND NOT tgisinternal`)
    expect(rows).toEqual([{ n: 1 }])
  })
})
