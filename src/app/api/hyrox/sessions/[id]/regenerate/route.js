// HYROX-TC.2 — POST /api/hyrox/sessions/[id]/regenerate: re-run generation
// for a single session (same week/slot/dial/charter as the original), and
// force the result back to draft so it re-enters coach review. Same
// auth/permission/404 gates as the sibling PUT route (detail-route IDOR
// posture — a missing row and a permission-denied row both read as 404).
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { logError } from '@/lib/log'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { anthropicMessages } from '@/lib/anthropic'
import { resolveHyroxSettings } from '@/lib/hyrox/settings'
import { expandSession, HYROX_MODEL } from '@/lib/hyrox/generate'
import { summarizePrevWeek } from '@/lib/hyrox/generate-block'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// withAuth only signs the caller in; the session's studio and the
// hyrox_sessions permission there (404 either way) run here, as before.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const id = params?.id
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

  const { data: block } = await db.from('hyrox_blocks').select('arc, difficulty_dial, sessions_per_week').eq('id', row.block_id).single()
  const week = (block?.arc?.plan || []).find((w) => w.week_no === row.week_no)
  if (!week) return NextResponse.json({ success: false, error: 'No arc week' }, { status: 409 })

  const { data: loc } = await db.from('locations').select('id, name, settings').eq('id', row.location_id).single()
  const { charter, houseStyle, styleExamples } = resolveHyroxSettings(loc)

  let prevWeekSummary = null
  if (row.week_no > 1) {
    const { data: prev } = await db.from('hyrox_sessions').select('slot, focus, board').eq('block_id', row.block_id).eq('week_no', row.week_no - 1).order('slot', { ascending: true })
    prevWeekSummary = summarizePrevWeek(prev)
  }

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
    { week, slot: row.slot, dial: block.difficulty_dial, locationLabel: (loc?.name || '').toUpperCase(), charter, houseStyle, styleExamples, autoTuneSignal: null, arcPlan: block.arc?.plan, sessionsPerWeek: block.sessions_per_week, prevWeekSummary },
    { caller },
  )
  if (!sRes.ok) return NextResponse.json({ success: false, error: 'regeneration_failed' }, { status: 502 })

  const { data, error } = await db.from('hyrox_sessions')
    .update({ full_session: sRes.data.full_session, board: sRes.data.board, status: 'draft', approved_by: null, approved_at: null })
    .eq('id', id)
    .select('*')
    .single()
  if (error) {
    logError('hyrox', 'regenerated session save failed', { sessionId: id, code: error.code ?? null, message: error.message })
    return NextResponse.json({ success: false, error: 'Could not save the regenerated session.' }, { status: 400 })
  }
  return NextResponse.json({ success: true, data })
})
