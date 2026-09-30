import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { setConversationalAutomation } from '@/lib/whatsapp'
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { logError } from '@/lib/log'
import { mergeLocationSettings } from '@/lib/location-settings'

const ConversationalAutomationSchema = z.object({
  location_id: uuidLike,
  enable_welcome: z.boolean().optional(),
  prompts: z.array(z.string().max(80)).max(4).optional(),
})

// POST /api/whatsapp/conversational-automation — configure Meta's
// conversational components for the location's WhatsApp number: the
// welcome-message event (fires the request_welcome webhook → instant
// greeting) plus up to 4 ice-breaker prompts shown to users opening a
// fresh chat. The applied config is mirrored into
// locations.settings.conversational_automation so the settings UI can
// re-hydrate it. Master or owner at the location (WAROLE.1). Registered in
// src/lib/openapi.js.
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, ConversationalAutomationSchema)
  if (!validation.ok) return validation.response
  const locationId = validation.data.location_id
  const enableWelcome = validation.data.enable_welcome !== false
  const prompts = (validation.data.prompts || []).map((p) => p.trim()).filter(Boolean)

  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  // WAROLE.1 — membership alone let any staff member change what Meta shows
  // a customer opening a chat with this number. Master, or owner AT this
  // location: the rule of the settings page this card lives on and of the
  // number routes on the same tab. Decided BEFORE the Meta call.
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) return roleGuard

  // WAROLE.1 — the openers go on THIS location's own number. Passing the
  // location id to setConversationalAutomation re-resolved it through
  // getWhatsAppConfig, which falls back to the global WHATSAPP_* env number
  // when the location has no active whatsapp_numbers row: an owner of a
  // studio without a number rewrote the openers on another studio's number,
  // while the mirror below went to their own location. No number here → 409,
  // Meta is never called; a failed lookup is a 500, never "no number".
  let numberConfig
  try {
    numberConfig = await getLocationWhatsAppNumberConfig(locationId)
  } catch (e) {
    logError('wa-conversational-automation', 'number lookup failed', { locationId, err: e?.message })
    return NextResponse.json({ success: false, error: "Could not check this location's WhatsApp number just now." }, { status: 500 })
  }
  if (!numberConfig) {
    return NextResponse.json({ success: false, error: 'No WhatsApp number is connected at this location.' }, { status: 409 })
  }

  try {
    await setConversationalAutomation({ enableWelcome, prompts }, { config: numberConfig })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || 'Meta conversational_automation call failed' }, { status: 502 })
  }

  // Mirror the applied config onto the location so the UI shows what's live
  // at Meta. SETTINGSWIPE.1: this used to read with the error discarded and
  // bare-write the whole column, so a blip wiped every other settings key and
  // still said success. Meta already has the openers (the source of truth,
  // and idempotent), so a failed mirror says exactly that.
  const db = createServerClient()
  const saved = await mergeLocationSettings(
    db,
    locationId,
    (s) => ({ ...s, conversational_automation: { enable_welcome: enableWelcome, prompts } }),
    { scope: 'wa-conversational-automation' },
  )
  if (!saved.ok) {
    return NextResponse.json({
      success: false,
      applied_at_meta: true,
      error: 'The chat openers are live on WhatsApp, but this screen could not record them just now. Save again so it shows what is live.',
    }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { enable_welcome: enableWelcome, prompts } })
}
