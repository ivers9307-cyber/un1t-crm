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
//
// ANDROID-VIS.1 (mig 565) — DUAL IDENTITY. The push token is no longer the
// identity, only a capability: a device that cannot obtain one (every
// Android device, until FCM credentials exist — see
// mobile/docs/android-fcm-setup.md) still registers, with
// expo_push_token NULL, so platform / app_version / last_seen_at /
// geofence_permission all report and the device stops being invisible on
// /settings/notifications/health. Identity is `device_key`, an
// app-generated per-install id (mobile/lib/device-key.js).
//
// The transition is the delicate part, and it is handled in
// resolveDeviceIdentity() below — read that comment before changing
// anything here.

import { z } from 'zod'
import { GEOFENCE_PERMISSION_VALUES } from '@/lib/geofence-permission-chips'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'

const RegisterSchema = z.object({
  // ANDROID-VIS.1 — OPTIONAL since mig 565. A device with no push token
  // still registers (see the header): absence means "cannot receive push",
  // not "invalid request". `.nullable()` too, because the client sends the
  // key explicitly rather than omitting it when a token attempt failed.
  expo_push_token: z.string().min(10).max(200).regex(
    /^ExponentPushToken\[[A-Za-z0-9_-]+\]$/,
    'Must be an Expo push token of the form ExponentPushToken[…]'
  ).nullable().optional(),
  // ANDROID-VIS.1 — the device identity (mig 565). Shape-pinned to what
  // mobile/lib/device-key.js mints (32 lowercase hex) so this column can
  // never be used to smuggle arbitrary text into the report.
  device_key: z.string().regex(
    /^[a-f0-9]{32}$/,
    'Must be a 32-character lowercase hex device key'
  ).optional(),
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
  // STAFF-DEV.7 — what the OS reports for BACKGROUND location on this
  // device. Optional: clients below 2.2.0 never send it, and their
  // silence must not be read as a denial (see the upsert note below).
  // Values mirror the mig 466 CHECK constraint.
  // GEO-ATT.22 — read from the shared registry, so this route cannot accept a
  // value the operator surfaces have no chip for. 'unknown' (GEO-ATT.21, mig
  // 542) = the device asked the OS and the call threw, so geofencing is NOT
  // running on it. Distinct from omitting the field (nothing to say) and from
  // NULL in the column (never reported at all).
  geofence_permission: z.enum(GEOFENCE_PERMISSION_VALUES).optional(),
}).refine(
  (body) => Boolean(body.expo_push_token || body.device_key),
  {
    // mig 565's CHECK says the same thing in the database. Refusing here
    // turns what would be a 500 into an honest 400 naming the field.
    message: 'One of expo_push_token or device_key is required',
    path: ['device_key'],
  }
)

/**
 * ANDROID-VIS.1 — reconcile the pre-565 (token-keyed) and post-565
 * (device_key-keyed) identities before the upsert runs.
 *
 * The unique index on expo_push_token STAYS (13 live iOS rows are keyed by
 * it, older clients still conflict on it, and one push token must never be
 * claimed by two rows). So an updated client reporting BOTH a device_key
 * and the token its old row already holds cannot simply upsert on
 * device_key: nothing matches the key, PostgREST attempts an INSERT, and
 * the surviving token index rejects it — the device would 500 forever.
 *
 * Two statements, in this order, make the transition safe:
 *
 *   1. ADOPT. Stamp our device_key onto the row that already holds this
 *      token and has no key yet. Runs at most once per device in its
 *      lifetime; afterwards it matches nothing. This is what preserves the
 *      13 iOS rows — their id, created_at and geofence_permission history
 *      all survive, they simply gain a key.
 *
 *   2. RELEASE. Clear the token off any row holding it under a DIFFERENT
 *      key (an app restored onto a new install that was handed the same
 *      token). `.neq` is SQL `<>`, which is false for NULL, so this can
 *      never touch a row step 1 just adopted. Losing push on a row whose
 *      install no longer exists is correct — Expo would only ever deliver
 *      that token to one install anyway — and the alternative is a hard
 *      unique-violation on a report that should not be able to fail.
 *
 * Both are best-effort by design: a failure is logged and the upsert still
 * runs. Worst case the upsert then hits the token index and returns 500,
 * which is exactly where we were before — never worse.
 *
 * NEITHER statement is scoped to user_id, and that is deliberate: the row
 * being adopted may legitimately belong to a DIFFERENT staffer (a shared
 * kiosk-style device, which the upsert has always supported by re-pointing
 * user_id). It inherits the pre-565 trust model exactly — the Expo push
 * token has always been treated as proof of "this is that device", and the
 * upsert has always re-pointed user_id on the strength of it. This adds no
 * new class of claim; it only makes the claim durable.
 */
async function resolveDeviceIdentity(db, { deviceKey, token }) {
  if (!deviceKey || !token) return

  const { error: adoptError } = await db
    .from('device_tokens')
    .update({ device_key: deviceKey })
    .eq('expo_push_token', token)
    .is('device_key', null)
  if (adoptError) console.error('[device-tokens] legacy-row adoption failed', adoptError)

  const { error: releaseError } = await db
    .from('device_tokens')
    .update({ expo_push_token: null })
    .eq('expo_push_token', token)
    .neq('device_key', deviceKey)
  if (releaseError) console.error('[device-tokens] stale-token release failed', releaseError)
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const validation = await validateBody(request, RegisterSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()

  // ANDROID-VIS.1 — which column the upsert conflicts on depends on what
  // the client can identify itself with. A client on 2.3.x+ always sends
  // device_key, so it takes the first branch; anything older still lands
  // on the original token path, unchanged.
  await resolveDeviceIdentity(db, {
    deviceKey: body.device_key,
    token: body.expo_push_token,
  })
  const onConflict = body.device_key ? 'device_key' : 'expo_push_token'

  // Upsert by the identity above — re-registers from the same device
  // update the row rather than creating a duplicate. We also re-point
  // user_id in case a shared kiosk-style device is now logged in as a
  // different staffer.
  //
  // ANDROID-VIS.1 — expo_push_token is spread in ONLY when we have one,
  // for the same reason geofence_permission is (below). A device that
  // reports while a token attempt is failing — an iOS user who revoked
  // notifications, a transient APNs error — must not have its stored token
  // wiped: the report would then have SILENCED a phone that can still
  // receive push. Absence of a token is not proof it is gone. What does
  // remove a dead token is Expo itself, via the DeviceNotRegistered prune
  // in src/lib/push.js, which is evidence rather than inference.
  //
  // STAFF-DEV.7 — geofence_permission is spread in ONLY when the client
  // actually sent one. An UPSERT writes the whole row, so an omitted key
  // overwrites the stored value with null (that is exactly why
  // device_name / app_version go null for old clients). Reporting is a
  // 2.2.0-era behaviour, so a staff member on an older build re-opening
  // the app would otherwise wipe a permission we had already learned —
  // and "never reported" renders identically to "no data", making the
  // whole diagnostic useless. Absence of data is not a denial.
  const { data, error } = await db
    .from('device_tokens')
    .upsert(
      {
        user_id: user.id,
        platform: body.platform,
        device_name: body.device_name,
        app_version: body.app_version,
        last_seen_at: new Date().toISOString(),
        ...(body.device_key ? { device_key: body.device_key } : {}),
        ...(body.expo_push_token ? { expo_push_token: body.expo_push_token } : {}),
        ...(body.geofence_permission
          ? {
            geofence_permission: body.geofence_permission,
            geofence_permission_at: new Date().toISOString(),
          }
          : {}),
      },
      { onConflict }
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

// ANDROID-VIS.1 — sign-out must be able to deregister a device that has no
// push token, or a token-less Android row would keep naming the person who
// last signed out as its owner and the fleet report would lie. Either
// identity is accepted; at least one is required.
const UnregisterSchema = z.object({
  expo_push_token: z.string().min(10).max(200).nullable().optional(),
  device_key: z.string().regex(/^[a-f0-9]{32}$/).optional(),
}).refine(
  (body) => Boolean(body.expo_push_token || body.device_key),
  { message: 'One of expo_push_token or device_key is required', path: ['device_key'] }
)

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
  // someone else's device by guessing tokens (or device keys).
  //
  // device_key wins when both are sent: it is the identity, and a device
  // whose token has rotated since sign-in would otherwise match nothing.
  let query = db.from('device_tokens').delete().eq('user_id', user.id)
  query = body.device_key
    ? query.eq('device_key', body.device_key)
    : query.eq('expo_push_token', body.expo_push_token)
  const { error } = await query

  if (error) {
    console.error('[device-tokens] delete failed', error)
    return NextResponse.json(
      { success: false, error: 'Failed to unregister device' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}
