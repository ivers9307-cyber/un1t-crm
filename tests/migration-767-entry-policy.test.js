// tests/migration-767-entry-policy.test.js — ENTRYPOLICY.1
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
const sql = fs.readFileSync('supabase/migrations/767_entry_policy.sql', 'utf8')
describe('mig 767 — entry policy', () => {
  it('adds the event policy column', () => {
    expect(sql).toMatch(/alter table public\.race_events\s+add column if not exists entry_policy jsonb/i)
  })
  it('states the column-grant decision', () => {
    expect(sql).toContain('column-grant: withheld race_events.entry_policy')
  })
  it('grants nothing to a client role and deletes nothing', () => {
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/\bgrant\b[^;]*\b(anon|authenticated)\b/i)
    expect(code).not.toMatch(/\bdelete\b|\btruncate\b|\bdrop\b/i)
  })
})
