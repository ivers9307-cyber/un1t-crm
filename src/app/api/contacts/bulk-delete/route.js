// POST /api/contacts/bulk-delete
//
// Hard-delete N contacts in one request. MANAGER_ROLES required
// (head_coach / manager / owner / master). Each contact must be at
// the caller's location (master is exempt). Same cascade rules as
// the per-contact DELETE — we just iterate.
//
// Body: { contact_ids: uuid[] }  — capped at 200 per request
//
// Returns:
//   {
//     success: true,
//     data: {
//       requested: number,
//       deleted: number,
//       blocked: [{ id, name, reason }],     // FK violation (whatsapp_*) etc.
//       forbidden: [{ id, name, reason }],   // wrong location
//       missing: string[]                    // ids that didn't resolve
//     }
//   }
//
// We DON'T fail the whole request if a subset is blocked — partial
// success is the right shape for a bulk action so the operator gets
// a useful breakdown back, can dismiss the dialog, and resolve the
// blocked rows individually (typically by merging first).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  contact_ids: z.array(uuidLike).min(1).max(200),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({
      success: false,
      error: 'Head coach, manager, owner, or master required',
    }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { contact_ids } = validation.data
  const uniqueIds = [...new Set(contact_ids)]

  const db = createServerClient()
  const { data: rows } = await db
    .from('contacts')
    .select('id, name, location_id')
    .in('id', uniqueIds)

  const byId = new Map((rows || []).map(r => [r.id, r]))
  const userLocIds = new Set((user.locations || []).map(l => l.id).filter(Boolean))

  const result = {
    requested: uniqueIds.length,
    deleted: 0,
    blocked: [],
    forbidden: [],
    missing: [],
  }

  for (const id of uniqueIds) {
    const row = byId.get(id)
    if (!row) {
      result.missing.push(id)
      continue
    }
    if (user.role !== 'master' && !userLocIds.has(row.location_id)) {
      result.forbidden.push({ id, name: row.name, reason: 'Different location' })
      continue
    }
    const { error } = await db.from('contacts').delete().eq('id', id)
    if (error) {
      // 23503 — FK violation (most commonly whatsapp_* NO ACTION rows
      // refusing the cascade). Surface as a "blocked" entry so the
      // operator knows to merge first; don't fail the whole request.
      const isFk = error.code === '23503' || /foreign key|violates/i.test(error.message || '')
      result.blocked.push({
        id,
        name: row.name,
        reason: isFk
          ? 'WhatsApp history blocks delete — merge first.'
          : (error.message || 'Delete failed'),
      })
      continue
    }
    result.deleted += 1
  }

  return NextResponse.json({ success: true, data: result })
}
