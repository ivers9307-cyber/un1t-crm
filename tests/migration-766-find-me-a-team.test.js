// tests/migration-766-find-me-a-team.test.js
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
const sql = fs.readFileSync('supabase/migrations/766_find_me_a_team.sql', 'utf8')
describe('mig 766 — find me a team', () => {
  it('adds the four registration columns', () => {
    expect(sql).toMatch(/add column if not exists looking_for_team boolean not null default false/i)
    expect(sql).toMatch(/add column if not exists placed_into_registration_id uuid references (public\.)?race_registrations\(id\) on delete set null/i)
    expect(sql).toMatch(/add column if not exists placed_at timestamptz/i)
    expect(sql).toMatch(/add column if not exists placed_by uuid references (public\.)?profiles\(id\) on delete set null/i)
  })
  it('adds the event copy column', () => {
    expect(sql).toMatch(/add column if not exists find_team jsonb/i)
  })
  it('widens the status CHECK to five values including placed', () => {
    expect(sql).toMatch(/drop constraint if exists race_registrations_status_check/i)
    expect(sql).toMatch(/check \(status in \('pending_payment', ?'confirmed', ?'cancelled', ?'no_show', ?'placed'\)\)/i)
  })
  it('states a column-grant decision for every new column', () => {
    for (const c of ['looking_for_team', 'placed_into_registration_id', 'placed_at', 'placed_by']) {
      expect(sql).toContain(`column-grant: withheld race_registrations.${c}`)
    }
    expect(sql).toContain('column-grant: withheld race_events.find_team')
  })
  it('indexes the open looking-for-a-team queue', () => {
    expect(sql).toMatch(/create index if not exists idx_race_registrations_looking\s+on public\.race_registrations \(race_event_id\)\s+where looking_for_team and status = 'confirmed'/i)
  })
  it('grants nothing to a client role', () => {
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/\bgrant\b[^;]*\b(anon|authenticated)\b/i)
  })
})
