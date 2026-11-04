// VOICEREPLY.1 — send one of Mia's replies as a WhatsApp voice note.
//
// The gate and the send (spec §4): the org's mode and test numbers, the
// monthly cap, the studio's voice for this kind, the length, ElevenLabs
// text-to-speech, the Ogg check, storage, the voice-note send through the
// thread's own number, and metering. The caller (src/lib/agent/auto-reply.js)
// sends today's text on any `sent: false`, so this never loses a reply.
//
// Never throws. The spoken text is never logged.

import { randomUUID } from 'node:crypto'
import { logWarn, logError } from '@/lib/log'
import { sendMediaMessage } from '@/lib/whatsapp'
import { synthesizeSpeech, ELEVENLABS_TTS_CENTS_PER_1K_CHARS, ELEVENLABS_TTS_MODEL } from '@/lib/elevenlabs'
import { recordMeterUsage } from '@/lib/usage'
import { getVoiceReplyCapStatus, VOICE_REPLY_METER } from '@/lib/usage-caps'
import { signedMediaUrl } from '@/lib/whatsapp-media-server'
import { buildMediaObjectPath, WHATSAPP_MEDIA_BUCKET } from '@shared/whatsapp-media'
import { phoneMatchesAllowlist } from '@/lib/agent/core'
import { MAX_SPOKEN_CHARS, voiceFor, isOggOpus } from './reply-rules.js'

export const VOICE_REPLY_URL_TTL_SECS = 3600
export const VOICE_CHARS_METER = 'elevenlabs_tts_characters'
export const VOICE_REPLY_SOURCE = 'wa_voice_reply'
export const DEFAULT_BUTTONS_LINE = 'Tap an option:'

/**
 * @param {object} db service-role client
 * @param {{ conversationId: string, locationId: string, recipient: string, spoken: string, kind: string, replyOpts: object }} input
 * @param {{ synthesize?: Function, capStatus?: Function, sendMedia?: Function }} [deps]
 */
export async function maybeSendVoiceReply(db, { conversationId, locationId, recipient, spoken, kind, replyOpts = {} } = {}, deps = {}) {
  const synthesize = deps.synthesize || synthesizeSpeech
  const capStatus = deps.capStatus || ((q) => getVoiceReplyCapStatus(q, { db }))
  const sendMedia = deps.sendMedia || sendMediaMessage
  const ids = { conversationId, locationId, kind }
  const refuse = (reason, extra = {}) => {
    logWarn('wa-voice-reply', 'reply sent as text, not voice', { ...ids, reason, ...extra })
    return { sent: false, reason }
  }

  try {
    const { data: loc, error: locError } = await db
      .from('locations')
      .select('organization_id, settings')
      .eq('id', locationId)
      .maybeSingle()
    if (locError || !loc?.organization_id) return refuse('settings_unreadable')
    const studio = loc.settings?.voice_replies || {}

    const { data: org, error: orgError } = await db
      .from('org_settings')
      .select('voice_reply_mode, voice_reply_test_phones')
      .eq('organization_id', loc.organization_id)
      .maybeSingle()
    if (orgError) return refuse('settings_unreadable')
    const mode = org?.voice_reply_mode || 'off'
    if (mode === 'off') return refuse('disabled')
    if (mode === 'test' && !phoneMatchesAllowlist(recipient, org?.voice_reply_test_phones || [])) return refuse('not_in_test_list')
    if (mode !== 'test' && mode !== 'on') return refuse('disabled')

    const cap = await capStatus({ organizationId: loc.organization_id })
    if (cap?.capped) return refuse('capped')

    const voice = voiceFor(kind, studio.voices)
    if (!voice) return refuse('no_voice')
    const voiceKind = studio.voices?.[kind]?.voice_id === voice.voice_id ? kind : 'default'

    const text = String(spoken || '').trim()
    if (!text) return refuse('nothing_to_speak')
    if (text.length > MAX_SPOKEN_CHARS) return refuse('too_long')

    const speech = await synthesize({ text, voiceId: voice.voice_id })
    if (!speech?.ok) return refuse(speech?.reason || 'bad_response', { httpStatus: speech?.status ?? null })
    if (!isOggOpus(speech.bytes)) return refuse('not_ogg')

    // Metered once ElevenLabs answered, whatever happens to the send.
    await meter(db, { organizationId: loc.organization_id, locationId, chars: text.length })

    const storagePath = buildMediaObjectPath({ locationId, messageId: `voice-reply-${randomUUID()}`, mime: 'audio/ogg' })
    const { error: uploadError } = await db.storage
      .from(WHATSAPP_MEDIA_BUCKET)
      .upload(storagePath, speech.bytes, { contentType: 'audio/ogg', upsert: false })
    if (uploadError) return refuse('upload_failed')
    const url = await signedMediaUrl(db, storagePath, VOICE_REPLY_URL_TTL_SECS)
    if (!url) return refuse('upload_failed')

    let sent
    try {
      sent = await sendMedia(recipient, 'audio', url, null, { ...replyOpts, voice: true })
    } catch (err) {
      return refuse('send_failed', { error: err?.message || String(err) })
    }

    return {
      sent: true,
      messageId: sent?.messageId || null,
      storagePath,
      voiceKind,
      chars: text.length,
      buttonsLine: String(studio.buttons_line || '').trim() || DEFAULT_BUTTONS_LINE,
      aiNotice: String(studio.ai_notice || '').trim() || null,
    }
  } catch (err) {
    logError('wa-voice-reply', 'voice reply threw', { ...ids, error: err?.message || String(err) })
    return { sent: false, reason: 'send_failed' }
  }
}

async function meter(db, { organizationId, locationId, chars }) {
  try {
    await recordMeterUsage({
      organizationId, locationId, meter: VOICE_CHARS_METER, source: VOICE_REPLY_SOURCE,
      quantity: chars, costCents: (chars / 1000) * ELEVENLABS_TTS_CENTS_PER_1K_CHARS, meta: { model: ELEVENLABS_TTS_MODEL },
    }, { db })
    await recordMeterUsage({
      organizationId, locationId, meter: VOICE_REPLY_METER, source: VOICE_REPLY_SOURCE,
      quantity: 1, costCents: 0, meta: { model: ELEVENLABS_TTS_MODEL },
    }, { db })
  } catch (err) {
    logError('wa-voice-reply', 'voice reply metering threw', { locationId, error: err?.message || String(err) })
  }
}
