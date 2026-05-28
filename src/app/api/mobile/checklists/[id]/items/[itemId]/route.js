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

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { tickItem } from '@/lib/checklist-instances'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function applyTick(request, params, checkedDefault) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const { id, itemId } = (await params) || {}
  if (!id || !itemId) {
    return NextResponse.json(
      { success: false, error: 'Instance id + item id required.' },
      { status: 400 }
    )
  }

  let checked = checkedDefault
  if (request.method === 'POST') {
    try {
      const body = await request.json()
      if (typeof body?.checked === 'boolean') checked = body.checked
    } catch {
      // No body / non-JSON — fall back to checkedDefault (true).
    }
  }

  const db = createServerClient()
  const out = await tickItem(db, {
    instanceId: id, itemId, checked, user: { id: user.id },
  })
  if (!out.ok) {
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
        id: out.data.id,
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

export async function POST(request, { params }) {
  return applyTick(request, params, true)
}

export async function DELETE(request, { params }) {
  return applyTick(request, params, false)
}
