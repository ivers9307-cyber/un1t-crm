// VOICEREPLY.1 — "Check voice setup" on the voices card. Runs, on the live
// server with the key already in Vercel, the two facts ElevenLabs' docs leave
// open: does each model answer on the text-to-speech endpoint, and does the
// Opus output come back in an Ogg container (what WhatsApp needs for a voice
// note)? Sends exactly the request the voice replies send. The key never
// appears in the answer. Same gate as the voices route. Metered as characters
// only (not as voice replies, so it never uses up the monthly limit).

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { listVoices, synthesizeSpeech, ELEVENLABS_TTS_MODEL, ELEVENLABS_TTS_CENTS_PER_1K_CHARS } from '@/lib/elevenlabs'
import { recordMeterUsage } from '@/lib/usage'
import { isOggOpus } from '@/lib/wa-voice/reply-rules'
import { VOICE_CHARS_METER } from '@/lib/wa-voice/reply'
import { canEditVoices, SAMPLE_SENTENCE } from '@/lib/wa-voice/voice-settings'
import { VOICE_KINDS } from '@shared/voice-note'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CHECK_MODELS = Object.freeze(['eleven_v4_turbo', 'eleven_flash_v2_5'])

export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!canEditVoices(user, locationId)) {
    return NextResponse.json({ success: false, error: 'Only an owner or manager can check Mia’s voices.' }, { status: 403 })
  }

  const result = { key: !!process.env.ELEVENLABS_API_KEY, voices: { ok: false, count: 0, tested: null }, models: [], inUse: ELEVENLABS_TTS_MODEL, ready: false }
  if (!result.key) return NextResponse.json({ success: true, data: result })

  const available = await listVoices()
  if (!available.ok) return NextResponse.json({ success: true, data: result })
  result.voices.ok = true
  result.voices.count = available.voices.length

  // The studio's own saved voice when there is one, else the account's first.
  const db = createServerClient()
  const { data: loc } = await db.from('locations').select('organization_id, settings').eq('id', locationId).maybeSingle()
  const saved = loc?.settings?.voice_replies?.voices || {}
  const savedVoice = [...VOICE_KINDS].reverse().map((k) => saved[k]).find((v) => v?.voice_id && available.voices.some((a) => a.voice_id === v.voice_id))
  const voice = savedVoice || available.voices[0]
  if (!voice) return NextResponse.json({ success: true, data: result })
  result.voices.tested = voice.name || voice.voice_id

  for (const model of CHECK_MODELS) {
    const speech = await synthesizeSpeech({ text: SAMPLE_SENTENCE, voiceId: voice.voice_id, outputFormat: 'opus_48000_64', modelId: model })
    if (!speech.ok) {
      result.models.push({ model, accepted: false, status: speech.status ?? null, ogg: null })
      continue
    }
    result.models.push({ model, accepted: true, status: null, ogg: isOggOpus(speech.bytes) })
    await recordMeterUsage({
      organizationId: loc?.organization_id || null, locationId, meter: VOICE_CHARS_METER, source: 'voice_reply_check',
      quantity: SAMPLE_SENTENCE.length, costCents: (SAMPLE_SENTENCE.length / 1000) * ELEVENLABS_TTS_CENTS_PER_1K_CHARS, meta: { model, check: true },
    }, { db })
  }
  const inUse = result.models.find((m) => m.model === ELEVENLABS_TTS_MODEL)
  result.ready = !!(inUse?.accepted && inUse.ogg)
  return NextResponse.json({ success: true, data: result })
}
