// /api/auth/log-event — fire-and-forget audit endpoint for
// client-side auth flows.
//
// The login form, the password-reset form, and the in-app password
// change all do their actual auth work via the Supabase JS client
// (signInWithPassword, resetPasswordForEmail, updateUser). None of
// those round-trip through our Node server — so we can't observe
// them from middleware. This endpoint is the deliberate bridge:
// the client posts an event description after the Supabase call
// completes, and we write it to audit_events.
//
// Trust model: the body is asserted by the client, but
//   - email (when present) is checked against profiles for an
//     existing actor_id. An unknown email is still logged with a
//     NULL actor_id so unsuccessful sign-in attempts on a
//     non-existent address are still visible.
//   - For categories that REQUIRE an authenticated user
//     (password.changed), we cross-check getCurrentUser. A failure
//     swallows silently — audit failures must never block UX.
//
// Accepted action values (kept narrow on purpose):
//   - 'auth.sign_in'         { ok: boolean, email: string, reason?: string }
//   - 'auth.sign_out'        { email?: string }
//   - 'auth.password_reset_requested' { email: string }
//   - 'auth.password_changed' { surface: 'account' | 'reset' }

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'

const ACTIONS = [
  'auth.sign_in',
  'auth.sign_out',
  'auth.password_reset_requested',
  'auth.password_changed',
]

const Body = z.object({
  action: z.enum(ACTIONS),
  // Free-form metadata — we don't strictly validate per action,
  // since the helper accepts whatever JSONB we throw at it.
  email: z.string().email().nullable().optional(),
  ok: z.boolean().nullable().optional(),
  reason: z.string().max(200).nullable().optional(),
  surface: z.enum(['account', 'reset']).nullable().optional(),
})

async function lookupActor(db, email) {
  if (!email) return null
  const { data } = await db
    .from('profiles')
    .select('id, full_name, email')
    .ilike('email', email)
    .maybeSingle()
  return data || null
}

export async function POST(request) {
  // Abuse guard. This endpoint is unauthenticated for sign_in / sign_out /
  // reset (the Supabase JS auth calls never reach our Node server, so the
  // client reports the outcome afterwards) yet it runs a service-role profiles
  // lookup + an audit write per call — so an attacker could flood audit_events
  // with forged rows. Rate-limit by IP. Fail-open (a limiter outage must not
  // stop audit logging), and note the cost of a false-positive is only a
  // dropped audit row — sign-in itself happens client-side regardless — so the
  // window can be generous while still stopping floods.
  const db = createServerClient()
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `log-event:${ip}`, { max: 30, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const raw = await request.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'bad_request' }, { status: 400 })
  }
  const { action, email, ok, reason, surface } = parsed.data

  // Authenticated actions: prefer the live session's identity
  // over a client-asserted email, so a malicious caller can't
  // pretend to be someone else.
  let actor = null
  let clientAsserted = false
  if (action === 'auth.password_changed') {
    const user = await getCurrentUser()
    if (user) {
      actor = { id: user.id, full_name: user.full_name, email: user.email }
    }
  } else {
    // sign_in / sign_out / password_reset_requested are asserted by the
    // client after the Supabase call — the outcome is reported, not verified.
    clientAsserted = true
    const profile = await lookupActor(db, email || null)
    if (profile) {
      actor = { id: profile.id, full_name: profile.full_name, email: profile.email }
    } else if (email) {
      // Unknown email: still capture it in the label so the
      // attempt is visible without leaking a profile id.
      actor = { id: null, full_name: null, email }
    }
  }

  const details = {}
  if (ok !== null && ok !== undefined) details.ok = ok
  if (reason) details.reason = reason
  if (surface) details.surface = surface
  if (email && !actor?.id) details.email = email
  // Tag client-reported events so a forged `ok:true` can never be read back as
  // an authoritative, server-verified success.
  if (clientAsserted) details.source = 'client_claim'

  await logAuditEvent({
    category: 'auth',
    action,
    actor,
    target: actor?.id ? { id: actor.id, resource: `profiles/${actor.id}` } : null,
    details: Object.keys(details).length ? details : null,
    request,
  })

  return NextResponse.json({ success: true })
}
