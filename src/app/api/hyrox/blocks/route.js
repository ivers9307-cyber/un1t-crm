// HYROX-TC.2 — POST /api/hyrox/blocks: generate + persist a 12-week Hyrox
// Training Club block (arc + the first `expand_weeks` weeks of sessions).
//
// Generation is metered per-tenant through anthropicMessages() (the same
// wrapper every other server-side Claude call uses — see CLAUDE.md: Mia
// stays on the Anthropic Messages API, no OpenAI anywhere). The route
// builds a `caller` closure that satisfies generate.js's injectable-caller
// contract ({ system, user, maxTokens } -> { ok, text }) while routing the
// actual network call through the metered wrapper.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate } from '@/lib/schemas'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { anthropicMessages } from '@/lib/anthropic'
import { resolveHyroxSettings } from '@/lib/hyrox/settings'
import { createBlockWithArc } from '@/lib/hyrox/generate-block'
import { HYROX_MODEL } from '@/lib/hyrox/generate'
import { DIFFICULTY_DIALS } from '@/lib/hyrox/constants'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BlockCreateSchema = z.object({
  location_id: uuidLike,
  starts_on: isoDate,
  title: z.string().max(120).optional(),
  weeks: z.number().int().min(1).max(24).optional(),
  sessions_per_week: z.number().int().min(1).max(7).optional(),
  session_weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  difficulty_dial: z.enum(DIFFICULTY_DIALS).optional(),
  auto_tune_enabled: z.boolean().optional(),
  charter: z.string().max(8000).optional(),
  expand_weeks: z.number().int().min(1).max(12).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const v = await validateBody(request, BlockCreateSchema)
  if (!v.ok) return v.response
  const body = v.data

  // Authorize the grant AT THE TARGET location (not the caller's active one):
  // a manager at location A must not generate a block for location B where they
  // lack the grant. Mirrors the per-location gate the session routes use.
  if (!hasPermissionForLocation(user, body.location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: loc } = await db.from('locations').select('id, name, settings').eq('id', body.location_id).single()
  const { charter: settingsCharter, houseStyle } = resolveHyroxSettings(loc)
  const charter = body.charter?.trim() || settingsCharter

  // Metered caller — generate.js's injectable-caller contract is
  // { system, user, maxTokens } -> { ok, text } | { ok:false, error }.
  // anthropicMessages needs a real model, not undefined — HYROX_MODEL is
  // the same model generate.js's default raw-fetch path uses.
  const caller = async ({ system, user: userMsg, maxTokens }) => {
    const { res, data } = await anthropicMessages(
      { model: HYROX_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMsg }] },
      { locationId: body.location_id, source: 'hyrox_generation' },
    )
    if (!res.ok) return { ok: false, error: `anthropic_${res.status}` }
    const text = (data?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
    return { ok: true, text }
  }

  // Fast path only: arc + insert the block, then return. Session generation is a
  // long fan-out, so it does NOT run inline here (that timed the request out and
  // left orphaned blocks). The client drives per-week expansion via
  // POST /api/hyrox/blocks/[id]/expand; the rolling cron fills the rest.
  const out = await createBlockWithArc(db, {
    input: { ...body, created_by: user.id },
    charter,
    houseStyle,
    caller,
  })
  if (!out.ok) return NextResponse.json({ success: false, error: out.error }, { status: 502 })
  return NextResponse.json({ success: true, data: { block: out.block, sessionsCreated: 0 } }, { status: 201 })
}
