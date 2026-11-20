import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { validateBody } from '@/lib/validate'
import { logError } from '@/lib/log'
import { MANAGER_ROLES } from '@/lib/schemas'

// RADAR-AGENT.0 — knowledge CRUD for the customer agent. List/create
// here; update/delete in [id]/route.js. Reads scoped to the active
// location; writes require manager+. API uses the service-role client,
// so role + location ownership are enforced explicitly here (not just
// by RLS).

const CATEGORIES = ['sales', 'account', 'pause', 'cancellation', 'hours', 'general', 'faq']

const CreateSchema = z.object({
  category: z.enum(CATEGORIES).optional().default('general'),
  title: z.string().min(1).max(200),
  // Empty content is a DRAFT — the "+ Add entry" button creates a blank
  // row the operator types into. The prompt builder already filters
  // empty-content entries out of what the agent sees, so drafts are
  // harmless. min(1) here made the button a silent no-op (KNOWLEDGE.1).
  content: z.string().max(4000).optional().default(''),
  enabled: z.boolean().optional().default(true),
  sort_order: z.number().int().min(0).max(100000).optional().default(0),
})

// GET: signed in, then the active studio (400). POST: signed in, a manager-tier
// role (user.role, 'Forbidden' 403), then the active studio (400): the order
// and texts as before. A failed read or write is logged and answered with a
// fixed 500 (it used to return the error text).
export const GET = withAuth({ permission: null, location: false }, async ({ user, db }) => {
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const { data, error } = await db.from('agent_knowledge')
    .select('id, category, title, content, enabled, sort_order, updated_at')
    .eq('location_id', locationId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) {
    logError('agent-knowledge', 'list failed', { locationId, err: error })
    return NextResponse.json({ success: false, error: 'Could not load the knowledge entries.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, entries: data || [] })
})

export const POST = withAuth({ permission: null, location: false, roles: MANAGER_ROLES, forbiddenMessage: 'Forbidden' }, async ({ request, user, db }) => {
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const v = await validateBody(request, CreateSchema)
  if (!v.ok) return v.response

  const { data, error } = await db.from('agent_knowledge').insert({
    location_id: locationId,
    category: v.data.category,
    title: v.data.title.trim(),
    content: v.data.content.trim(),
    enabled: v.data.enabled,
    sort_order: v.data.sort_order,
    updated_by: user.id,
  }).select('id, category, title, content, enabled, sort_order, updated_at').single()
  if (error) {
    logError('agent-knowledge', 'create failed', { locationId, err: error })
    return NextResponse.json({ success: false, error: 'Could not save the entry.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, entry: data })
})
