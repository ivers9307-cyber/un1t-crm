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
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { HOST_COLS } from '@/lib/hosts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Signed in (401), the role at the active studio ('Manager+ required' 403),
// then the active organisation (400): the order and texts as before.
const GATE = { permission: null, location: false, roles: ['master', 'owner', 'manager'], forbiddenMessage: 'Manager+ required' }
const activeOrgId = (user) => user.activeOrganization?.id || user.activeLocation?.organization_id || null
const NO_ORG = () => NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  platform_fee_cents: z.number().int().min(0).max(100000).optional(),
  payment_provider: z.enum(['stripe_connect', 'revolut']).optional(),
})

export const GET = withAuth(GATE, async ({ user, db }) => {
  const orgId = activeOrgId(user)
  if (!orgId) return NO_ORG()
  const { data, error } = await db
    .from('event_hosts')
    .select(HOST_COLS)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
  if (error) {
    logError('hosts', 'list failed', { orgId, err: error })
    return NextResponse.json({ success: false, error: 'Could not load the hosts.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: data || [] })
})

export const POST = withAuth(GATE, async ({ request, user, db }) => {
  const orgId = activeOrgId(user)
  if (!orgId) return NO_ORG()
  const v = await validateBody(request, CreateSchema)
  if (!v.ok) return v.response
  const { data, error } = await db
    .from('event_hosts')
    .insert({
      organization_id: orgId,
      name: v.data.name,
      email: v.data.email || null,
      payment_provider: v.data.payment_provider || 'stripe_connect',
      platform_fee_cents: v.data.platform_fee_cents ?? 0,
    })
    .select(HOST_COLS)
    .single()
  if (error) {
    logError('hosts', 'create failed', { orgId, err: error })
    return NextResponse.json({ success: false, error: 'Could not create the host.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data })
})
