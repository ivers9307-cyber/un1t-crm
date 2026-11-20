import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getUserLocationIds, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'

const CATEGORIES = ['sales', 'account', 'pause', 'cancellation', 'hours', 'general', 'faq']

const UpdateSchema = z.object({
  category: z.enum(CATEGORIES).optional(),
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(4000).optional(), // '' allowed — empty entries are drafts the agent never reads
  enabled: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
})

// Resolve the row + verify the caller manages its location.
async function loadOwned(db, user, id) {
  const { data: row } = await db.from('agent_knowledge')
    .select('id, location_id')
    .eq('id', id)
    .single()
  if (!row) return { error: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  // Every location the caller belongs to; a master's is every active one
  // (getCurrentUser), so a master still passes here. Never null.
  if (!getUserLocationIds(user).includes(row.location_id)) {
    return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  }
  // ROLESWEEP.1a — the role is judged at the ROW's location, not the
  // caller's active studio (user.role).
  if (!hasRoleAtLocation(user, row.location_id, MANAGER_ROLES)) {
    return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  }
  return { row }
}

// withAuth only signs the caller in; the coarse manager check, the row's
// studio and the role there run below in their old order.
export const PUT = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const id = params?.id
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const owned = await loadOwned(db, user, id)
  if (owned.error) return owned.error

  const v = await validateBody(request, UpdateSchema)
  if (!v.ok) return v.response

  const patch = { updated_at: new Date().toISOString(), updated_by: user.id }
  for (const k of ['category', 'title', 'content', 'enabled', 'sort_order']) {
    if (v.data[k] !== undefined) {
      patch[k] = typeof v.data[k] === 'string' ? v.data[k].trim() : v.data[k]
    }
  }

  const { data, error } = await db.from('agent_knowledge')
    .update(patch)
    .eq('id', id)
    .select('id, category, title, content, enabled, sort_order, updated_at')
    .single()
  if (error) {
    logError('agent-knowledge', 'entry update failed', { id, err: error })
    return NextResponse.json({ success: false, error: 'Could not save the entry.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, entry: data })
})

export const DELETE = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const id = params?.id
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const owned = await loadOwned(db, user, id)
  if (owned.error) return owned.error

  const { error } = await db.from('agent_knowledge').delete().eq('id', id)
  if (error) {
    logError('agent-knowledge', 'entry delete failed', { id, err: error })
    return NextResponse.json({ success: false, error: 'Could not delete the entry.' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
})
