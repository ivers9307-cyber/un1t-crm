// tests/migration-629-shift-block-briefing.test.js
// BLOCKEDIT.1 — behavioural test for migration 629.
//
// Same reason as the 613/618/622/624/625/628 replays: there is no local
// Supabase stack, so without this the DDL gets its first execution on prod.
// Boots PGlite, recreates shift_blocks and roster_change_log as migs
// 067/177/236 left them (only what 629 touches or must coexist with), with
// Supabase's default table-level grants, applies the real 629 file, and proves
// the header's claims.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_629 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/629_shift_block_briefing.sql'),
  'utf8',
)

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const BLOCK = '50000000-0000-0000-0000-000000000001'
const COACH = '60000000-0000-0000-0000-000000000001'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY);
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    block_date date NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL,
    max_coaches smallint NOT NULL DEFAULT 15,
    min_coaches smallint NOT NULL DEFAULT 1,
    roster_id uuid,
    notes text,
    CONSTRAINT shift_blocks_time_order CHECK (end_time > start_time),
    CONSTRAINT shift_blocks_max_coaches_check CHECK (max_coaches BETWEEN 1 AND 50),
    CONSTRAINT shift_blocks_min_coaches_check CHECK (min_coaches >= 0 AND min_coaches <= max_coaches)
  );
  -- mig 236 verbatim for the columns and the INLINE action CHECK, which
  -- Postgres names roster_change_log_action_check.
  CREATE TABLE public.roster_change_log (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    block_id    uuid REFERENCES public.shift_blocks(id) ON DELETE SET NULL,
    block_date  date,
    actor_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    coach_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    action      text NOT NULL CHECK (action IN ('assigned', 'unassigned', 'time_changed')),
    details     jsonb NOT NULL DEFAULT '{}'::jsonb,
    notified_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.shift_blocks, public.roster_change_log TO anon, authenticated;
  GRANT ALL ON public.shift_blocks, public.roster_change_log TO service_role;
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}');
  INSERT INTO public.profiles VALUES ('${COACH}');
  INSERT INTO public.shift_blocks (id, location_id, block_date, start_time, end_time)
    VALUES ('${BLOCK}', '${LOC}', '2026-09-30', '09:00', '12:00');
  INSERT INTO public.roster_change_log (location_id, block_id, coach_id, action)
    VALUES ('${LOC}', '${BLOCK}', '${COACH}', 'time_changed');
`

async function boot({ before = '' } = {}) {
  const pg = new PGlite()
  await pg.exec(BASE_SCHEMA)
  await pg.exec(SEED)
  if (before) await pg.exec(before)
  return pg
}

const ACTION_CHECKS = `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
  WHERE conrelid = 'public.roster_change_log'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%action%' ORDER BY 1`

async function inRollback(db, fn) {
  await db.exec('BEGIN')
  try { return await fn() } finally { await db.exec('ROLLBACK') }
}

let db
beforeAll(async () => {
  db = await boot()
  await db.exec(MIG_629)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('migration 629 — shift_blocks.briefing', () => {
  it('is a nullable text column with no default, so every existing shift has no briefing', async () => {
    const { rows } = await db.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'shift_blocks' AND column_name = 'briefing'`)
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }])
    const { rows: b } = await db.query(`SELECT briefing FROM public.shift_blocks WHERE id = '${BLOCK}'`)
    expect(b).toEqual([{ briefing: null }])
  })

  it('takes up to 500 characters and refuses 501', async () => {
    await inRollback(db, async () => {
      await db.exec(`UPDATE public.shift_blocks SET briefing = repeat('a', 500) WHERE id = '${BLOCK}'`)
    })
    await inRollback(db, async () => {
      await expect(db.exec(`UPDATE public.shift_blocks SET briefing = repeat('a', 501) WHERE id = '${BLOCK}'`))
        .rejects.toThrow(/shift_blocks_briefing_shape/)
    })
  })

  it('refuses an empty or whitespace-only briefing (absent is NULL, never blank)', async () => {
    for (const blank of ["''", "'   '", "E'\\n\\t'"]) {
      await inRollback(db, async () => {
        await expect(db.exec(`UPDATE public.shift_blocks SET briefing = ${blank} WHERE id = '${BLOCK}'`))
          .rejects.toThrow(/shift_blocks_briefing_shape/)
      })
    }
  })

  it('changes no grant: the column rides the table-level grants', async () => {
    const { rows } = await db.query(`SELECT
      has_column_privilege('authenticated', 'public.shift_blocks', 'briefing', 'SELECT') AS auth_select,
      has_column_privilege('service_role',  'public.shift_blocks', 'briefing', 'UPDATE') AS svc_update`)
    expect(rows[0]).toEqual({ auth_select: true, svc_update: true })
  })
})

describe('migration 629 — roster_change_log.action gains block_edited', () => {
  it('accepts a coachless block_edited row, born stamped', async () => {
    await inRollback(db, async () => {
      const r = await db.query(`INSERT INTO public.roster_change_log (location_id, block_id, action, details, notified_at)
        VALUES ('${LOC}', '${BLOCK}', 'block_edited', '{"source":"block_edit"}', now()) RETURNING coach_id, action`)
      expect(r.rows).toEqual([{ coach_id: null, action: 'block_edited' }])
    })
  })

  it('still accepts the three old actions and still refuses anything else', async () => {
    await inRollback(db, async () => {
      for (const a of ['assigned', 'unassigned', 'time_changed']) {
        await db.exec(`INSERT INTO public.roster_change_log (location_id, coach_id, action) VALUES ('${LOC}', '${COACH}', '${a}')`)
      }
    })
    await inRollback(db, async () => {
      await expect(db.exec(`INSERT INTO public.roster_change_log (location_id, action) VALUES ('${LOC}', 'bogus')`))
        .rejects.toThrow(/roster_change_log_action_check/)
    })
  })

  it('leaves exactly ONE check on action, and it names block_edited', async () => {
    const { rows } = await db.query(ACTION_CHECKS)
    expect(rows.map((r) => r.conname)).toEqual(['roster_change_log_action_check'])
    expect(rows[0].def).toMatch(/block_edited/)
  })

  it('re-running the file is a no-op', async () => {
    await db.exec(MIG_629)
    expect((await db.query(ACTION_CHECKS)).rows).toHaveLength(1)
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'public.shift_blocks'::regclass AND conname = 'shift_blocks_briefing_shape'`)
    expect(rows[0].n).toBe(1)
  })
})

describe('the self-check aborts the WHOLE file', () => {
  it('when a second, differently named action CHECK exists, the DO block raises and nothing is applied', async () => {
    const other = await boot({
      before: `ALTER TABLE public.roster_change_log ADD CONSTRAINT roster_change_log_action_legacy
                 CHECK (action IN ('assigned', 'unassigned', 'time_changed'))`,
    })
    try {
      await expect(other.exec(MIG_629)).rejects.toThrow(/mig 629: expected ONE check on roster_change_log\.action/)
      await other.exec('ROLLBACK')
      const { rows } = await other.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'shift_blocks' AND column_name = 'briefing'`)
      expect(rows).toEqual([])
    } finally {
      await other.close()
    }
  })

  it('when a briefing column of another shape already exists, the DO block raises', async () => {
    const other = await boot({ before: "ALTER TABLE public.shift_blocks ADD COLUMN briefing text DEFAULT 'x'" })
    try {
      await expect(other.exec(MIG_629)).rejects.toThrow(/mig 629: shift_blocks\.briefing has the wrong shape/)
      await other.exec('ROLLBACK')
    } finally {
      await other.close()
    }
  })
})
