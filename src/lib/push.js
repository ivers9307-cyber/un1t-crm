/**
 * Push notifications via the Expo Push Service.
 *
 * The mobile app (mobile/ — Expo / React Native) registers an Expo push
 * token on login (POST /api/mobile/device-tokens). When something
 * notification-worthy happens server-side, route handlers / cron jobs
 * call sendPush() with the user IDs to notify and a payload. We look up
 * the device tokens, batch-send to https://exp.host/--/api/v2/push/send
 * (Expo proxies to APNs / FCM), and prune any tokens Expo reports as
 * DeviceNotRegistered.
 *
 * Per-user notification preferences are honoured automatically:
 *   - permissions.mobile.push_notifications = false → user is skipped
 *   - permissions.mobile.notify_<category> = false → user is skipped for
 *     that specific category (the caller passes a `category` field)
 *
 * Categories (mirror StaffForm.jsx allMobilePermissions):
 *   - time_off   (request decisions, inbound for managers)
 *   - schedule   (new week published)
 *   - swap       (inbound + responses)
 *   - lead       (new contact assigned)
 *   - whatsapp   (inbound message)
 *
 * Usage:
 *   import { sendPush } from '@/lib/push'
 *   await sendPush(['user-uuid-1', 'user-uuid-2'], {
 *     title: 'Time off approved',
 *     body: 'Your leave request for 5–9 May has been approved.',
 *     category: 'time_off',
 *     data: { type: 'time_off_decision', request_id: '...' },
 *   })
 *
 * Returns: { sent, skipped, invalidated } — counts only, no throw on
 * partial failure (push is best-effort; never blocks the caller).
 */

import { createServerClient } from './supabase'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const BATCH_SIZE = 100 // Expo accepts up to 100 messages per request

/**
 * Fan out a push notification to one or more users.
 *
 * @param {string|string[]} userIds  Profile id(s) to notify.
 * @param {object} payload
 * @param {string} payload.title    Notification title (shown bold).
 * @param {string} payload.body     Notification body (shown below title).
 * @param {string} [payload.category]  One of: time_off, schedule, swap,
 *                                     lead, whatsapp. Filters by
 *                                     permissions.mobile.notify_<category>.
 * @param {object} [payload.data]   Custom data delivered to the app —
 *                                  used for in-app routing (which screen
 *                                  to open when the user taps the
 *                                  notification).
 * @param {string} [payload.sound]  'default' (iOS chime) | null. Default 'default'.
 * @param {number} [payload.badge]  Override the iOS app icon badge count.
 *
 * @returns {Promise<{sent:number, skipped:number, invalidated:number}>}
 */
export async function sendPush(userIds, payload) {
  const ids = Array.isArray(userIds) ? userIds : [userIds]
  if (!ids.length) return { sent: 0, skipped: 0, invalidated: 0 }

  const db = createServerClient()

  // Pull permissions for all targets in one round-trip and respect the
  // per-user master switch + per-category opt-out before we even fetch
  // tokens. That avoids spending an Expo round-trip on users who would
  // immediately be filtered out anyway.
  const { data: profiles } = await db
    .from('profiles')
    .select('id, permissions, active')
    .in('id', ids)

  const allowedIds = []
  let skipped = 0
  for (const p of profiles || []) {
    if (!p.active) { skipped++; continue }
    const m = p.permissions?.mobile || {}
    if (m.push_notifications === false) { skipped++; continue }
    if (payload.category && m[`notify_${payload.category}`] === false) {
      skipped++
      continue
    }
    allowedIds.push(p.id)
  }

  if (!allowedIds.length) return { sent: 0, skipped, invalidated: 0 }

  // Fetch all push tokens for the allowed users.
  const { data: tokens } = await db
    .from('device_tokens')
    .select('id, expo_push_token')
    .in('user_id', allowedIds)

  if (!tokens?.length) return { sent: 0, skipped, invalidated: 0 }

  // Build Expo messages — one per token. Expo will silently drop
  // malformed tokens; we additionally prune any reported as
  // DeviceNotRegistered after the response.
  const messages = tokens.map(t => ({
    to: t.expo_push_token,
    title: payload.title,
    body: payload.body,
    sound: payload.sound === null ? null : 'default',
    badge: payload.badge,
    data: payload.data || {},
  }))

  let sent = 0
  let invalidated = 0
  const invalidTokenIds = []

  // Batch — Expo accepts up to 100 per request.
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const chunk = messages.slice(i, i + BATCH_SIZE)
    const chunkTokens = tokens.slice(i, i + BATCH_SIZE)

    let response
    try {
      response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'gzip, deflate',
          'content-type': 'application/json',
        },
        body: JSON.stringify(chunk),
      })
    } catch (err) {
      // Network blip — log and continue (best-effort).
      console.error('[push] expo fetch failed', err)
      continue
    }

    if (!response.ok) {
      console.error('[push] expo non-2xx', response.status, await response.text().catch(() => ''))
      continue
    }

    const json = await response.json().catch(() => null)
    const tickets = json?.data || []

    tickets.forEach((ticket, idx) => {
      if (ticket.status === 'ok') {
        sent++
      } else if (
        ticket.status === 'error' &&
        ticket.details?.error === 'DeviceNotRegistered'
      ) {
        // App was uninstalled or the token was rotated. Prune.
        invalidTokenIds.push(chunkTokens[idx].id)
        invalidated++
      } else {
        // Unknown error (e.g. MessageTooBig, MessageRateExceeded) —
        // log but don't prune.
        console.error('[push] ticket error', ticket)
      }
    })
  }

  if (invalidTokenIds.length) {
    await db.from('device_tokens').delete().in('id', invalidTokenIds)
  }

  return { sent, skipped, invalidated }
}

/**
 * Convenience: send a notification to every user with a given role at a
 * given location. Useful for fan-out events like "new time-off request
 * needs approval" → notify all managers at the requester's location.
 *
 * @param {string} locationId
 * @param {string[]} roles     e.g. ['owner', 'manager']
 * @param {object} payload     Same shape as sendPush()
 */
export async function sendPushToRolesAtLocation(locationId, roles, payload) {
  const db = createServerClient()
  const { data: links } = await db
    .from('profile_locations')
    .select('profile_id, profiles!inner(id, role, active)')
    .eq('location_id', locationId)

  const ids = (links || [])
    .filter(l => l.profiles?.active && roles.includes(l.profiles.role))
    .map(l => l.profile_id)

  if (!ids.length) return { sent: 0, skipped: 0, invalidated: 0 }
  return sendPush(ids, payload)
}
