// VOICEREPLY.1 — "Play sample" on the voices card: a fixed sentence in one of
// the account's voices, as mp3 for the browser. Same gate as the voices route.
// Metered like a voice reply (characters and one reply).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { listVoices, synthesizeSpeech, ELEVENLABS_TTS_CENTS_PER_1K_CHARS, ELEVENLABS_TTS_MODEL } from '@/lib/elevenlabs'
import { recordMeterUsage } from '@/lib/usage'
import { VOICE_REPLY_METER } from '@/lib/usage-caps'
import { canEditVoices, SAMPLE_SENTENCE } from '@/lib/wa-voice/voice-settings'
import { VOICE_CHARS_METER } from '@/lib/wa-voice/reply'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SampleSchema = z.object({ voice_id: z.string().trim().min(1).max(64) }).strict()

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!canEditVoices(user, locationId)) {
    return NextResponse.json({ success: false, error: 'Only an owner or manager can try Mia’s voices.' }, { status: 403 })
  }
  const v = await validateBody(request, SampleSchema)
  if (!v.ok) return v.response

  const available = await listVoices()
  if (!available.ok) return NextResponse.json({ success: false, error: 'Could not reach ElevenLabs. Try again.' }, { status: 502 })
  if (!available.voices.some((x) => x.voice_id === v.data.voice_id)) {
    return NextResponse.json({ success: false, error: 'That voice is not available on the ElevenLabs account.' }, { status: 400 })
  }

  const speech = await synthesizeSpeech({ text: SAMPLE_SENTENCE, voiceId: v.data.voice_id, outputFormat: 'mp3_44100_64' })
  if (!speech.ok) return NextResponse.json({ success: false, error: 'ElevenLabs could not make the sample. Try again.' }, { status: 502 })

  const db = createServerClient()
  const { data: loc } = await db.from('locations').select('organization_id').eq('id', locationId).maybeSingle()
  const meta = { model: ELEVENLABS_TTS_MODEL, sample: true }
  await recordMeterUsage({ organizationId: loc?.organization_id || null, locationId, meter: VOICE_CHARS_METER, source: 'voice_reply_sample', quantity: SAMPLE_SENTENCE.length, costCents: (SAMPLE_SENTENCE.length / 1000) * ELEVENLABS_TTS_CENTS_PER_1K_CHARS, meta }, { db })
  await recordMeterUsage({ organizationId: loc?.organization_id || null, locationId, meter: VOICE_REPLY_METER, source: 'voice_reply_sample', quantity: 1, costCents: 0, meta }, { db })

  return new Response(speech.bytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } })
}
