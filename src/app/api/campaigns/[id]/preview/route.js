import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { buildAudienceQuery } from '@/lib/postmark'

// GET /api/campaigns/[id]/preview — Get audience count preview
export async function GET(request, { params }) {
  const db = createServerClient()

  const { data: campaign } = await db.from('campaigns')
    .select('audience_filter, location_id')
    .eq('id', params.id)
    .single()

  if (!campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }

  // Count matching contacts
  const query = buildAudienceQuery(db, campaign.audience_filter, campaign.location_id)
  const { count, error } = await query.select('id', { count: 'exact', head: true })

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, audience_count: count || 0 })
}
