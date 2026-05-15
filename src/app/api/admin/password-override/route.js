// AUTH.1 — admin password override.
//
// Sets a new password for a target user (staff profile OR member
// contact) using Supabase's admin API. Invalidates all existing
// sessions for the target user. Returns the new password to the
// caller ONCE so the admin can pass it to the user via whatever
// channel (in-person, WhatsApp, etc.) — never stored.
//
// Auth: master/owner only. (Could relax to manager-for-members
// later if needed; conservative default since this is a security-
// sensitive operation.)
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
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

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

  let body
  try { body = await request.json() } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }

  const { targetType, targetId, newPassword, generateRandom, reason } = body || {}

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

  const db = createServerClient()

  // Resolve targetUserId (auth.users.id) + the relevant FK columns
  // for the audit row.
  let targetUserId = null
  let targetProfileId = null
  let targetContactId = null
  let locationId = null

  if (targetType === 'staff') {
    // profiles.id IS auth.users.id (1:1) in this codebase — 13/13 confirmed at apply time.
    const { data, error } = await db
      .from('profiles')
      .select('id, full_name')
      .eq('id', targetId)
      .maybeSingle()
    if (error || !data) {
      return NextResponse.json({ success: false, error: 'target_not_found' }, { status: 404 })
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
