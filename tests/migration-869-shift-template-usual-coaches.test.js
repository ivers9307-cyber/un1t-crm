// USUALCOACH.1 — behavioural test for migration 869 (shift_templates.usual_coach_ids).
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/869_shift_template_usual_coaches.sql'), 'utf8')
const SCHEMA = `CREATE TABLE shift_templates (id uuid PRIMARY KEY, location_id uuid NOT NULL, name text NOT NULL);
INSERT INTO shift_templates VALUES ('a0000000-0000-0000-0000-0000000000a1', 'b0000000-0000-0000-0000-0000000000b1', 'Morning');`

const ID = (n) => `c0000000-0000-0000-0000-${String(n).padStart(12, '0')}`

let db
beforeEach(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(MIG)
})

describe('migration 869 — usual coaches per template', () => {
  it('adds a non-null uuid[] defaulting to empty, existing rows included', async () => {
    const { rows: [c] } = await db.query(`SELECT data_type, udt_name, is_nullable FROM information_schema.columns WHERE table_name = 'shift_templates' AND column_name = 'usual_coach_ids'`)
    expect(c).toEqual({ data_type: 'ARRAY', udt_name: '_uuid', is_nullable: 'NO' })
    const { rows: [t] } = await db.query(`SELECT usual_coach_ids FROM shift_templates`)
    expect(t.usual_coach_ids).toEqual([])
  })

  it('keeps the order the ids were saved in', async () => {
    await db.query(`UPDATE shift_templates SET usual_coach_ids = $1::uuid[]`, [[ID(2), ID(1)]])
    const { rows: [t] } = await db.query(`SELECT usual_coach_ids FROM shift_templates`)
    expect(t.usual_coach_ids).toEqual([ID(2), ID(1)])
  })

  it('refuses more than 50 coaches and a null', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ID(i + 1))
    await expect(db.query(`UPDATE shift_templates SET usual_coach_ids = $1::uuid[]`, [many])).rejects.toMatchObject({ code: '23514' })
    await db.query(`UPDATE shift_templates SET usual_coach_ids = $1::uuid[]`, [many.slice(0, 50)])
    await expect(db.query(`UPDATE shift_templates SET usual_coach_ids = NULL`)).rejects.toMatchObject({ code: '23502' })
  })

  it('re-applies cleanly', async () => {
    await expect(db.exec(MIG)).resolves.not.toThrow()
  })
})
