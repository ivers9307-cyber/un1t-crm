// DEBUG endpoint — diagnose why audience preview returns 0.
// Confirms which Supabase role the deployed code is actually
// running as, and runs the exact prefilter query computeCount uses.
//
// Visit /api/_debug-supabase?location_id=a0000000-0000-0000-0000-000000000001
// after deploying. DELETE THIS FILE once the bug is found — it leaks
// metadata (key suffix, role claim) that shouldn't be in prod long-term.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

function decodeJwtRole(jwt) {
  try {
    const payload = jwt.split('.')[1]
    const json = Buffer.from(payload, 'base64').toString('utf8')
    return JSON.parse(json).role
  } catch {
    return 'unparseable'
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id') || 'a0000000-0000-0000-0000-000000000001'

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const keyMeta = key
    ? { suffix: key.slice(-8), role_claim: decodeJwtRole(key), length: key.length }
    : { error: 'SUPABASE_SERVICE_ROLE_KEY env var is missing' }

  const db = createServerClient()

  // Exact query computeCount runs (for empty filter)
  const { count, error } = await db
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .eq('email_marketing', true)
    .not('email_status', 'in', '("bounced","complained")')

  // Sanity check: also try .from('campaigns') which we know returns rows in prod
  const { data: campaignsSample, error: campaignsError } = await db
    .from('campaigns')
    .select('id, location_id')
    .limit(3)

  return NextResponse.json({
    env: {
      supabase_url: url,
      service_role_key: keyMeta,
    },
    contacts_query: {
      location_id: locationId,
      count,
      error: error ? { message: error.message, hint: error.hint, code: error.code } : null,
    },
    campaigns_query: {
      sample_count: campaignsSample?.length ?? 0,
      sample: campaignsSample,
      error: campaignsError ? { message: campaignsError.message } : null,
    },
  })
}
