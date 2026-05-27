// STUDIO-PIN.2 — POST/DELETE /api/auth/set-pin
//
// Staff manage their own PIN here. Set / change / clear — all
// require an active web session (i.e. the staffer is logged in via
// email + password). The route uses the service-role client only
// for the write (RLS would block any anon-client update of pin_hash
// anyway); identity comes from the authenticated session.
//
// PIN uniqueness is enforced by the UNIQUE index on profiles.pin_hash
// (because hashes are different even for the same PIN — sigh — we
// also do an in-app check against the cleartext PIN by looking for
// another profile whose pin_hash verifies under this PIN). Without
// the in-app check we'd let two staffers pick the same PIN, since
// their hashes wouldn't collide.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { hashPin, isValidPinFormat, verifyPin } from '@/lib/studio-pin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  pin: z.string().refine(isValidPinFormat, 'PIN must be exactly 4 digits'),
})

// STUDIO-PIN.3 — separate body schema for the home_screen_path PATCH.
// Same /account form, different intent; keep them on dedicated HTTP
// verbs so the validation surface stays narrow.
const PathBody = z.object({
  home_screen_path: z.string()
    .min(1)
    .max(120)
    .regex(/^\/[A-Za-z0-9/_\-]*$/, 'Must be a relative path starting with /'),
})

/**
 * Check whether the PIN is already taken by some OTHER profile.
 *
 * Walks profiles with a pin_hash set and verifies each — same
 * mechanic as findProfileByPin but with the "this isn't me" filter
 * applied client-side. Cap matches findProfileByPin's safety bound.
 */
async function pinTakenByOther(db, { pin, currentProfileId }) {
  const { data: candidates, error } = await db
    .from('profiles')
    .select('id, pin_hash')
    .not('pin_hash', 'is', null)
    .neq('id', currentProfileId)
    .eq('active', true)
    .limit(201)
  if (error) throw new Error(error.message)
  if (!candidates || candidates.length === 0) return false
  if (candidates.length > 200) {
    throw new Error('Too many active profiles with a PIN set — please contact an admin.')
  }
  for (const p of candidates) {
    if (await verifyPin(pin, p.pin_hash)) return true
  }
  return false
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { pin } = validation.data

  const db = createServerClient()

  // In-app uniqueness check — see file-level comment.
  try {
    if (await pinTakenByOther(db, { pin, currentProfileId: user.id })) {
      return NextResponse.json({
        success: false,
        error: 'That PIN is already in use by another staff member. Please pick another.',
      }, { status: 409 })
    }
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }

  // Hash + persist. UNIQUE constraint on pin_hash is hash-level
  // uniqueness only (different salts → different hashes for the same
  // PIN) and won't help here; pinTakenByOther is the actual gate.
  const hash = await hashPin(pin)
  const { error: updErr } = await db
    .from('profiles')
    .update({ pin_hash: hash, pin_set_at: new Date().toISOString() })
    .eq('id', user.id)
  if (updErr) {
    return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

export async function DELETE() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const { error } = await db
    .from('profiles')
    .update({ pin_hash: null, pin_set_at: null, pin_failed_count: 0, pin_locked_until: null })
    .eq('id', user.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}

// STUDIO-PIN.3 — PATCH /api/auth/set-pin
//
// Set the staffer's home_screen_path — the URL the Mac shell / iPad
// loads after PIN unlock. Lives on the same route because it's
// adjacent in /account UX (both manage what happens at studio
// login). Separate verb keeps the validation surface narrow.
export async function PATCH(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const validation = await validateBody(request, PathBody)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { error } = await db
    .from('profiles')
    .update({ home_screen_path: validation.data.home_screen_path })
    .eq('id', user.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
