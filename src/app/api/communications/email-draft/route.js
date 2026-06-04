// PILLAR2 Phase 2 — session-authed "start an email from the unified composer".
// Creates a draft campaign (the audience-first entry) and returns its id; the
// composer then opens /email/campaigns/[id]?edit=1, the existing Unlayer editor,
// pre-seeded with the audience. The campaigns send/schedule path is unchanged.
// (The existing POST /api/campaigns is Bearer-only for n8n; this is the browser
// session path, mirroring how CampaignEditor creates campaigns.)
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'

const Schema = z.object({
  location_id: uuidLike,
  name: z.string().min(1).max(200),
  subject: z.string().max(500).optional(),
  audience_filter: z.unknown().optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { location_id, name, subject, audience_filter } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard
  if (!hasPermission(user, 'email')) {
    return NextResponse.json({ success: false, error: 'No email permission at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data, error } = await db.from('campaigns').insert({
    location_id,
    name,
    subject: subject || null,
    audience_filter: audience_filter || { logic: 'and', filters: [] },
    status: 'draft',
    created_by: user.id,
  }).select('id').single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, id: data.id })
}
