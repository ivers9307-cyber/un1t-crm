// VOICEREPLY.1 — the studio's voices for Mia's voice replies: one per kind of
// reply (leads and trials, bookings, member questions, the hand-off message,
// a default), the AI notice line (empty by default) and the buttons line.
// Owners and managers at the active studio (and masters); 404 for a studio the
// caller is not at. Stored in locations.settings.voice_replies.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { listVoices } from '@/lib/elevenlabs'
import { mergeLocationSettings, settingsSaveFailure } from '@/lib/location-settings'
import { canEditVoices, studioVoiceSettings, VoiceSettingsSchema } from '@/lib/wa-voice/voice-settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function gate() {
  const user = await getCurrentUser()
  if (!user) return { response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  const locationId = user.activeLocation?.id
  if (!locationId) return { response: NextResponse.json({ success: false, error: 'No active location' }, { status: 400 }) }
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return { response: guard }
  if (!canEditVoices(user, locationId)) {
    return { response: NextResponse.json({ success: false, error: 'Only an owner or manager can change Mia’s voices.' }, { status: 403 }) }
  }
  return { user, locationId }
}

export async function GET() {
  const g = await gate()
  if (g.response) return g.response
  const db = createServerClient()
  const { data: loc, error } = await db.from('locations').select('settings').eq('id', g.locationId).maybeSingle()
  if (error) return NextResponse.json({ success: false, error: 'Could not read this studio’s settings.' }, { status: 500 })
  const voices = await listVoices()
  return NextResponse.json({
    success: true,
    data: { ...studioVoiceSettings(loc?.settings), available: voices.ok ? voices.voices : [] },
    ...(voices.ok ? {} : { warning: 'Could not load the ElevenLabs voice list.' }),
  })
}

export async function PUT(request) {
  const g = await gate()
  if (g.response) return g.response
  const v = await validateBody(request, VoiceSettingsSchema)
  if (!v.ok) return v.response
  const body = v.data

  const available = await listVoices()
  if (!available.ok) return NextResponse.json({ success: false, error: 'Could not check the voices with ElevenLabs. Try again.' }, { status: 502 })
  const known = new Set(available.voices.map((x) => x.voice_id))
  for (const choice of Object.values(body.voices)) {
    if (choice && !known.has(choice.voice_id)) {
      return NextResponse.json({ success: false, error: 'That voice is not available on the ElevenLabs account.' }, { status: 400 })
    }
  }

  const next = {
    voices: body.voices,
    ai_notice: String(body.ai_notice || '').trim() || null,
    buttons_line: String(body.buttons_line || '').trim() || null,
  }
  const db = createServerClient()
  const result = await mergeLocationSettings(db, g.locationId, (current) => ({ ...current, voice_replies: next }), { scope: 'voice-replies' })
  if (!result.ok) return settingsSaveFailure(result)
  return NextResponse.json({ success: true, data: next })
}
