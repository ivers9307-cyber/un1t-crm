import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
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
  const allowed = getUserLocationIds(user) // null = master (no restriction)
  if (allowed !== null && !allowed.includes(row.location_id)) {
    return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  }
  return { row }
}

export async function PUT(request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()
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
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, entry: data })
}

export async function DELETE(request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()
  const owned = await loadOwned(db, user, id)
  if (owned.error) return owned.error

  const { error } = await db.from('agent_knowledge').delete().eq('id', id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
