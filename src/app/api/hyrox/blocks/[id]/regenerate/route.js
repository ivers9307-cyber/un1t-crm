// HYROX-TC — POST /api/hyrox/blocks/[id]/regenerate: start the block over with a
// brand-new plan. Re-runs the arc generator (a fresh 12-week periodised plan),
// deletes every NON-published session, and writes the new arc onto the block.
// Published sessions are left untouched — they may be live on a gym TV, so we
// never wipe them; the operator fills the now-empty weeks with "Generate
// remaining weeks". Destructive, so the client confirms before calling.
// Same 404-not-403 detail-route posture as the sibling expand/regenerate routes.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { anthropicMessages } from '@/lib/anthropic'
import { resolveHyroxSettings } from '@/lib/hyrox/settings'
import { generateArc, HYROX_MODEL } from '@/lib/hyrox/generate'

export const dynamic = 'force-dynamic'
// Arc generation is the heaviest single Claude call in the feature (max_tokens
// 8000) and can run well past 2 min. 120s timed the function out mid-call in
// prod (504, no arc, no wipe). Match the sibling arc/session generation routes
// (POST /api/hyrox/blocks, sessions/[id]/regenerate), which use 300.
export const maxDuration = 300

export async function POST(_request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: block } = await db.from('hyrox_blocks')
    .select('id, location_id, weeks, sessions_per_week, difficulty_dial')
    .eq('id', id)
    .maybeSingle()
  if (!block) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!hasPermissionForLocation(user, block.location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const { data: loc } = await db.from('locations').select('id, name, settings').eq('id', block.location_id).single()
  const { charter, houseStyle } = resolveHyroxSettings(loc)

  const caller = async ({ system, user: userMsg, maxTokens }) => {
    const { res, data } = await anthropicMessages(
      { model: HYROX_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMsg }] },
      { locationId: block.location_id, source: 'hyrox_generation' },
    )
    if (!res.ok) return { ok: false, error: `anthropic_${res.status}` }
    const text = (data?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
    return { ok: true, text }
  }

  // Generate the new plan FIRST — only wipe sessions if it succeeds, so a failed
  // arc call leaves the existing block fully intact.
  const arcRes = await generateArc(
    { weeks: block.weeks ?? 12, sessionsPerWeek: block.sessions_per_week ?? 2, dial: block.difficulty_dial ?? 'mixed', charter, houseStyle },
    { caller },
  )
  if (!arcRes.ok) return NextResponse.json({ success: false, error: 'arc_generation_failed' }, { status: 502 })

  const { data: deleted, error: delErr } = await db.from('hyrox_sessions')
    .delete()
    .eq('block_id', id)
    .neq('status', 'published')
    .select('id')
  if (delErr) return NextResponse.json({ success: false, error: delErr.message }, { status: 400 })

  const { error: updErr } = await db.from('hyrox_blocks')
    .update({ arc: arcRes.data, generated_by: HYROX_MODEL })
    .eq('id', id)
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 400 })

  return NextResponse.json({ success: true, data: { regenerated: true, sessionsDeleted: (deleted || []).length } })
}
