import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { logError } from '@/lib/log'
import { locationsWithWhatsApp } from '@/lib/whatsapp-config'
import { mergeLocationSettings, settingsSaveFailure } from '@/lib/location-settings'
import { LABEL_MAX, QUESTION_MAX, KEYWORDS_MAX, KEYWORD_LEN_MAX, DEFAULT_PICKER_QUESTION } from '@/lib/wa-studio-pick/config'

// WASTUDIOPICK.1 — the WhatsApp studio picker settings for one studio
// (locations.settings.wa_studio_picker; spec R8). GET: membership. PUT: master
// or owner AT the studio (WAROLE.1, as the card sets on the same tab).
// Registered in src/lib/openapi.js.
const PutSchema = z.object({
  location_id: uuidLike,
  listed: z.boolean(),
  label: z.string().trim().max(LABEL_MAX).default(''),
  keywords: z.array(z.string().trim().min(1).max(KEYWORD_LEN_MAX)).max(KEYWORDS_MAX).default([]),
  enabled: z.boolean().optional(),
  question: z.string().trim().max(QUESTION_MAX).optional(),
})

const NO_NUMBER_ERROR = 'This studio has no WhatsApp number, so it cannot ask the question.'

// WAORGNUMBER.1 — a studio can ask the question when an active number is
// switched on there (throws on a failed read, as before).
async function hasNumber(db, locationId) {
  return (await locationsWithWhatsApp(db, [locationId])).has(locationId)
}

const view = (p, has) => ({
  listed: p.listed === true,
  label: p.label || '',
  keywords: Array.isArray(p.keywords) ? p.keywords : [],
  enabled: p.enabled === true,
  question: p.question || '',
  has_number: has,
  default_question: DEFAULT_PICKER_QUESTION,
})

// GET /api/whatsapp/studio-picker?location_id=… — the studio's picker settings.
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const locationId = new URL(request.url).searchParams.get('location_id')
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data: loc, error } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
  if (error) {
    logError('wa-studio-picker', 'settings read failed', { locationId, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not load the settings.' }, { status: 500 })
  }
  if (!loc) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  let has
  try {
    has = await hasNumber(db, locationId)
  } catch (e) {
    logError('wa-studio-picker', 'number read failed', { locationId, err: e?.message || String(e) })
    return NextResponse.json({ success: false, error: 'Could not load the settings.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: view(loc.settings?.wa_studio_picker || {}, has) })
}

// PUT /api/whatsapp/studio-picker — save the studio's picker settings (the
// wa_studio_picker key only; mergeLocationSettings, SETTINGSWIPE.1).
export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const v = await validateBody(request, PutSchema)
  if (!v.ok) return v.response
  const { location_id: locationId, listed, label, keywords, enabled, question } = v.data

  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) return roleGuard

  const db = createServerClient()
  let has
  try {
    has = await hasNumber(db, locationId)
  } catch (e) {
    logError('wa-studio-picker', 'number read failed', { locationId, err: e?.message || String(e) })
    return NextResponse.json({ success: false, error: 'Could not save the settings.' }, { status: 500 })
  }
  if ((enabled === true || (question && question.length)) && !has) {
    return NextResponse.json({ success: false, error: NO_NUMBER_ERROR }, { status: 400 })
  }
  const next = { listed, label, keywords, enabled: has ? enabled === true : false, question: has ? (question || '') : '' }
  const saved = await mergeLocationSettings(db, locationId, (s) => ({ ...s, wa_studio_picker: next }), { scope: 'wa-studio-picker' })
  if (!saved.ok) return settingsSaveFailure(saved)
  return NextResponse.json({ success: true, data: view(next, has) })
}
