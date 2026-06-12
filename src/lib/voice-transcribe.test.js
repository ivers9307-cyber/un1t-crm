// AGENT-VOICE.1 — pure parts of the voice-note transcription path.
import { describe, it, expect } from 'vitest'
import { voiceBodyFromTranscript, transcribeWhatsAppAudio } from './voice-transcribe'

describe('voiceBodyFromTranscript', () => {
  it('prefixes with the mic marker and trims', () => {
    expect(voiceBodyFromTranscript('  Can I book a class?  ')).toBe('🎙️ Can I book a class?')
  })
  it('returns null for empty transcripts', () => {
    expect(voiceBodyFromTranscript('')).toBeNull()
    expect(voiceBodyFromTranscript('   ')).toBeNull()
  })
  it('caps very long transcripts', () => {
    expect(voiceBodyFromTranscript('x'.repeat(5000)).length).toBeLessThanOrEqual(2000)
  })
})

describe('transcribeWhatsAppAudio', () => {
  it('returns null without an OPENAI_API_KEY (graceful degrade)', async () => {
    const prev = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    expect(await transcribeWhatsAppAudio({ mediaId: 'abc', locationId: 'loc' })).toBeNull()
    if (prev) process.env.OPENAI_API_KEY = prev
  })
})
