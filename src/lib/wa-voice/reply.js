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
 * `voiceLocationId` (VOICESTUDIO.1) is the studio whose voices speak the
 * reply, from voiceReplyPossible: the thread's studio, or another studio of
 * the same organisation the person is an active member at when the thread's
 * has no voice. Its whole voice_replies block (voices, buttons line, AI
 * notice) travels together. Mode, test numbers, cap, metering and the send
 * stay the thread's.
 *
 * @param {object} db service-role client
 * @param {{ conversationId: string, locationId: string, recipient: string, spoken: string, kind: string, replyOpts: object, voiceLocationId?: string|null }} input
 * @param {{ synthesize?: Function, capStatus?: Function, sendMedia?: Function }} [deps]
 */
export async function maybeSendVoiceReply(db, { conversationId, locationId, recipient, spoken, kind, replyOpts = {}, voiceLocationId = null } = {}, deps = {}) {
  const synthesize = deps.synthesize || synthesizeSpeech
  const capStatus = deps.capStatus || ((q) => getVoiceReplyCapStatus(q, { db }))
  const sendMedia = deps.sendMedia || ((...a) => sendMediaMessage(...a))
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
    let studio = loc.settings?.voice_replies || {}
    if (voiceLocationId && voiceLocationId !== locationId) {
      const { data: vLoc, error: vLocError } = await db
        .from('locations')
        .select('organization_id, settings')
        .eq('id', voiceLocationId)
        .maybeSingle()
      if (vLocError) return refuse('settings_unreadable')
      // Another organisation's studio never lends its voices.
      studio = vLoc?.organization_id === loc.organization_id ? (vLoc.settings?.voice_replies || {}) : {}
    }

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

const hasAnyVoice = (settings) => {
  const voices = settings?.voice_replies?.voices
  return !!voices && typeof voices === 'object' && Object.values(voices).some((v) => v && String(v.voice_id || '').trim())
}

/**
 * VOICEREPLY.1 (review I3) — could a voice reply go to this recipient at all?
 * The org's mode and test numbers and a configured voice, without the cap or
 * any speech. The agent asks before building the prompt, so the spoken-reply
 * line never reaches a turn whose reply will be text anyway. Never throws.
 *
 * VOICESTUDIO.1 — the voice is the thread studio's; when that studio has
 * none, the first of `memberLocationIds` (studios the person is an active
 * member at, from the turn's member-studio resolution) in the same
 * organisation that has one. A Hatch member whose thread files at Stillorgan
 * used to get text only because of where the thread filed.
 *
 * @returns {Promise<{ possible: true, voiceLocationId: string } | { possible: false, reason: string }>}
 *   reason: 'settings_unreadable' | 'disabled' | 'not_in_test_list' | 'no_voice'
 */
export async function voiceReplyPossible(db, { locationId, recipient, memberLocationIds = [] } = {}) {
  const no = (reason) => ({ possible: false, reason })
  try {
    const { data: loc, error: locError } = await db.from('locations').select('organization_id, settings').eq('id', locationId).maybeSingle()
    if (locError || !loc?.organization_id) return no('settings_unreadable')
    const { data: org, error: orgError } = await db.from('org_settings')
      .select('voice_reply_mode, voice_reply_test_phones').eq('organization_id', loc.organization_id).maybeSingle()
    if (orgError) return no('settings_unreadable')
    const mode = org?.voice_reply_mode || 'off'
    if (mode === 'test') {
      if (!phoneMatchesAllowlist(recipient, org?.voice_reply_test_phones || [])) return no('not_in_test_list')
    } else if (mode !== 'on') {
      return no('disabled')
    }

    if (hasAnyVoice(loc.settings)) return { possible: true, voiceLocationId: locationId }

    const others = [...new Set((Array.isArray(memberLocationIds) ? memberLocationIds : []).filter((id) => id && id !== locationId))]
    if (!others.length) return no('no_voice')
    const { data: rows, error: rowsError } = await db.from('locations').select('id, organization_id, settings').in('id', others)
    if (rowsError) return no('settings_unreadable')
    const byId = new Map((rows || []).map((r) => [r.id, r]))
    const lender = others.map((id) => byId.get(id)).find((r) => r && r.organization_id === loc.organization_id && hasAnyVoice(r.settings))
    return lender ? { possible: true, voiceLocationId: lender.id } : no('no_voice')
  } catch {
    return no('settings_unreadable')
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
