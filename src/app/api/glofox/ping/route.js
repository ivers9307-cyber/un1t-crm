// /api/glofox/ping — operator connection test (GLOFOX1.5).
//
// Master-only. Calls GET /2.0/members?limit=1 against the Glofox
// API using the configured GLOFOX_BRANCH_ID / GLOFOX_API_KEY /
// GLOFOX_API_TOKEN env vars and reports back what happened. Use
// to verify the credentials work before relying on phase-2
// outbound sync OR after rotating credentials.
//
// Response shapes:
//   { ok: true,  status: 200, branch_id, sample }   credentials work
//   { ok: false, status: 401|403, branch_id, error } credentials wrong
//   { ok: false, configured: false, missing: [...] } env not set
//   { ok: false, error: '...' }                      network / parse error

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { glofoxFetch, missingGlofoxCredentials, glofoxCredentials } from '@/lib/glofox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  // Master-only — operators don't need this, it's a debug surface
  // for the master setting up the integration. We can broaden later
  // if the integration ships per-location config.
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  const missing = missingGlofoxCredentials()
  if (missing.length > 0) {
    return NextResponse.json({
      ok: false,
      configured: false,
      missing,
      hint: 'Set the missing env vars in Vercel Project Settings → Environment Variables, then redeploy.',
    })
  }

  const { branchId } = glofoxCredentials()
  try {
    const r = await glofoxFetch('/2.0/members?limit=1')
    let body
    try {
      body = await r.json()
    } catch {
      body = null
    }
    if (!r.ok) {
      return NextResponse.json({
        ok: false,
        configured: true,
        status: r.status,
        branch_id: branchId,
        error: body?.error || body?.message || `Glofox returned HTTP ${r.status}`,
        hint: r.status === 401 ? 'Check GLOFOX_API_KEY / GLOFOX_API_TOKEN — auth failed.'
            : r.status === 403 ? 'Check GLOFOX_BRANCH_ID — credentials are valid but lack access to this branch.'
            : r.status === 429 ? 'Rate-limited — back off and retry.'
            : 'Glofox returned an unexpected status. Check GLOFOX_API_BASE if you changed it.',
      })
    }
    // Success — return a tiny sample so the operator can SEE the
    // shape (number of members visible, first member's id) without
    // dumping the whole list.
    const sample = Array.isArray(body?.data)
      ? { count_in_response: body.data.length, first_id: body.data[0]?._id || body.data[0]?.id || null }
      : { keys: Object.keys(body || {}) }
    return NextResponse.json({
      ok: true,
      configured: true,
      status: 200,
      branch_id: branchId,
      sample,
    })
  } catch (e) {
    return NextResponse.json({
      ok: false,
      configured: true,
      branch_id: branchId,
      error: e?.message || 'Network error',
    })
  }
}
