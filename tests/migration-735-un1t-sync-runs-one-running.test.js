// UN1THARD.1 — behavioural test for migration 735 (one running un1t.online
// sync per studio). PGlite with un1t_sync_runs as mig 726 created it (the
// columns, the status CHECK and the location FK), then the real 735 file.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_735 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/735_un1t_sync_runs_one_running.sql'), 'utf8')
const A = 'a0000000-0000-0000-0000-00000000000a'
const B = 'b0000000-0000-0000-0000-00000000000b'

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)
const insertRun = (loc, status) => db.query(
  `INSERT INTO public.un1t_sync_runs (location_id, status) VALUES ($1, $2) RETURNING id`, [loc, status])

beforeAll(async () => {
  db = new PGlite()
  await runSql(`
    CREATE TABLE public.locations (id uuid PRIMARY KEY);
    INSERT INTO public.locations VALUES ('${A}'), ('${B}');
    CREATE TABLE public.un1t_sync_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz, duration_ms integer,
      status text NOT NULL CONSTRAINT un1t_sync_runs_status_check CHECK (status = ANY (ARRAY['running','ok','error'])),
      counts jsonb, first_error text
    );
    INSERT INTO public.un1t_sync_runs (location_id, status) VALUES ('${A}', 'ok'), ('${A}', 'error'), ('${A}', 'ok');
  `)
  await runSql(MIG_735)
}, 60_000)
afterAll(() => db?.close())

describe('mig 735 — one running un1t.online sync per studio', () => {
  it('builds over existing finished runs and passes its own self-check', async () => {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'un1t_sync_runs_one_running'`)
    expect(rows[0].n).toBe(1)
  })

  it('refuses a second running run at the same studio with 23505', async () => {
    await insertRun(A, 'running')
    await expect(insertRun(A, 'running')).rejects.toMatchObject({ code: '23505' })
  })

  it("another studio's run, and finished runs, are unaffected", async () => {
    await expect(insertRun(B, 'running')).resolves.toBeDefined()
    await expect(insertRun(A, 'ok')).resolves.toBeDefined()
    await expect(insertRun(A, 'error')).resolves.toBeDefined()
  })

  it('once the running run is closed, a new one may start', async () => {
    await db.query(`UPDATE public.un1t_sync_runs SET status = 'error' WHERE location_id = $1 AND status = 'running'`, [A])
    await expect(insertRun(A, 'running')).resolves.toBeDefined()
  })

  it('is idempotent', async () => {
    await expect(runSql(MIG_735)).resolves.toBeDefined()
  })
})
