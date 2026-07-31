// Mobile push-token registration endpoint.
//
// The Expo mobile app (mobile/) calls:
//   - POST   /api/mobile/device-tokens  on login (registers the device)
//   - DELETE /api/mobile/device-tokens  on logout / on token invalidation
//
// Both routes authenticate via the Supabase JWT in the Authorization
// header (handled by middleware + getCurrentUser()'s Bearer fallback).
//
// The token itself is an Expo Push Token of the form
// 'ExponentPushToken[xxx...]'. We store it in device_tokens (migration
// 023) and let src/lib/push.js fan out to it.
//
// Idempotency: Expo tokens are stable per (device, app install). We use
// ON CONFLICT (expo_push_token) DO UPDATE so re-registering bumps
// last_seen_at and re-points the token at the current user — the same
// device used by two different staff (shared kiosk) is supported.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'

const RegisterSchema = z.object({
  expo_push_token: z.string().min(10).max(200).regex(
    /^ExponentPushToken\[[A-Za-z0-9_-]+\]$/,
    'Must be an Expo push token of the form ExponentPushToken[…]'
  ),
  platform: z.enum(['ios', 'android', 'web']).default('ios'),
  device_name: z.string().max(120).optional(),
  // Shape-checked, not just length-capped: `app_version` is client-reported
  // and the highest value in the fleet becomes the target version every
  // other staff member is judged against on /api/staff-devices (STAFF-DEV).
  // An unbounded number here would mark the whole estate outdated. Mirrors
  // parseVersion() in src/lib/staff-devices.js — max 4 digits per segment.
  app_version: z.string().max(40).regex(
    /^v?\d{1,4}(\.\d{1,4}){0,2}([-+][\w.]+)?$/,
    'Must look like a version, e.g. 2.2.0'
  ).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const validation = await validateBody(request, RegisterSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()

  // Upsert by token — re-registers from the same device update the row
  // rather than creating a duplicate. We also re-point user_id in case a
  // shared kiosk-style device is now logged in as a different staffer.
  const { data, error } = await db
    .from('device_tokens')
    .upsert(
      {
        user_id: user.id,
        expo_push_token: body.expo_push_token,
        platform: body.platform,
        device_name: body.device_name,
        app_version: body.app_version,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'expo_push_token' }
    )
    .select('id')
    .single()

  if (error) {
    console.error('[device-tokens] upsert failed', error)
    return NextResponse.json(
      { success: false, error: 'Failed to register device' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true, data: { id: data.id } })
}

const UnregisterSchema = z.object({
  expo_push_token: z.string().min(10).max(200),
})

export async function DELETE(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const validation = await validateBody(request, UnregisterSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()

  // Scope the delete by user_id so a malicious caller can't unregister
  // someone else's device by guessing tokens.
  const { error } = await db
    .from('device_tokens')
    .delete()
    .eq('user_id', user.id)
    .eq('expo_push_token', body.expo_push_token)

  if (error) {
    console.error('[device-tokens] delete failed', error)
    return NextResponse.json(
      { success: false, error: 'Failed to unregister device' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}
