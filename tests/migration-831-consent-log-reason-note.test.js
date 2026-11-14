// STAFFCONSENT.1 — static checks for migration 831 (consent_log reason/note).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const SQL = readFileSync(path.join(root, 'supabase/migrations/831_consent_log_reason_note.sql'), 'utf8')
const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('migration 831', () => {
  it('adds reason and note to consent_log, idempotently', () => {
    expect(code).toMatch(/ALTER TABLE public\.consent_log[\s\S]*ADD COLUMN IF NOT EXISTS reason text/)
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS note text/)
  })

  it('grants nothing to a client session and adds no policy', () => {
    expect(code).not.toMatch(/\bGRANT\b/i)
    expect(code).not.toMatch(/CREATE POLICY/i)
    expect(code).not.toMatch(/\b(anon|authenticated)\b/i)
  })
})
