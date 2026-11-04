// VOICENOTE.1 — the web inbox's live refresh when a voice note's transcript
// lands. The transcript is written by an UPDATE after the row's INSERT, and
// the thread loader skips a refetch whose message count and last id are
// unchanged (WAInbox fetchMessages' thread signature), so the handler must
// force it. The subscription is filtered to audio rows: every delivery and
// read receipt is an UPDATE on whatsapp_messages too.
import { isVoiceTranscriptUpdate } from '@shared/voice-note'

export const VOICE_TRANSCRIPT_SUBSCRIPTION = Object.freeze({
  event: 'UPDATE',
  schema: 'public',
  table: 'whatsapp_messages',
  filter: 'message_type=eq.audio',
})

export function handleVoiceTranscriptUpdate(payload, { selectedId, forceRefetch }) {
  const row = payload?.new
  const convId = row?.conversation_id
  if (!convId || convId !== selectedId) return
  if (!isVoiceTranscriptUpdate(row)) return
  forceRefetch(convId)
}
