// EVENT-MOVE.5 — mig 710: race_payments.kind ('entry' default | 'move_gap'),
// registration_move_id, at most one PENDING gap payment per move, and the
// two gap email copy columns. Run against PGlite with the minimal tables it
// touches. Fictional values only.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/710_race_payments_kind_move_gap.sql'), 'utf8')
const MV1 = 'd0000000-0000-4000-8000-000000000001'
const MV2 = 'd0000000-0000-4000-8000-000000000002'

async function fresh() {
  const db = new PGlite()
  await db.exec(`
    CREATE TABLE public.race_events (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.registration_moves (id uuid PRIMARY KEY);
    CREATE TABLE public.race_payments (
      id serial PRIMARY KEY, status text NOT NULL DEFAULT 'pending', amount_cents int NOT NULL DEFAULT 0);
    INSERT INTO public.registration_moves VALUES ('${MV1}'), ('${MV2}');
    INSERT INTO public.race_payments (status, amount_cents) VALUES ('completed', 6400);`)
  await db.exec(MIG)
  return db
}
const gap = (db, move, status = 'pending') =>
  db.query(`INSERT INTO public.race_payments (status, amount_cents, kind, registration_move_id) VALUES ($1, 1000, 'move_gap', $2)`, [status, move])

describe('migration 710 (EVENT-MOVE.5)', () => {
  it('every existing row and every insert that names no kind is an entry', async () => {
    const db = await fresh()
    await db.exec(`INSERT INTO public.race_payments (status, amount_cents) VALUES ('pending', 3000)`)
    expect((await db.query(`SELECT DISTINCT kind FROM public.race_payments`)).rows).toEqual([{ kind: 'entry' }])
  })
  it('refuses a kind outside entry | move_gap', async () => {
    const db = await fresh()
    await expect(db.query(`INSERT INTO public.race_payments (kind) VALUES ('refund')`)).rejects.toThrow(/race_payments_kind_check/)
  })
  it('allows ONE pending gap payment per move; a second fails 23505', async () => {
    const db = await fresh()
    await gap(db, MV1)
    await expect(gap(db, MV1)).rejects.toMatchObject({ code: '23505' })
  })
  it('a new pending link after an abandoned, failed or completed one is allowed, and other moves are independent', async () => {
    const db = await fresh()
    await gap(db, MV1, 'abandoned')
    await gap(db, MV1, 'failed')
    await gap(db, MV1, 'completed')
    await gap(db, MV1)
    await gap(db, MV2)
    expect((await db.query(`SELECT count(*)::int AS n FROM public.race_payments WHERE kind = 'move_gap'`)).rows[0].n).toBe(5)
  })
  it('pending ENTRY payments are untouched by the index', async () => {
    const db = await fresh()
    await db.exec(`INSERT INTO public.race_payments (status) VALUES ('pending'), ('pending')`)
    expect((await db.query(`SELECT count(*)::int AS n FROM public.race_payments WHERE status = 'pending'`)).rows[0].n).toBe(2)
  })
  it('a deleted move leaves its payment with no move (on delete set null)', async () => {
    const db = await fresh()
    await gap(db, MV1, 'completed')
    await db.exec(`DELETE FROM public.registration_moves WHERE id = '${MV1}'`)
    expect((await db.query(`SELECT registration_move_id FROM public.race_payments WHERE kind = 'move_gap'`)).rows).toEqual([{ registration_move_id: null }])
  })
  it('adds the two gap email copy columns on race_events', async () => {
    const db = await fresh()
    const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'race_events' AND column_name LIKE 'gap_email_%' ORDER BY 1`)).rows
    expect(cols).toEqual([{ column_name: 'gap_email_intro' }, { column_name: 'gap_email_subject' }])
  })
  it('is re-runnable', async () => {
    const db = await fresh()
    await expect(db.exec(MIG)).resolves.toBeDefined()
  })
})
