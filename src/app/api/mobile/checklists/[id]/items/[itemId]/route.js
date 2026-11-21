// CHECKLIST.2 — tick / untick a single item on a checklist
// instance the caller owns.
//
//   POST   → mark the item ticked (body: { checked: true })
//   DELETE → untick the item (sugar; equivalent to POST { checked: false })
//
// Both use the same lib path so the auto-status-recompute happens
// either way: when the last item is ticked the instance becomes
// 'complete' with a completed_at stamp; unticking from complete
// drops back to 'pending' and clears completed_at.
//
// withAuth signs the caller in (the same 401); the ids (400), the body and
// tickItem's own-instance check (404) keep their order. A failed write is
// logged and answered with a fixed message, never the database text.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { tickItem } from '@/lib/checklist-instances'
import { logAuditEvent } from '@/lib/audit'
import { validateBody } from '@/lib/validate'

const TickSchema = z.object({
  checked: z.boolean().optional(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function applyTick({ user, db, request, params }, checkedDefault) {
  const { id, itemId } = params || {}
  if (!id || !itemId) {
    return NextResponse.json(
      { success: false, error: 'Instance id + item id required.' },
      { status: 400 }
    )
  }

  let checked = checkedDefault
  if (request.method === 'POST') {
    const validation = await validateBody(request, TickSchema, { allowEmpty: true })
    if (!validation.ok) return validation.response
    if (typeof validation.data?.checked === 'boolean') checked = validation.data.checked
  }

  const out = await tickItem(db, {
    instanceId: id, itemId, checked, user: { id: user.id },
  })
  if (!out.ok) {
    if (out.code === 'update_failed') {
      logError('checklists', 'tick write failed', { instanceId: id, itemId, err: out.error })
      return NextResponse.json(
        { success: false, error: 'Could not save the tick. Try again.', code: out.code },
        { status: out.status || 500 }
      )
    }
    return NextResponse.json(
      { success: false, error: out.error, code: out.code },
      { status: out.status || 500 }
    )
  }

  // Audit at info-level: tick + auto-complete both worth tracking
  // for the non-compliance dashboard in PR 3. Untick we don't
  // audit (too chatty if the coach is flip-flopping).
  if (checked) {
    await logAuditEvent({
      category: 'business',
      action: out.data.status === 'complete'
        ? 'checklist.completed'
        : 'checklist.item_ticked',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: {
        label: 'Checklist',
        resource: `checklist_instance/${out.data.id}`,
      },
      locationId: out.data.location_id,
      details: {
        item_id: itemId,
        items_total: (out.data.items || []).length,
        items_checked: Object.keys(out.data.items_checked || {}).length,
      },
      request,
    })
  }

  return NextResponse.json({ success: true, data: out.data })
}

export const POST = withAuth({ permission: null, location: false }, (ctx) => applyTick(ctx, true))

export const DELETE = withAuth({ permission: null, location: false }, (ctx) => applyTick(ctx, false))
