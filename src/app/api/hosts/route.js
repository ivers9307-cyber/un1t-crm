// GET  /api/hosts            — list event hosts for the caller's org
// POST /api/hosts { name, … } — create an event host (payee)
//
// Auth: Manager+ (owner/manager, or master). Hosts are always scoped to the
// caller's ACTIVE organization. An event host is a party paid DIRECTLY for
// their events (third-party via Stripe Connect, or a UN1T host brand). Creating
// one just makes the record; connecting Stripe is a separate step
// (/api/hosts/[id]/stripe/connect). (EVENTS-HOST.2)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { HOST_COLS } from '@/lib/hosts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function gate() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return { error: NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 }) }
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return { error: NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 }) }
  return { user, orgId }
}

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  platform_fee_cents: z.number().int().min(0).max(100000).optional(),
  payment_provider: z.enum(['stripe_connect', 'revolut']).optional(),
})

export async function GET() {
  const g = await gate()
  if (g.error) return g.error
  const db = createServerClient()
  const { data, error } = await db
    .from('event_hosts')
    .select(HOST_COLS)
    .eq('organization_id', g.orgId)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}

export async function POST(request) {
  const g = await gate()
  if (g.error) return g.error
  const v = await validateBody(request, CreateSchema)
  if (!v.ok) return v.response
  const db = createServerClient()
  const { data, error } = await db
    .from('event_hosts')
    .insert({
      organization_id: g.orgId,
      name: v.data.name,
      email: v.data.email || null,
      payment_provider: v.data.payment_provider || 'stripe_connect',
      platform_fee_cents: v.data.platform_fee_cents ?? 0,
    })
    .select(HOST_COLS)
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data })
}
