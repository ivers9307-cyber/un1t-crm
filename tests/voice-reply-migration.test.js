// VOICEREPLY.1 — the migration's columns, CHECK lists and grant statement.
import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { VOICE_KINDS } from '../shared/voice-note.js'

const SQL = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '809_wa_voice_replies.sql'), 'utf8')
const listIn = (re) => {
  const m = SQL.match(re)
  expect(m).not.toBeNull()
  return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''))
}

describe('809 voice replies migration', () => {
  test('org_settings: one mode column, test numbers, a cap', () => {
    expect(SQL).toContain("voice_reply_mode text NOT NULL DEFAULT 'off'")
    expect(listIn(/voice_reply_mode IN \(([^)]*)\)/)).toEqual(['off', 'test', 'on'])
    expect(SQL).toContain("voice_reply_test_phones text[] NOT NULL DEFAULT '{}'")
    expect(SQL).toContain('voice_reply_monthly_cap integer')
    expect(SQL).toMatch(/voice_reply_monthly_cap > 0/)
  })
  test('whatsapp_messages: voice_kind with the shared kinds, and the fallback stamp', () => {
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS voice_kind text')
    expect(listIn(/voice_kind IN \(([^)]*)\)/)).toEqual([...VOICE_KINDS])
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS voice_fallback_sent_at timestamptz')
  })
  test('states the grant decision and never touches instagram_messages', () => {
    expect(SQL).toContain('-- column-grant:')
    expect(SQL).not.toMatch(/instagram_messages/)
  })
})
