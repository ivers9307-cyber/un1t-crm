import { test, expect, vi } from 'vitest'
import { VOICE_TRANSCRIPT_SUBSCRIPTION, handleVoiceTranscriptUpdate } from './wa-voice-realtime.js'

test('subscribes to voice-note row updates only, not every receipt (review M-3)', () => {
  expect(VOICE_TRANSCRIPT_SUBSCRIPTION).toEqual({ event: 'UPDATE', schema: 'public', table: 'whatsapp_messages', filter: 'message_type=eq.audio' })
})

test('a transcript landing on the open thread forces a refetch past the unchanged thread signature (review I-1)', () => {
  const forceRefetch = vi.fn()
  handleVoiceTranscriptUpdate({ new: { conversation_id: 'c1', message_type: 'audio', transcript_status: 'ok' } }, { selectedId: 'c1', forceRefetch })
  expect(forceRefetch).toHaveBeenCalledWith('c1')
})

test('another thread, a pending row or a receipt does nothing', () => {
  const forceRefetch = vi.fn()
  handleVoiceTranscriptUpdate({ new: { conversation_id: 'c2', message_type: 'audio', transcript_status: 'ok' } }, { selectedId: 'c1', forceRefetch })
  handleVoiceTranscriptUpdate({ new: { conversation_id: 'c1', message_type: 'audio', transcript_status: 'pending' } }, { selectedId: 'c1', forceRefetch })
  handleVoiceTranscriptUpdate({ new: { conversation_id: 'c1', message_type: 'text', status: 'read' } }, { selectedId: 'c1', forceRefetch })
  handleVoiceTranscriptUpdate(null, { selectedId: 'c1', forceRefetch })
  expect(forceRefetch).not.toHaveBeenCalled()
})
