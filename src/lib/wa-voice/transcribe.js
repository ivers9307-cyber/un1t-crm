// VOICENOTE.1 — transcribe one inbound WhatsApp voice note, before Mia's turn.
//
// Called by the WhatsApp webhook between the media rehost and maybeAutoReply.
// The steps (spec §3), in order: the org switch, the monthly cap, the stored
// bytes, the length, ElevenLabs Scribe, the clarity judge, metering, and the
// row write. Mia reads history from the row, so the result only counts once it
// is on the row: a failed write returns `failed`.
//
// Never throws, and always leaves a final status on the row (the webhook wrote
// `pending` at insert). The transcript text is never logged.

import { createServerClient } from '@/lib/supabase'
import { logWarn, logError } from '@/lib/log'
import { transcribeAudio, ELEVENLABS_STT_CENTS_PER_MINUTE, ELEVENLABS_STT_MODEL } from '@/lib/elevenlabs'
import { recordMeterUsage } from '@/lib/usage'
import { getVoiceCapStatus } from '@/lib/usage-caps'
import { exceedsVoiceLimit } from './audio.js'
import { judgeTranscript } from './judge.js'

export const VOICE_MEDIA_BUCKET = 'whatsapp-media'
export const VOICE_METER = 'elevenlabs_stt_seconds'
export const VOICE_USAGE_SOURCE = 'wa_voice_note'
export const FIXED_KEYTERMS = Object.freeze(['UN1T', 'HYROX', 'Glofox', 'class pack', 'trial'])

// An `ok` voice note whose own agent turn sent nothing for one of these reasons
// lost the turn to a concurrent message (a quick text right after it), and the
// missed-inbound rerun cannot catch it because it is older than that text. The
// webhook hands it to staff silently (markVoiceNoteForStaff).
export const VOICE_LOST_TURN_REASONS = new Set(['in_flight', 'nothing_to_answer'])

const MAX_TERM_CHARS = 50
const MAX_TERM_WORDS = 5

function fitTerm(term) {
  const t = String(term || '').trim().replace(/\s+/g, ' ')
  if (!t || t.length > MAX_TERM_CHARS || t.split(' ').length > MAX_TERM_WORDS) return null
  return t
}

/**
 * Words Scribe should expect: the studio's name, the first names of the staff
 * attached to the studio, and a fixed brand list. A failed staff read drops
 * only the names. Never throws.
 */
export async function buildKeyterms(db, locationId, { studioName = null } = {}) {
  const names = []
  try {
    const { data, error } = await db
      .from('profile_locations')
      .select('profiles:profile_id(full_name, active, deleted_at)')
      .eq('location_id', locationId)
      .limit(200)
    if (!error) {
      for (const row of data || []) {
        const p = row?.profiles
        if (!p || p.active !== true || p.deleted_at) continue
        const first = String(p.full_name || '').trim().split(/\s+/)[0]
        if (first) names.push(first.charAt(0).toUpperCase() + first.slice(1))
      }
    }
  } catch {
    // names are a nice-to-have
  }
  const out = []
  const seen = new Set()
  for (const term of [studioName, ...names, ...FIXED_KEYTERMS]) {
    const t = fitTerm(term)
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
  }
  return out
}

/**
 * @param {object} db service-role client
 * @param {{ messageId: string, locationId: string, storagePath: string|null, mime?: string|null }} input
 * @param {{ transcribe?: Function, recordUsage?: Function, voiceCap?: Function, now?: () => Date }} [deps]
 * @returns {Promise<{ status: string, transcript: string|null, language: string|null }>}
 */
export async function transcribeInboundVoiceNote(db, { messageId, locationId, storagePath, mime = null } = {}, deps = {}) {
  const transcribe = deps.transcribe || transcribeAudio
  const recordUsage = deps.recordUsage || ((evt) => recordMeterUsage(evt, { db }))
  const voiceCap = deps.voiceCap || ((q) => getVoiceCapStatus(q, { db }))
  const now = deps.now || (() => new Date())
  const ids = { messageId, locationId }
  const client = db || createServerClient()

  const finish = async (status, { transcript = null, language = null } = {}) => {
    if (status !== 'ok') logWarn('wa-voice', 'voice note not answerable by Mia', { ...ids, status })
    const written = await writeResult(client, messageId, { status, transcript, language, at: now() })
    if (!written) return { status: 'failed', transcript: null, language: null }
    return { status, transcript, language }
  }

  try {
    // 1. The org switch. A read failure fails closed to today's hand-off.
    const { data: location, error: locationError } = await client
      .from('locations')
      .select('name, organization_id')
      .eq('id', locationId)
      .maybeSingle()
    if (locationError || !location?.organization_id) return await finish('failed')
    const organizationId = location.organization_id
    const { data: settings, error: settingsError } = await client
      .from('org_settings')
      .select('voice_transcription_enabled')
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (settingsError) return await finish('failed')
    if (settings?.voice_transcription_enabled !== true) return await finish('disabled')

    // 2. The monthly cap (fails open inside getVoiceCapStatus).
    const cap = await voiceCap({ organizationId })
    if (cap?.capped) return await finish('capped')

    // 3. The bytes the rehost just stored. No second Meta media fetch.
    if (!storagePath) return await finish('failed')
    const { data: blob, error: downloadError } = await client.storage.from(VOICE_MEDIA_BUCKET).download(storagePath)
    if (downloadError || !blob) return await finish('failed')
    const bytes = new Uint8Array(await blob.arrayBuffer())

    // 4. The length, before paying.
    const { tooLong, durationSecs: oggSecs } = exceedsVoiceLimit(bytes)
    if (tooLong) return await finish('too_long')

    // 5. Scribe.
    const keyterms = await buildKeyterms(client, locationId, { studioName: location.name })
    const result = await transcribe({ bytes, mime: mime || blob.type || 'audio/ogg', keyterms })
    if (!result?.ok) {
      if (result?.reason === 'not_configured') return await finish('not_configured')
      logWarn('wa-voice', 'transcription call failed', { ...ids, reason: result?.reason, httpStatus: result?.status ?? null })
      return await finish('failed')
    }

    // 6. Clarity.
    const text = String(result.text || '').trim()
    const status = judgeTranscript({ text, languageProbability: result.languageProbability, words: result.words })

    // 7. Metering, only when ElevenLabs answered.
    const seconds = result.durationSecs ?? oggSecs
    if (seconds == null) logWarn('wa-voice', 'no audio duration to meter', ids)
    const quantity = seconds ?? 0
    try {
      await recordUsage({
        organizationId,
        locationId,
        meter: VOICE_METER,
        source: VOICE_USAGE_SOURCE,
        quantity,
        costCents: (quantity / 60) * ELEVENLABS_STT_CENTS_PER_MINUTE,
        meta: { model: ELEVENLABS_STT_MODEL },
      })
    } catch (err) {
      logError('wa-voice', 'usage record threw', { ...ids, error: err?.message || String(err) })
    }

    // 8. The row.
    return await finish(status, { transcript: text || null, language: result.languageCode || null })
  } catch (err) {
    logError('wa-voice', 'voice transcription threw', { ...ids, error: err?.message || String(err) })
    try {
      return await finish('failed')
    } catch {
      return { status: 'failed', transcript: null, language: null }
    }
  }
}

async function writeResult(client, messageId, { status, transcript, language, at }) {
  const patch = {
    transcript: status === 'ok' || status === 'unclear' ? transcript : null,
    transcript_status: status,
    transcript_language: status === 'ok' || status === 'unclear' ? language : null,
    transcribed_at: at.toISOString(),
  }
  try {
    const { data, error } = await client.from('whatsapp_messages').update(patch).eq('id', messageId).select('id')
    if (!error && Array.isArray(data) && data.length > 0) return true
    logError('wa-voice', 'transcript row write failed', { messageId, status, error: error?.message || 'no row updated' })
  } catch (err) {
    logError('wa-voice', 'transcript row write threw', { messageId, status, error: err?.message || String(err) })
  }
  // One best-effort attempt so the row does not stay `pending`.
  try {
    const { error } = await client
      .from('whatsapp_messages')
      .update({ transcript: null, transcript_status: 'failed', transcript_language: null, transcribed_at: at.toISOString() })
      .eq('id', messageId)
      .select('id')
    if (error) logError('wa-voice', 'failed-status fallback write failed', { messageId, error: error.message })
  } catch (err) {
    logError('wa-voice', 'failed-status fallback write threw', { messageId, error: err?.message || String(err) })
  }
  return false
}
