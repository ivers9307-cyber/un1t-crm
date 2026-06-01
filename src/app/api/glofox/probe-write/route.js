// /api/glofox/probe-write — MASTER-ONLY one-off diagnostic.
//
// Purpose: answer "does Glofox expose POST /v3.0/memberships/{id}/pause
// (and /cancel)?" — which the GET-only /probe can't, because those are
// POST routes and a GET returns a generic routing 404 regardless of
// whether the route exists.
//
// SAFETY MODEL (read this before extending):
//   - Master only.
//   - Allow-listed ACTIONS only: 'pause' and 'cancel'. Nothing else.
//   - Defaults to a FAKE membership id ('probe-nonexistent-id') so the
//     call is an EXISTENCE CHECK that cannot mutate a real membership:
//       * route absent  -> "controller not found / WRONG_URL"
//       * route present -> "membership not found" (different error),
//         and nothing changes because the id isn't real.
//   - To target a REAL user_membership_id you MUST pass &confirm=PAUSE-ME
//     AND the id explicitly. Without that, the real id is refused. This
//     is a genuine billing write — the guard makes it impossible to fire
//     by accident.
//   - We send a deliberately MINIMAL body. For an existence check the
//     body is irrelevant (routing happens before validation); for a real
//     call we pass the documented cancel shape / a best-guess pause shape.
//
// This endpoint is a throwaway — delete it once the question is answered.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { glofoxFetch, glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation } from '@/lib/glofox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FAKE_ID = 'probe-nonexistent-id'
const ALLOWED_ACTIONS = ['pause', 'cancel']
const REAL_ID_CONFIRM = 'PAUSE-ME' // must be passed to use a real membership id

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id || null
  const action = (url.searchParams.get('action') || 'pause').toLowerCase()
  const requestedId = url.searchParams.get('membership_id') || null
  const confirm = url.searchParams.get('confirm') || null

  if (!ALLOWED_ACTIONS.includes(action)) {
    return NextResponse.json({ ok: false, error: `action must be one of ${ALLOWED_ACTIONS.join(', ')}` }, { status: 400 })
  }
  if (!locationId) {
    return NextResponse.json({ ok: false, error: 'Provide ?location_id=<uuid> or set an active location' }, { status: 400 })
  }

  // Existence-check by default with a fake id. A real id is only used
  // when explicitly confirmed — otherwise we fall back to the fake id
  // so a stray ?membership_id= can never trigger a real billing write.
  let membershipId = FAKE_ID
  let mode = 'existence-check (fake id, zero-mutation)'
  if (requestedId) {
    if (confirm === REAL_ID_CONFIRM) {
      membershipId = requestedId
      mode = 'REAL ID — live billing write attempted'
    } else {
      return NextResponse.json({
        ok: false,
        refused: true,
        error: `Real membership_id supplied without confirm=${REAL_ID_CONFIRM}. Refusing — this would be a live billing write. ` +
               `Run without membership_id first (fake-id existence check). Only add &confirm=${REAL_ID_CONFIRM} if you intend to actually ${action} that membership.`,
      }, { status: 400 })
    }
  }

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  const missing = missingGlofoxCredentialsForLocation(creds)
  if (missing.length > 0) {
    return NextResponse.json({ ok: false, configured: false, missing }, { status: 400 })
  }

  const path = `/v3.0/memberships/${encodeURIComponent(membershipId)}/${action}`
  // Minimal documented-ish body. For the existence check this is ignored
  // by Glofox (routing precedes validation). For cancel the spec shape is
  // { when, local_date, reason }; pause shape is unknown (best guess).
  const today = new Date().toISOString().slice(0, 10)
  const body = action === 'cancel'
    ? { when: 'ON_DATE', local_date: today, reason: 'MEMBERSHIP_CANCELLATION_PRICE' }
    : { when: 'ON_DATE', local_date: today }

  try {
    const r = await glofoxFetch(creds, path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-glofox-impersonated-member-id': url.searchParams.get('member_id') || '',
      },
      body: JSON.stringify(body),
    })
    let raw, parsed
    try { raw = await r.text(); parsed = raw ? JSON.parse(raw) : null } catch { parsed = { _raw: raw?.slice(0, 600) } }
    return NextResponse.json({
      ok: r.ok,
      status: r.status,
      mode,
      action,
      glofox_path: path,
      used_id: membershipId,
      response_body: parsed,
    })
  } catch (e) {
    return NextResponse.json({ ok: false, mode, action, glofox_path: path, error: e?.message || 'Network error' })
  }
}
