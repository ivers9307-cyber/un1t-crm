import { NextResponse } from 'next/server'
import { sendCampaign } from '@/lib/postmark'

// POST /api/campaigns/[id]/send — Send a campaign
export async function POST(request, { params }) {
  // This endpoint is called from the CRM UI (authenticated via cookies)
  // No API key required — uses session auth via middleware

  try {
    const result = await sendCampaign(params.id)
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('Campaign send error:', error)
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 400 }
    )
  }
}
