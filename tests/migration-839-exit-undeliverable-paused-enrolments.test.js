// 839 — SEQUNDELIVERABLE.1: exits the enrolments paused on Postmark's
// inactive-recipient refusal and touches nothing else. PGlite over the
// columns the file reads. Fictional ids only: the repo is public.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/839_exit_undeliverable_paused_enrolments.sql'), 'utf8')
const INACTIVE = 'You tried to send to recipient(s) that have been marked as inactive. Found inactive addresses: a@example.test.'

let db
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE public.sequence_enrollments (
      id text PRIMARY KEY, status text NOT NULL, last_error text, exit_reason text,
      exited_at timestamptz, next_step_at timestamptz
    );
    INSERT INTO public.sequence_enrollments (id, status, last_error, next_step_at) VALUES
      ('p-inactive-1', 'paused', '${INACTIVE}', NULL),
      ('p-inactive-2', 'paused', '${INACTIVE}', now()),
      ('p-other',      'paused', 'Step has no content (no html_content and no template_id).', NULL),
      ('a-inactive',   'active', '${INACTIVE}', now()),
      ('x-done',       'exited', '${INACTIVE}', NULL);
  `)
  await db.exec(MIG)
}, 60_000)
afterAll(() => db?.close())

const row = async (id) => (await db.query('SELECT status, exit_reason, exited_at, next_step_at FROM public.sequence_enrollments WHERE id = $1', [id])).rows[0]

describe('839', () => {
  it('exits the paused inactive-recipient rows as undeliverable', async () => {
    for (const id of ['p-inactive-1', 'p-inactive-2']) {
      const r = await row(id)
      expect(r).toMatchObject({ status: 'exited', exit_reason: 'undeliverable', next_step_at: null })
      expect(r.exited_at).toBeTruthy()
    }
  })
  it('leaves a paused row with another error, an active row and an exited row alone', async () => {
    expect(await row('p-other')).toMatchObject({ status: 'paused', exit_reason: null })
    expect((await row('a-inactive')).status).toBe('active')
    expect(await row('x-done')).toMatchObject({ status: 'exited', exit_reason: null })
  })
  it('a second run changes nothing and passes its self-check', async () => {
    const before = await row('p-inactive-1')
    await db.exec(MIG)
    expect(await row('p-inactive-1')).toEqual(before)
  })
})
