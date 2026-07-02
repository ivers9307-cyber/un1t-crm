import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { setConversationalAutomation } from '@/lib/whatsapp'

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
// re-hydrate it. Registered in src/lib/openapi.js.
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

  try {
    await setConversationalAutomation({ enableWelcome, prompts }, { locationId })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || 'Meta conversational_automation call failed' }, { status: 502 })
  }

  // Mirror the applied config onto the location (jsonb merge — read,
  // spread, update) so the UI shows what's live at Meta.
  const db = createServerClient()
  const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).single()
  const settings = {
    ...(loc?.settings || {}),
    conversational_automation: { enable_welcome: enableWelcome, prompts },
  }
  await db.from('locations').update({ settings }).eq('id', locationId)

  return NextResponse.json({ success: true, data: { enable_welcome: enableWelcome, prompts } })
}
