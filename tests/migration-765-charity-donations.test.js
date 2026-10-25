// tests/migration-765-charity-donations.test.js
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
const sql = fs.readFileSync('supabase/migrations/765_charity_donations.sql', 'utf8')
describe('mig 765 — donations', () => {
  it('creates donations closed to every client session', () => {
    expect(sql).toMatch(/create table if not exists public\.donations/i)
    expect(sql).toMatch(/alter table public\.donations enable row level security/i)
    expect(sql).toMatch(/revoke all on public\.donations from anon, authenticated, public/i)
    expect(sql).not.toMatch(/create policy[^;]*on public\.donations/i)
  })
  it('constrains status and match multiplier', () => {
    expect(sql).toMatch(/status in \('awaiting_payment', ?'paid', ?'failed', ?'expired', ?'refunded'\)/i)
    expect(sql).toMatch(/match_multiplier numeric\(3,1\) not null default 1/i)
  })
  it('adds the event columns withheld from clients', () => {
    expect(sql).toMatch(/add column if not exists charity_enabled boolean not null default false/i)
    expect(sql).toMatch(/add column if not exists charity jsonb/i)
    expect(sql).toMatch(/column-grant: withheld race_events\.charity_enabled/)
    expect(sql).toMatch(/column-grant: withheld race_events\.charity/)
  })
  it('extends the webhook provider list with revolut_donation and keeps every existing value', () => {
    for (const p of ['postmark','revolut','revolut_race','revolut_class_booking','revolut_offer','whatsapp','instagram','twilio','xero','unifi_access','unifi_protect','revolut_donation']) {
      expect(sql).toContain(`'${p}'`)
    }
  })
})
