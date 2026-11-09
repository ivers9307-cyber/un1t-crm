// WAVEWIN.2 — behavioural test for migration 825 (race_events.wave_window_minutes).
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { WAVE_WINDOW_MIN_MINUTES, WAVE_WINDOW_ALL_MINUTES, WAVE_WINDOW_CHOICES } from '../src/lib/wave-window.js'

const MIG_825 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/825_wave_window_minutes.sql'), 'utf8')
const SCHEMA = `CREATE TABLE race_events (id uuid PRIMARY KEY, name text NOT NULL);`

let db
beforeEach(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(MIG_825)
})

const insert = (n, minutes) => db.query(
  `INSERT INTO race_events (id, name, wave_window_minutes) VALUES ($1, 'W', $2)`,
  [`e0000000-0000-0000-0000-${String(n).padStart(12, '0')}`, minutes],
)

describe('migration 825 — wave window', () => {
  it('adds a nullable integer wave_window_minutes', async () => {
    const { rows: [c] } = await db.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'race_events' AND column_name = 'wave_window_minutes'`)
    expect(c).toEqual({ data_type: 'integer', is_nullable: 'YES' })
  })

  it('refuses a window outside the range the code accepts', async () => {
    await expect(insert(1, WAVE_WINDOW_MIN_MINUTES - 1)).rejects.toMatchObject({ code: '23514' })
    await expect(insert(2, WAVE_WINDOW_ALL_MINUTES + 1)).rejects.toMatchObject({ code: '23514' })
    await insert(3, WAVE_WINDOW_MIN_MINUTES)
    await insert(4, WAVE_WINDOW_ALL_MINUTES)
    await insert(5, null)
  })

  it('accepts every choice the event form offers', async () => {
    let n = 10
    for (const minutes of WAVE_WINDOW_CHOICES) await insert(n++, minutes)
  })

  it('re-applies cleanly', async () => {
    await expect(db.exec(MIG_825)).resolves.not.toThrow()
  })
})
