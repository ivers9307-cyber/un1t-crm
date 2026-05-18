// POST /api/policies/[slug]/acknowledge — record that the calling
// user has acknowledged the CURRENT version of the policy identified
// by slug. Idempotent — repeat POSTs return the existing ack row
// rather than erroring on the unique constraint.
//
// Headers captured for the audit record:
//   - ip_address  from x-forwarded-for (vercel sets this) or null
//   - user_agent  from the request header
//   - acknowledged_via  inferred 'mobile' if UA matches the staff
//                       app's known UA prefix, else 'web'

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'

function parseClientIp(req) {
  // Take the leftmost entry from x-forwarded-for, which is the
  // original client when behind Vercel's proxy.
  const xff = req.headers.get('x-forwarded-for') || ''
  const ip = xff.split(',')[0]?.trim()
  return ip || null
}

function classifyVia(userAgent) {
  if (!userAgent) return 'web'
  // Expo / RN UA pattern. The staff app sets a distinguishing UA
  // when it fetches via the in-app webview wrapper; for now any
  // Expo / okhttp / okhttp-style UA is treated as mobile.
  return /Expo|okhttp|UN1TCRM\/|CFStudio\//.test(userAgent) ? 'mobile' : 'web'
}

export async function POST(request, { params }) {
  const { slug } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()

  // Resolve the slug → current version id. We don't accept a
  // version_id in the request body — the user is always ack'ing the
  // current version. This avoids race conditions where a user POSTs
  // an ack against an old version that's just been superseded.
  const { data: policy } = await db
    .from('policies')
    .select(`
      id, active,
      policy_versions ( id, is_current )
    `)
    .eq('slug', slug)
    .maybeSingle()

  if (!policy || !policy.active) {
    return NextResponse.json({ success: false, error: 'Policy not found' }, { status: 404 })
  }
  const current = (policy.policy_versions || []).find((v) => v.is_current)
  if (!current) {
    return NextResponse.json({ success: false, error: 'Policy has no current version' }, { status: 409 })
  }

  // Try to insert. Race-safe via the unique index — duplicate insert
  // yields a 23505 we handle as idempotent.
  const userAgent = request.headers.get('user-agent') || null
  const ip = parseClientIp(request)
  const acknowledged_via = classifyVia(userAgent)

  const { data: inserted, error } = await db
    .from('policy_acknowledgements')
    .insert({
      policy_version_id: current.id,
      profile_id: user.id,
      acknowledged_via,
      ip_address: ip,
      user_agent: userAgent,
    })
    .select('id, acknowledged_at')
    .single()

  if (error) {
    // Idempotent — already acked. Return the existing row.
    if (error.code === '23505') {
      const { data: existing } = await db
        .from('policy_acknowledgements')
        .select('id, acknowledged_at')
        .eq('policy_version_id', current.id)
        .eq('profile_id', user.id)
        .single()
      return NextResponse.json({ success: true, data: existing, already_acknowledged: true })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: inserted, already_acknowledged: false })
}
