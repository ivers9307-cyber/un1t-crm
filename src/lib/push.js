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
 * Returns: { sent, skipped, invalidated, failed } — counts only, no throw
 * on partial failure (push is best-effort; never blocks the caller).
 * `failed` counts messages that never got an ok ticket from Expo after
 * retries — callers that keep a "was this reminder sent?" ledger use it
 * to distinguish "nothing to send" from "the send pipeline fell over"
 * (see send-push-reminders cron).
 */

import { createServerClient } from './supabase'
import { androidChannelId } from '@shared/push-channels'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const BATCH_SIZE = 100 // Expo accepts up to 100 messages per request

// Retry schedule for a failed Expo batch POST: 2 retries (3 attempts
// total) with modest backoff. Expo blips / 429s / 5xxs are usually
// transient; anything that survives 2.5s of backoff is counted as
// failed and left to the caller's own retry story (crons re-tick).
const RETRY_DELAYS_MS = [500, 2000]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * POST one batch of messages to Expo with retry + backoff.
 *
 * Retries on: fetch exceptions (network blip), 429, 5xx, and 2xx
 * responses whose body isn't parseable JSON (proxy garbage). Gives up
 * immediately on any other 4xx — a malformed request won't get better
 * by retrying.
 *
 * @returns {Promise<object[]|null>} the Expo ticket array, or null when
 *   the batch ultimately failed (caller counts the whole chunk failed).
 */
async function postExpoBatch(chunk) {
  const attempts = RETRY_DELAYS_MS.length + 1
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(RETRY_DELAYS_MS[attempt - 2])

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
      console.error(`[push] expo fetch failed (attempt ${attempt}/${attempts})`, err)
      continue
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      console.error(`[push] expo non-2xx ${response.status} (attempt ${attempt}/${attempts})`, body)
      // 4xx other than 429 = our request is bad; retrying won't help.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) return null
      continue
    }

    const json = await response.json().catch(() => null)
    if (!json || !Array.isArray(json.data)) {
      // A 2xx with an unparseable/shapeless body used to be a SILENT
      // no-op (sent nothing, counted nothing). Log it and treat it as
      // a retryable failure.
      console.error(`[push] expo response unparseable (attempt ${attempt}/${attempts})`)
      continue
    }
    return json.data
  }
  return null
}

/**
 * Resolve which of `ids` may receive a push for `category`, reading the LIVE
 * permission source — `profile_locations.permissions` (per mig 058).
 *
 * IMPORTANT: `profiles.permissions` is stale post-058 and is intentionally NOT
 * read here — reading it was the regression that silently ignored every
 * admin-set per-category opt-out. A user is suppressed if inactive, or if ANY
 * of their location assignments has the master switch (`push_notifications`)
 * or the per-category toggle (`notify_<category>`) explicitly `false` —
 * conservative, so an opt-out set at any location is honoured. (When staff
 * span multiple locations and per-location granularity is wanted, thread the
 * notification's locationId into this check.)
 *
 * @param {object} db        service-role supabase client
 * @param {string[]} ids     profile ids to consider
 * @param {string} [category]  notify_<category> to gate on (omit = master only)
 * @returns {Promise<Set<string>>} the allowed profile ids
 */
export async function resolvePushAllowedIds(db, ids, category) {
  const allowed = new Set()
  if (!ids?.length) return allowed
  const { data: profiles } = await db.from('profiles').select('id, active').in('id', ids)
  const { data: links } = await db
    .from('profile_locations').select('profile_id, permissions').in('profile_id', ids)
  const activeById = new Map((profiles || []).map(p => [p.id, p.active === true]))
  const mobilesByUser = new Map()
  for (const l of links || []) {
    const arr = mobilesByUser.get(l.profile_id) || []
    arr.push(l.permissions?.mobile || {})
    mobilesByUser.set(l.profile_id, arr)
  }
  for (const id of ids) {
    if (!activeById.get(id)) continue
    const mobiles = mobilesByUser.get(id) || []
    if (mobiles.some(m => m.push_notifications === false)) continue
    if (category && mobiles.some(m => m[`notify_${category}`] === false)) continue
    allowed.add(id)
  }
  return allowed
}

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
 * @returns {Promise<{sent:number, skipped:number, invalidated:number, failed:number}>}
 */
export async function sendPush(userIds, payload) {
  const ids = Array.isArray(userIds) ? userIds : [userIds]
  if (!ids.length) return { sent: 0, skipped: 0, invalidated: 0, failed: 0 }

  const db = createServerClient()

  // Pull permissions for all targets in one round-trip and respect the
  // per-user master switch + per-category opt-out before we even fetch
  // tokens. That avoids spending an Expo round-trip on users who would
  // immediately be filtered out anyway.
  // Per-category opt-out lives on profile_locations.permissions (mig 058);
  // profiles.permissions is stale and must NOT be read here.
  const allowedSet = await resolvePushAllowedIds(db, ids, payload.category)
  const allowedIds = ids.filter(id => allowedSet.has(id))
  let skipped = ids.length - allowedIds.length

  if (!allowedIds.length) return { sent: 0, skipped, invalidated: 0, failed: 0 }

  // Fetch all push tokens for the allowed users.
  const { data: tokens } = await db
    .from('device_tokens')
    .select('id, expo_push_token')
    .in('user_id', allowedIds)

  if (!tokens?.length) return { sent: 0, skipped, invalidated: 0, failed: 0 }

  // Build Expo messages — one per token. Expo will silently drop
  // malformed tokens; we additionally prune any reported as
  // DeviceNotRegistered after the response.
  // Android: route to the per-category channel (created by
  // mobile/lib/push-register.js from the same shared map). An unknown
  // channelId would make Android auto-create a system default channel,
  // so unmapped categories resolve to the legacy 'default' channel
  // instead. iOS ignores channelId.
  const channelId = androidChannelId({
    category: payload.category,
    type: payload.data?.type,
  })

  const messages = tokens.map(t => ({
    to: t.expo_push_token,
    title: payload.title,
    body: payload.body,
    sound: payload.sound === null ? null : 'default',
    badge: payload.badge,
    channelId,
    data: payload.data || {},
  }))

  let sent = 0
  let invalidated = 0
  let failed = 0
  const invalidTokenIds = []

  // Batch — Expo accepts up to 100 per request. Each batch retries
  // independently (postExpoBatch); a batch that still fails after
  // backoff counts every message in it as failed.
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const chunk = messages.slice(i, i + BATCH_SIZE)
    const chunkTokens = tokens.slice(i, i + BATCH_SIZE)

    const tickets = await postExpoBatch(chunk)
    if (!tickets) {
      failed += chunk.length
      continue
    }

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
        // Other per-ticket error (e.g. MessageTooBig,
        // MessageRateExceeded) — log, count failed, don't prune.
        console.error('[push] ticket error', ticket)
        failed++
      }
    })
  }

  if (invalidTokenIds.length) {
    // supabase-js builders are thenables — destructure and check error
    // explicitly; a swallowed delete failure leaves dead tokens burning
    // Expo quota every send.
    const { error: pruneErr } = await db.from('device_tokens').delete().in('id', invalidTokenIds)
    if (pruneErr) console.error('[push] dead-token prune failed', pruneErr)
  }

  return { sent, skipped, invalidated, failed }
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

  if (!ids.length) return { sent: 0, skipped: 0, invalidated: 0, failed: 0 }
  return sendPush(ids, payload)
}
