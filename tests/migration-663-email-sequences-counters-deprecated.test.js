// SEQCOUNTERS.1 — mig 663 marks email_sequences.total_enrolled /
// total_completed / total_exited DEPRECATED (comments only, no data change),
// refuses to run if an increment_sequence_* function exists (that would mean
// someone started maintaining them), and self-checks. Fictional values only.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/663_email_sequences_counters_deprecated.sql'), 'utf8')
const COLS = ['total_enrolled', 'total_completed', 'total_exited']
const ROLLBACK = COLS.map((c) => `COMMENT ON COLUMN public.email_sequences.${c} IS NULL;`).join('\n')
const run = (db, sql) => db.exec(sql) // PGlite's multi-statement SQL runner

async function fresh() {
  const db = new PGlite()
  await run(db, `
    CREATE TABLE public.email_sequences (
      id uuid PRIMARY KEY, name text,
      total_enrolled integer DEFAULT 0, total_completed integer DEFAULT 0, total_exited integer DEFAULT 0);
    INSERT INTO public.email_sequences VALUES ('5e000000-0000-4000-8000-000000000001', 'Welcome', 8, 0, 0);`)
  return db
}
const comments = async (db) => (await db.query(`
  SELECT a.attname AS col, col_description(a.attrelid, a.attnum) AS c
  FROM pg_attribute a WHERE a.attrelid = 'public.email_sequences'::regclass AND a.attname = ANY($1) ORDER BY a.attname`, [COLS])).rows

describe('migration 663 (SEQCOUNTERS.1)', () => {
  it('comments all three columns DEPRECATED (mig 663) and changes no data', async () => {
    const db = await fresh()
    await run(db, MIG)
    const rows = await comments(db)
    expect(rows).toHaveLength(3)
    for (const { c } of rows) expect(c).toMatch(/^DEPRECATED \(mig 663, SEQCOUNTERS\.1\)/)
    expect((await db.query(`SELECT total_enrolled FROM public.email_sequences`)).rows).toEqual([{ total_enrolled: 8 }])
  })

  it('is re-runnable', async () => {
    const db = await fresh()
    await run(db, MIG)
    await expect(run(db, MIG)).resolves.toBeDefined()
  })

  it('refuses to run when an increment_sequence_* function exists', async () => {
    const db = await fresh()
    await run(db, `CREATE FUNCTION public.increment_sequence_enrolled(p_sequence_id uuid, p_delta int) RETURNS void LANGUAGE sql AS $$ SELECT $$;`)
    await expect(run(db, MIG)).rejects.toThrow(/663/)
    // PGlite keeps the aborted transaction open after the RAISE; end it so
    // the read below runs (a real apply_migration session discards it).
    await run(db, 'ROLLBACK;').catch(() => {})
    const rows = await comments(db)
    expect(rows).toHaveLength(3)
    for (const { c } of rows) expect(c).toBeNull() // the whole file rolled back
  })

  it('takes its locks with a 5s lock_timeout, set right after BEGIN (COMMENT ON takes ShareUpdateExclusiveLock)', () => {
    expect(MIG).toMatch(/^BEGIN;\nSET LOCAL lock_timeout = '5s';\n/m)
  })

  it('a failed self-check AFTER the comments ran rolls the whole file back', async () => {
    // One comment no longer carries the marker, so the self-check counts 2
    // and raises; the two comments that did land must not survive it.
    const broken = MIG.replace("total_exited IS\n  'DEPRECATED (mig 663", "total_exited IS\n  'deprecated (mig 663")
    expect(broken).not.toBe(MIG)
    const db = await fresh()
    await expect(run(db, broken)).rejects.toThrow(/663 self-check: expected 3 deprecated comments, found 2/)
    await run(db, 'ROLLBACK;').catch(() => {}) // see the refusal case
    const rows = await comments(db)
    expect(rows).toHaveLength(3)
    for (const { c } of rows) expect(c).toBeNull()
  })

  it('the header rollback restores the pre-663 state (no comments)', async () => {
    expect(MIG).toContain(ROLLBACK.split('\n')[0])
    const db = await fresh()
    await run(db, MIG)
    await run(db, ROLLBACK)
    for (const { c } of await comments(db)) expect(c).toBeNull()
  })
})
