// SCHEDSTATUS.1 — keep the assignment-status enums honest against the DB.
//
// PUT /api/schedule/assignments/[id] accepted `status: 'declined'`, which the
// `shift_assignments_status_check` CHECK (mig 067, widened by mig 337) does
// not permit: validation passed, Postgres refused the write, and the manager
// got a 400 quoting a constraint name. A Zod enum and a CHECK constraint are
// two copies of one fact living in two files, so this test replays the
// migrations and holds them together.
//
// Deliberately a TEXT scan, not a PGlite boot: the question is "what does the
// constraint say", and replaying the DDL in a real engine would only answer it
// more slowly. It is a floor, not a proof — a constraint written in a shape
// this regex cannot read fails the test loudly rather than passing silently
// (see `foundIn` below).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { SHIFT_ASSIGNMENT_DB_STATUSES, assignmentStatusSchema } from '../src/lib/schemas.js'

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../supabase/migrations')

// Every place a migration states the allowed set, in application order. Both
// shapes the repo actually uses: the inline CHECK inside CREATE TABLE
// (mig 067) and a later ADD CONSTRAINT (mig 337).
function declaredStatusSets() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  const found = []
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')

    const addConstraint = /ADD\s+CONSTRAINT\s+shift_assignments_status_check\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/gis
    for (const m of sql.matchAll(addConstraint)) found.push({ file, values: parseList(m[1]) })

    // The CREATE TABLE form: find the shift_assignments body, then its
    // `status ... check (status in (...))` column definition.
    const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.shift_assignments\s*\(([\s\S]*?)\n\);/i.exec(sql)
    if (createTable) {
      const inline = /status\s+text[\s\S]*?check\s*\(\s*status\s+in\s*\(([^)]*)\)/i.exec(createTable[1])
      if (inline) found.push({ file, values: parseList(inline[1]) })
    }
  }
  return found
}

function parseList(raw) {
  return raw.split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean)
}

describe('shift_assignments.status — schema vs the CHECK constraint', () => {
  const declarations = declaredStatusSets()

  it('finds the constraint in the migrations at all', () => {
    // If this fails, the regexes above stopped matching a constraint that
    // still exists — fix the scan, do not delete the test.
    expect(declarations.length).toBeGreaterThan(0)
    expect(declarations.some((d) => d.file.startsWith('067'))).toBe(true)
    expect(declarations.some((d) => d.file.startsWith('337'))).toBe(true)
  })

  it('SHIFT_ASSIGNMENT_DB_STATUSES matches the LAST declaration on disk', () => {
    const live = declarations[declarations.length - 1]
    expect([...live.values].sort()).toEqual([...SHIFT_ASSIGNMENT_DB_STATUSES].sort())
  })

  it('every status the assignment PUT accepts is one the database accepts', () => {
    const accepted = assignmentStatusSchema.options
    expect(accepted.length).toBeGreaterThan(0)
    for (const status of accepted) {
      expect(SHIFT_ASSIGNMENT_DB_STATUSES).toContain(status)
    }
  })

  it("'declined' — the value that failed at the database — is refused by the schema", () => {
    expect(assignmentStatusSchema.safeParse('declined').success).toBe(false)
    expect(SHIFT_ASSIGNMENT_DB_STATUSES).not.toContain('declined')
  })

  it('the PUT does not hand out the statuses only the roster internals write', () => {
    // 'swapped' belongs to mig 615's approve_* functions; 'cancelled' is the
    // tombstone ROSTER-FIX.1 removed and mig 603 deleted from disk.
    expect(assignmentStatusSchema.safeParse('swapped').success).toBe(false)
    expect(assignmentStatusSchema.safeParse('cancelled').success).toBe(false)
  })
})
