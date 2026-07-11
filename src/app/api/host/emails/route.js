// GET  /api/host/emails — the host's OWN campaigns (HOST-EMAIL.3), newest first.
// POST /api/host/emails — create a DRAFT campaign. No sending here: the send
// gate (verified sender, daily cap, recipient resolution, CAS draft→sending)
// lives in /api/host/emails/[id]/send, and the fan-out runs on the cron.
// Tenancy: getCurrentHost() → every query .eq('host_id', session.host.id).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CampaignDraftSchema = z.object({
  subject: z.string().min(1, 'Subject is required').max(200, 'Subject is too long (max 200 characters)'),
  body: z.string().min(1, 'Body is required').max(20000, 'Body is too long (max 20,000 characters)'),
})

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db
    .from('host_campaigns')
    .select('id, subject, status, recipient_count, sent_count, created_at, sent_at')
    .eq('host_id', session.host.id)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}

export async function POST(request) {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = CampaignDraftSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid email', issues: parsed.error.issues }, { status: 400 })
  }

  const db = createServerClient()
  const { data: campaign, error } = await db
    .from('host_campaigns')
    .insert({
      host_id: session.host.id,
      subject: parsed.data.subject,
      body_html: parsed.data.body,
      status: 'draft',
    })
    .select('id, subject, status, recipient_count, sent_count, created_at, sent_at')
    .single()
  if (error || !campaign) {
    return NextResponse.json({ success: false, error: error?.message || 'Create failed' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: campaign })
}
