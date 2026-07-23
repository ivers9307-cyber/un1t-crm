// HYROX-TC.2 — POST /api/hyrox/sessions/[id]/regenerate: re-run generation
// for a single session (same week/slot/dial/charter as the original), and
// force the result back to draft so it re-enters coach review. Same
// auth/permission/404 gates as the sibling PUT route (detail-route IDOR
// posture — a missing row and a permission-denied row both read as 404).
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { anthropicMessages } from '@/lib/anthropic'
import { resolveHyroxSettings } from '@/lib/hyrox/settings'
import { expandSession, HYROX_MODEL } from '@/lib/hyrox/generate'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(_request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: row } = await db.from('hyrox_sessions')
    .select('id, block_id, location_id, week_no, slot, status')
    .eq('id', id)
    .maybeSingle()
  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  if (!hasPermissionForLocation(user, row.location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (row.status === 'published') {
    return NextResponse.json({ success: false, error: 'Already published' }, { status: 409 })
  }

  const { data: block } = await db.from('hyrox_blocks').select('arc, difficulty_dial').eq('id', row.block_id).single()
  const week = (block?.arc?.plan || []).find((w) => w.week_no === row.week_no)
  if (!week) return NextResponse.json({ success: false, error: 'No arc week' }, { status: 409 })

  const { data: loc } = await db.from('locations').select('id, name, settings').eq('id', row.location_id).single()
  const charter = resolveHyroxSettings(loc).charter

  // Same metered-caller closure as the blocks route — anthropicMessages
  // needs a real model (HYROX_MODEL), not undefined.
  const caller = async ({ system, user: userMsg, maxTokens }) => {
    const { res, data } = await anthropicMessages(
      { model: HYROX_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMsg }] },
      { locationId: row.location_id, source: 'hyrox_generation' },
    )
    if (!res.ok) return { ok: false, error: `anthropic_${res.status}` }
    const text = (data?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
    return { ok: true, text }
  }

  const sRes = await expandSession(
    { week, slot: row.slot, dial: block.difficulty_dial, locationLabel: (loc?.name || 'UN1T').toUpperCase(), charter, autoTuneSignal: null },
    { caller },
  )
  if (!sRes.ok) return NextResponse.json({ success: false, error: 'regeneration_failed' }, { status: 502 })

  const { data, error } = await db.from('hyrox_sessions')
    .update({ full_session: sRes.data.full_session, board: sRes.data.board, status: 'draft', approved_by: null, approved_at: null })
    .eq('id', id)
    .select('*')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
