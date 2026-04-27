import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// POST /api/webhooks — Register a webhook subscription
// n8n calls this to register its deal-update webhook URL
export async function POST(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const body = await request.json()
  const db = createServerClient()

  const { data, error } = await db.from('webhook_subscriptions').insert({
    event_type: body.event_type,  // e.g. 'deal.updated'
    target_url: body.target_url,
    secret: body.secret || null,
    active: true,
  }).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}

// GET /api/webhooks — List active webhook subscriptions
export async function GET(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = createServerClient()
  const { data } = await db.from('webhook_subscriptions').select('*').eq('active', true)

  return NextResponse.json({ success: true, data })
}
