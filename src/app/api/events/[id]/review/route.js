// Staff approve/reject a host event pending review. ADMIN_ROLES; the event's
// host must be in the caller's org (IDOR guard). (HOST-PORTAL.3)
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ADMIN_ROLES } from '@/lib/schemas'
import { loadHostForOrg } from '@/lib/hosts'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ReviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().max(2000).optional().nullable(),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.includes(user.role)) return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = ReviewSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid', issues: parsed.error.issues }, { status: 400 })
  if (parsed.data.action === 'reject' && !parsed.data.reason?.trim()) {
    return NextResponse.json({ success: false, error: 'A reason is required to reject.' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: event } = await db.from('race_events').select('id, host_id, status').eq('id', params.id).maybeSingle()
  if (!event || !event.host_id) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const host = await loadHostForOrg(db, event.host_id, orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (event.status !== 'pending_review') {
    return NextResponse.json({ success: false, error: `Event is ${event.status}, not pending review.` }, { status: 409 })
  }

  const nowIso = new Date().toISOString()
  const patch = parsed.data.action === 'approve'
    ? { status: 'published', reviewed_at: nowIso, reviewed_by: user.id, rejected_reason: null }
    : { status: 'rejected', reviewed_at: nowIso, reviewed_by: user.id, rejected_reason: parsed.data.reason.trim() }
  const { error } = await db.from('race_events').update(patch).eq('id', event.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data: { id: event.id, status: patch.status } })
}
