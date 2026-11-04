// VOICENOTE.1 — the migration's columns, CHECK list and grant statement.
import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { TRANSCRIPT_STATUSES } from '../shared/voice-note.js'

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '808_wa_voice_note_transcription.sql'),
  'utf8',
)

describe('808 voice note transcription migration', () => {
  test('adds the four whatsapp_messages columns', () => {
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS transcript text')
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS transcript_status text')
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS transcript_language text')
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS transcribed_at timestamptz')
  })

  test('the CHECK list is exactly TRANSCRIPT_STATUSES', () => {
    const m = SQL.match(/transcript_status IN \(([^)]*)\)/)
    expect(m).not.toBeNull()
    const listed = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
    expect(listed).toEqual([...TRANSCRIPT_STATUSES])
  })

  test('adds the org switch and cap', () => {
    expect(SQL).toContain('voice_transcription_enabled boolean NOT NULL DEFAULT false')
    expect(SQL).toContain('voice_transcription_monthly_cap_minutes integer')
  })

  test('states the grant decision and never touches instagram_messages', () => {
    expect(SQL).toContain('-- column-grant:')
    expect(SQL).not.toMatch(/instagram_messages/)
  })
})
