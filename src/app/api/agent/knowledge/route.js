import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
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

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const { data, error } = await db.from('agent_knowledge')
    .select('id, category, title, content, enabled, sort_order, updated_at')
    .eq('location_id', locationId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, entries: data || [] })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()
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
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, entry: data })
}
