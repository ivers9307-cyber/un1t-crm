// HYROX-TC.2 — PUT /api/hyrox/sessions/[id]: coach edits and/or
// approves/un-approves a single generated session. Detail route — 404 (not
// 403) when the row is missing OR the caller lacks the per-category
// approval permission at the row's location (IDOR posture: don't let a
// caller distinguish "wrong tenant" from "doesn't exist").
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'

export const dynamic = 'force-dynamic'

const UpdateSchema = z.object({
  focus: z.string().max(200).nullish(),
  full_session: z.record(z.string(), z.any()).optional(),
  board: z.record(z.string(), z.any()).optional(),
  status: z.enum(['draft', 'approved']).optional(),
})

// withAuth only signs the caller in; the row's studio and the hyrox approval
// permission there (404), the published check and the body follow in order.
export const PUT = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const id = params?.id
  const { data: row } = await db.from('hyrox_sessions').select('id, location_id, status').eq('id', id).maybeSingle()
  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  if (!hasPermissionForLocation(user, row.location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (row.status === 'published') {
    return NextResponse.json({ success: false, error: 'Already published' }, { status: 409 })
  }

  const v = await validateBody(request, UpdateSchema)
  if (!v.ok) return v.response
  const b = v.data

  const patch = {}
  if (b.focus !== undefined) patch.focus = b.focus
  if (b.full_session !== undefined) patch.full_session = b.full_session
  if (b.board !== undefined) patch.board = b.board
  if (b.status === 'approved') {
    patch.status = 'approved'
    patch.approved_by = user.id
    patch.approved_at = new Date().toISOString()
  }
  if (b.status === 'draft') {
    patch.status = 'draft'
    patch.approved_by = null
    patch.approved_at = null
  }

  const { data, error } = await db.from('hyrox_sessions').update(patch).eq('id', id).select('*').single()
  if (error) {
    logError('hyrox', 'session not saved', { sessionId: row.id, code: error.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not save the session. Try again.' }, { status: 400 })
  }
  return NextResponse.json({ success: true, data })
})
