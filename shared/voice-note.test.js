import { test, expect } from 'vitest'
import { voiceNoteCaption, effectiveTranscriptStatus, TRANSCRIPT_STATUSES, PENDING_STALE_MS, VOICE_TRANSCRIPT_MARKER } from './voice-note.js'

test('constants', () => {
  expect(TRANSCRIPT_STATUSES).toEqual(['pending', 'ok', 'unclear', 'too_long', 'capped', 'disabled', 'not_configured', 'failed'])
  expect(PENDING_STALE_MS).toBe(600_000)
  expect(VOICE_TRANSCRIPT_MARKER).toBe('(voice note transcript) ')
})
test('non-audio and pre-launch audio have no caption', () => {
  expect(voiceNoteCaption({ message_type: 'text', body: 'hi' })).toBeNull()
  expect(voiceNoteCaption({ message_type: 'audio', transcript_status: null })).toBeNull()
  expect(voiceNoteCaption(null)).toBeNull()
})
test('ok shows the transcript, with language only when not English', () => {
  expect(voiceNoteCaption({ message_type: 'audio', transcript_status: 'ok', transcript: 'Can I book 7am?', transcript_language: 'en' }))
    .toEqual({ transcript: 'Can I book 7am?', note: null, language: null })
  expect(voiceNoteCaption({ message_type: 'audio', transcript_status: 'ok', transcript: 'Olá', transcript_language: 'por' }).language).toBe('Portuguese')
  expect(voiceNoteCaption({ message_type: 'audio', transcript_status: 'ok', transcript: 'x', transcript_language: 'eng' }).language).toBeNull()
  expect(voiceNoteCaption({ message_type: 'audio', transcript_status: 'ok', transcript: 'x', transcript_language: 'jpn' }).language).toBe('JPN')
})
test('notes per status', () => {
  const c = (s, t = null) => voiceNoteCaption({ message_type: 'audio', transcript_status: s, transcript: t, created_at: new Date().toISOString() })
  expect(c('unclear', 'mumble')).toEqual({ transcript: 'mumble', note: "Couldn't make it out clearly:", language: null })
  expect(c('too_long').note).toBe('Over 3 minutes, not transcribed')
  expect(c('capped').note).toBe('Monthly transcription limit reached')
  expect(c('failed').note).toBe('Transcription unavailable')
  expect(c('not_configured').note).toBe('Transcription unavailable')
  expect(c('pending').note).toBe('Transcribing…')
  expect(c('disabled')).toBeNull()
})
test('stale pending reads as failed', () => {
  const old = new Date(Date.now() - 11 * 60_000).toISOString()
  expect(effectiveTranscriptStatus({ transcript_status: 'pending', created_at: old })).toBe('failed')
  expect(effectiveTranscriptStatus({ transcript_status: 'pending', created_at: new Date().toISOString() })).toBe('pending')
  expect(effectiveTranscriptStatus({ transcript_status: 'ok', created_at: old })).toBe('ok')
  expect(voiceNoteCaption({ message_type: 'audio', transcript_status: 'pending', created_at: old }).note).toBe('Transcription unavailable')
})
