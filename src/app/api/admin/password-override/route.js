// AUTH.1 — admin password override.
//
// Sets a new password for a target user (staff profile OR member
// contact) using Supabase's admin API. Invalidates all existing
// sessions for the target user. Returns the new password to the
// caller ONCE so the admin can pass it to the user via whatever
// channel (in-person, WhatsApp, etc.) — never stored.
//
// Authorization (AUTH.1 hardening, 2026-05):
//   The original route gated on role alone (master/owner) and never
//   checked the caller↔target relationship, so any owner at any
//   location could reset ANY staff/owner/master account by id — a
//   cross-org account-takeover path. Now scoped:
//     - master: may reset anyone.
//     - owner:  staff target → may reset a manager/head_coach/staff
//               member sharing one of their locations; NOT another
//               owner, a master, or themselves (canOverrideStaffPassword).
//               member target → contact must belong to one of the
//               owner's locations (assertLocationAccess).
//   Plus a per-admin rate limit to blunt a compromised-owner spree.
//
// Audit: every override writes a row to password_overrides_audit
// (mig 161) with who/when/why. Master/owner can read that log.
//
// POST /api/admin/password-override
//   body: {
//     targetType: 'staff' | 'member',
//     targetId:   <profile.id> or <contact.id>,
//     newPassword?: string,          // explicit override
//     generateRandom?: boolean,      // server generates a strong one
//     reason?: string,
//   }
//   200: { success: true, password: '<the new password>' }
//   403: { success: false, error: 'forbidden' }
//   404: { success: false, error: 'target_not_found' | 'no_auth_account' }

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { canOverrideStaffPassword } from '@/lib/staff-access'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'

// Validate body SHAPE only — auth/permission logic is unchanged.
// newPassword is optional (server generates if missing/generateRandom=true).
const PasswordOverrideSchema = z.object({
  targetType:      z.string().optional(),
  targetId:        z.string().optional(),
  newPassword:     z.string().optional(),
  generateRandom:  z.boolean().optional(),
  reason:          z.string().max(1000).optional(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Strong-but-speakable random password: 16 chars from a curated set
// that avoids visually-similar pairs (0/O, 1/l/I) and shell-special
// chars. Crypto-random source.
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*'
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

function getClientIp(request) {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null
  )
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 })
  }
  if (!['master', 'owner'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }

  const db = createServerClient()

  // Rate limit per admin (not per IP — the action is identity-bound).
  // A legitimate admin resets a handful of passwords; 20 / 15 min is
  // generous while capping a compromised-owner credential-spray. Fail-
  // open inside checkRateLimit, so a limiter outage never blocks a real
  // lockout-recovery.
  // SAAS-6: deliberately tenant-UNSCOPED — already keyed per caller
  // identity (a platform-admin action), so tenants can't contend anyway.
  const rl = await checkRateLimit(db, `pw-override:${user.id}`, { max: 20, windowMs: 15 * 60_000 })
  if (!rl.allowed) return rateLimitResponse(rl)

  const v = await validateBody(request, PasswordOverrideSchema)
  if (!v.ok) return v.response
  const body = v.data

  const { targetType, targetId, newPassword, generateRandom, reason } = body

  if (!['staff', 'member'].includes(targetType)) {
    return NextResponse.json({ success: false, error: 'bad_targetType' }, { status: 400 })
  }
  if (typeof targetId !== 'string' || !targetId) {
    return NextResponse.json({ success: false, error: 'bad_targetId' }, { status: 400 })
  }

  // Decide final password. Generate if asked OR if newPassword is
  // missing/short — refuse anything under 12 chars to keep the
  // floor reasonable; the new password is shown to the admin once
  // either way.
  let finalPassword
  if (generateRandom || !newPassword) {
    finalPassword = generatePassword()
  } else if (typeof newPassword !== 'string' || newPassword.length < 12) {
    return NextResponse.json({
      success: false,
      error: 'password_too_short',
      detail: 'Provide a password of at least 12 chars, or set generateRandom=true.',
    }, { status: 400 })
  } else {
    finalPassword = newPassword
  }

  // Resolve targetUserId (auth.users.id) + the relevant FK columns
  // for the audit row, AND authorize the caller against the specific
  // target (AUTH.1).
  let targetUserId = null
  let targetProfileId = null
  let targetContactId = null
  let locationId = null

  if (targetType === 'staff') {
    // profiles.id IS auth.users.id (1:1) in this codebase — 13/13 confirmed at apply time.
    const { data, error } = await db
      .from('profiles')
      .select('id, full_name, role')
      .eq('id', targetId)
      .maybeSingle()
    if (error || !data) {
      return NextResponse.json({ success: false, error: 'target_not_found' }, { status: 404 })
    }

    // Effective role + the target's location memberships drive the
    // authorization check. profiles.role carries 'master'; per-location
    // 'owner' lives in profile_locations, so we treat the target as an
    // owner if they hold owner at ANY location.
    const { data: targetLocs } = await db
      .from('profile_locations')
      .select('location_id, role')
      .eq('profile_id', data.id)
    const targetLocationIds = (targetLocs || []).map((r) => r.location_id)
    const isTargetOwner = (targetLocs || []).some((r) => r.role === 'owner')
    const effectiveRole = data.role === 'master'
      ? 'master'
      : (isTargetOwner ? 'owner' : (data.role || 'staff'))

    if (!canOverrideStaffPassword(user, { id: data.id, role: effectiveRole, locationIds: targetLocationIds })) {
      return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
    }

    targetUserId = data.id
    targetProfileId = data.id
  } else {
    const { data, error } = await db
      .from('contacts')
      .select('id, user_id, location_id, name')
      .eq('id', targetId)
      .maybeSingle()
    if (error || !data) {
      return NextResponse.json({ success: false, error: 'target_not_found' }, { status: 404 })
    }

    // Location scoping for members. Master sees every active location
    // (getCurrentUser populates them), so assertLocationAccess passes
    // for master and restricts owners to their own locations. A contact
    // with no location can only be reset by a master.
    if (!user.isMaster && !data.location_id) {
      return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
    }
    const locationGuard = assertLocationAccess(user, data.location_id)
    if (locationGuard) return locationGuard

    if (!data.user_id) {
      return NextResponse.json({
        success: false,
        error: 'no_auth_account',
        detail: 'This contact has no linked CRM login. Send them a sign-up link instead.',
      }, { status: 404 })
    }
    targetUserId = data.user_id
    targetContactId = data.id
    locationId = data.location_id
  }

  // Admin client (service-role) for auth.admin calls. We use the
  // standard supabase-js client because admin APIs aren't exposed
  // through the @supabase/ssr server client.
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  const { error: updErr } = await admin.auth.admin.updateUserById(targetUserId, {
    password: finalPassword,
  })
  if (updErr) {
    return NextResponse.json({
      success: false,
      error: 'update_failed',
      detail: updErr.message,
    }, { status: 500 })
  }

  // Invalidate all existing sessions for the target. 'global' scope
  // logs them out everywhere — phone, browser, etc. They'll need
  // to log in again with the new password.
  await admin.auth.admin.signOut(targetUserId, 'global').catch(() => {
    // Non-fatal — the password change itself was successful. Sign-
    // out failure just means the target might briefly keep an
    // existing session token until it expires naturally.
  })

  // Audit. Failures here shouldn't fail the response (the password
  // is already changed) — log and continue.
  const { error: auditErr } = await db.from('password_overrides_audit').insert({
    target_user_id: targetUserId,
    target_type: targetType,
    target_profile_id: targetProfileId,
    target_contact_id: targetContactId,
    performed_by: user.id,
    location_id: locationId || user.activeLocation?.id || null,
    reason: typeof reason === 'string' ? reason.slice(0, 1000) : null,
    ip_address: getClientIp(request),
  })
  if (auditErr) {
    console.error('[password-override] audit insert failed:', auditErr.message)
  }

  return NextResponse.json({
    success: true,
    password: finalPassword,
    sessions_invalidated: true,
  })
}
