// HYROX-TC.3 — POST /api/hyrox/blocks/[id]/expand: generate ONE week's sessions
// for a block. Bounded (its sessions run in parallel, ~one Claude call wall-clock)
// so it never times out, unlike the old inline-all-weeks fan-out. The planner
// calls this per week after creating a block; idempotent per (block, week).
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { anthropicMessages } from '@/lib/anthropic'
import { HYROX_MODEL } from '@/lib/hyrox/generate'
import { resolveHyroxSettings } from '@/lib/hyrox/settings'
import { expandBlockWeek } from '@/lib/hyrox/generate-block'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const ExpandSchema = z.object({ week_no: z.number().int().min(1).max(52) })

// expandBlockWeek's own codes reach the planner; anything else (database text)
// is logged and answered with a fixed code.
const EXPAND_CODES = new Set(['no_arc_week', 'session_generation_failed'])

// withAuth only signs the caller in; the block's studio and the hyrox approval
// permission there (404), then the body, follow in their old order.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const id = params?.id
  const { data: block } = await db.from('hyrox_blocks').select('*').eq('id', id).maybeSingle()
  if (!block) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!hasPermissionForLocation(user, block.location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const v = await validateBody(request, ExpandSchema)
  if (!v.ok) return v.response

  const { data: loc } = await db.from('locations').select('id, name, settings').eq('id', block.location_id).single()
  const { charter, houseStyle, styleExamples } = resolveHyroxSettings(loc)

  const caller = async ({ system, user: userMsg, maxTokens }) => {
    const { res, data } = await anthropicMessages(
      { model: HYROX_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMsg }] },
      { locationId: block.location_id, source: 'hyrox_generation' },
    )
    if (!res.ok) return { ok: false, error: `anthropic_${res.status}` }
    const text = (data?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
    return { ok: true, text }
  }

  const out = await expandBlockWeek(db, {
    block,
    weekNo: v.data.week_no,
    charter,
    houseStyle,
    styleExamples,
    caller,
    locationLabel: (loc?.name || '').toUpperCase(),
  })
  if (!out.ok) {
    if (EXPAND_CODES.has(out.error)) return NextResponse.json({ success: false, error: out.error }, { status: 502 })
    logError('hyrox', 'week not expanded', { blockId: block.id, weekNo: v.data.week_no, error: out.error })
    return NextResponse.json({ success: false, error: 'session_save_failed' }, { status: 502 })
  }
  return NextResponse.json({ success: true, data: { sessionsCreated: out.sessionsCreated, skipped: Boolean(out.skipped) } })
})
