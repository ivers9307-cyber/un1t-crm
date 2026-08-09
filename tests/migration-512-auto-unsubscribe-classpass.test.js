// GAPS-P1.5 — shape guard for migration 512 (auto_unsubscribe_classpass).
//
// WHY THIS FILE EXISTS
// ────────────────────
// Three facts, each verified live against un1t-crm on 2026-08-09:
//   • the CHECK constraint contacts_email_status_not_unsubscribed
//     (email_status IS DISTINCT FROM 'unsubscribed', mig 501) exists;
//   • the trigger auto_unsubscribe_classpass_trigger is ENABLED (tgenabled='O')
//     — AFTER INSERT OR UPDATE OF glofox_membership_status ON contacts;
//   • the live function body (mig 151, never redefined — mig 166 only pinned
//     search_path) still ends in an UPDATE setting email_status to that exact
//     banned value.
//
// So the next contact that transitions INTO classpass_payg raises a constraint
// violation that fails the whole statement, breaking the Glofox member sync for
// that contact. 1,612 ClassPass contacts already sit in that status; the defect
// is armed, not yet fired, purely because nobody has crossed the boundary since
// mig 501 landed.
//
// The fix is to drop the email_status step and nothing else. Since mig 492
// email_status is REPUTATION-ONLY (active | bounced | complained) and consent
// lives in contact_location_preferences, so that step is a leftover from the
// retired consent model — while the rest of the function (preferences row +
// consent_log audit) is the correct part and must survive verbatim.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const FILE = path.resolve(
  import.meta.dirname,
  '../supabase/migrations/512_auto_unsubscribe_classpass_no_email_status.sql',
)

// Assertions run against the STATEMENTS, not the prose — this migration has to
// discuss the write it is removing in order to explain itself.
const sql = existsSync(FILE)
  ? readFileSync(FILE, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()
  : ''

describe('migration 512 — auto_unsubscribe_classpass drops the email_status write', () => {
  it('exists', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('redefines the function in place, keeping the trigger attached and enabled', () => {
    expect(sql).toMatch(/create or replace function public\.auto_unsubscribe_classpass\(\)/)
    expect(sql).toMatch(/returns trigger/)
    expect(sql).toMatch(/language plpgsql/)
    // CREATE OR REPLACE keeps auto_unsubscribe_classpass_trigger bound to the
    // function. Dropping or disabling the trigger would silently stop applying
    // the ClassPass opt-out — a consent regression, not a fix.
    expect(sql).not.toMatch(/drop trigger/)
    expect(sql).not.toMatch(/disable trigger/)
    expect(sql).not.toMatch(/drop function/)
  })

  it('keeps search_path pinned exactly as mig 166 set it', () => {
    expect(sql).toMatch(/set search_path (to|=) 'pg_catalog', 'public'/)
  })

  it('keeps the transition guards (only fires on a real move INTO classpass_payg)', () => {
    expect(sql).toMatch(/new\.glofox_membership_status is distinct from 'classpass_payg'/)
    expect(sql).toMatch(
      /tg_op = 'update' and old\.glofox_membership_status is not distinct from new\.glofox_membership_status/,
    )
  })

  it('keeps the contact_preferences opt-out across all six channels', () => {
    expect(sql).toMatch(/insert into contact_preferences/)
    expect(sql).toMatch(/on conflict \(contact_id\) do update set/)
    for (const ch of [
      'email_marketing', 'email_administrative',
      'sms_marketing', 'sms_administrative',
      'whatsapp_marketing', 'whatsapp_administrative',
    ]) {
      expect(sql, `${ch} missing from the upsert`).toMatch(new RegExp(`${ch}\\s*=\\s*false`))
    }
  })

  it('keeps the consent_log audit row per channel, tagged auto_classpass', () => {
    expect(sql).toMatch(/insert into consent_log \(contact_id, channel, action, source\)/)
    expect(sql).toMatch(/'opt_out', 'auto_classpass'/)
    expect(sql).toMatch(/from unnest\(channels\) as ch/)
  })

  // THE DEFECT. Nothing in the function may write contacts.email_status —
  // 'unsubscribed' is CHECK-banned by mig 501, and no other value belongs here
  // either (a ClassPass transition says nothing about deliverability).
  it('writes contacts.email_status nowhere', () => {
    expect(sql).not.toMatch(/update contacts set email_status/)
    expect(sql).not.toMatch(/update public\.contacts set email_status/)
    expect(sql).not.toMatch(/set\s+email_status\s*=/)
  })

  it('records why the step went, citing migs 492 and 501', () => {
    expect(sql).toMatch(/comment on function public\.auto_unsubscribe_classpass\(\) is/)
    expect(sql).toMatch(/mig 492/)
    expect(sql).toMatch(/mig 501/)
  })
})
