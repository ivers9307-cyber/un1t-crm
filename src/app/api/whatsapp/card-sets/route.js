import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { normalizeUrlish } from '@/lib/urlish'

// C4 — operator-curated card sets for the in-session WhatsApp media
// carousel (2-10 image cards, sent from the inbox composer while the 24h
// window is open — no template approval). Stored as a jsonb array on
// locations.settings.wa_card_sets; PUT replaces the whole array (ids are
// minted client-side via crypto.randomUUID()). Meta requires consistent
// button config across cards, so each set is all-links-or-none — enforced
// here (refine) and in the settings UI. Registered in src/lib/openapi.js.

// Operators type bare domains ("un1tdublin.com/start") — normalise to
// https:// before the .url() check instead of rejecting with a generic 400.
const urlish = z.preprocess((v) => (v == null || v === '' ? undefined : normalizeUrlish(v)), z.string().url())

const CardSchema = z.object({
  image_url: urlish,
  title: z.string().min(1).max(80),
  body: z.string().max(160).optional(),
  link_url: urlish.optional(),
  link_text: z.string().max(20).optional(),
})

const CardSetSchema = z.object({
  id: uuidLike,
  name: z.string().min(1).max(60),
  // Operator-authored "when should Mia send this" context — surfaced to the
  // customer agent's system prompt (buildCardSetsBlock), never to customers.
  description: z.string().max(200).optional(),
  body_text: z.string().max(1024).optional(),
  cards: z.array(CardSchema).min(2).max(10),
}).refine(
  (s) => {
    const withLinks = s.cards.filter((c) => c.link_url).length
    return withLinks === 0 || withLinks === s.cards.length
  },
  { message: 'Cards must all have a link, or none', path: ['cards'] }
)

const CardSetsPutSchema = z.object({
  location_id: uuidLike,
  sets: z.array(CardSetSchema).max(20),
})

// GET /api/whatsapp/card-sets?location_id=… — list the location's card sets.
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).single()
  const sets = Array.isArray(loc?.settings?.wa_card_sets) ? loc.settings.wa_card_sets : []
  return NextResponse.json({ success: true, sets })
}

// PUT /api/whatsapp/card-sets — replace the location's card-set array
// (jsonb merge — read, spread, update).
export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, CardSetsPutSchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId, sets } = validation.data

  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).single()
  const settings = { ...(loc?.settings || {}), wa_card_sets: sets }
  await db.from('locations').update({ settings }).eq('id', locationId)

  return NextResponse.json({ success: true, sets })
}
