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
 *
 * C16 PUSHREADERR.1 — a failed READ is a failed send too. When the
 * permission, template or device read fails, every recipient that could
 * not be judged or reached counts in `failed`, the result carries
 * `read_failed: 1`, and the failure is logged once with logError. It used
 * to come back as `skipped` / plain zeros — "nobody to tell" — and the
 * send-once callers ledgered it, losing the message for good. The clean
 * path's shape is unchanged (no `read_failed` key).
 *
 * Each of those reads (profiles, profile_locations, the role templates,
 * device_tokens) is retried ONCE, in-process, after a short pause
 * (READ_RETRY_DELAY_MS, overridable per call with `readRetryDelayMs`) before
 * it counts as failed — most read errors are a one-request blip, and the
 * retry turns them back into a normal send instead of a deferred one. Only a
 * read is ever retried here, never a send; the final failure is logged once.
 */

import { createServerClient } from './supabase'
import { logError } from './log'
import { androidChannelId } from '@shared/push-channels'
import { resolvePermission, mergeTemplates, DEFAULT_MOBILE_PERMISSIONS_BY_ROLE } from '@shared/permissions'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const BATCH_SIZE = 100 // Expo accepts up to 100 messages per request

// Retry schedule for a failed Expo batch POST: 2 retries (3 attempts
// total) with modest backoff. Expo blips / 429s / 5xxs are usually
// transient; anything that survives 2.5s of backoff is counted as
// failed and left to the caller's own retry story (crons re-tick).
const RETRY_DELAYS_MS = [500, 2000]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// C16 PUSHREADERR.1 review — the pause before the one retry of a failed READ.
// Short on purpose: at most four reads per sendPush call can each spend it
// once, so a send that hits a real outage costs well under a second more.
const READ_RETRY_DELAY_MS = 200

/**
 * Run a read, and on an `{ error }` run it once more after `delayMs`. The
 * retry's answer is final, whatever it is. `read` must BUILD the query each
 * time (a supabase-js builder is a thenable; the retry needs a fresh one).
 * A read that throws is not caught here: the caller decides, as before.
 *
 * @param {() => PromiseLike<{ data?: any, error?: any }>} read
 * @param {number} delayMs
 */
async function readWithOneRetry(read, delayMs) {
  const first = await read()
  if (!first?.error) return first
  if (delayMs > 0) await sleep(delayMs)
  return read()
}

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

// C16 PUSHREADERR.1 — the one answer to a read sendPush could not make:
// logged once, structurally, and returned with every recipient it could not
// judge or reach counted as failed, so a ledger caller retries instead of
// recording "nobody to tell".
function pushReadFailed(what, meta, payload, error, { skipped = 0, failed }) {
  logError('push', `${what} read failed; nobody was told`, {
    ...meta, type: payload?.data?.type ?? null, category: payload?.category ?? null, err: error,
  })
  return { sent: 0, skipped, invalidated: 0, failed, read_failed: 1 }
}

/**
 * Resolve which of `ids` may receive a push for `category`, reading the LIVE
 * permission source — `profile_locations.permissions` (per mig 058).
 *
 * IMPORTANT: `profiles.permissions` is stale post-058 and is intentionally NOT
 * read here — reading it was the regression that silently ignored every
 * admin-set per-category opt-out.
 *
 * PERM-AUDIT.3 — resolution runs through the shared resolver per
 * assignment (user override → role template (mig 364) → role code
 * default) instead of reading raw explicit-false keys off the blob.
 * REQUIRED for sparse per-user blobs: a sparse blob no longer
 * materialises `notify_x: false` when that IS the role default, so the
 * old raw-key read would have silently started sending role-default-off
 * categories. Semantics:
 *   - suppressed if inactive;
 *   - suppressed if ANY assignment RESOLVES push_notifications or
 *     notify_<category> to false — conservative, an opt-out (explicit,
 *     template, or role default) at any location is honoured. (When staff
 *     span multiple locations and per-location granularity is wanted,
 *     thread the notification's locationId into this check.)
 *   - the LOCATION features gate (tier 1) is deliberately NOT applied
 *     (location: null): notify_* keys are tier-1-exempt by design, and
 *     push_notifications-in-features was never enforced on the send
 *     path — skipping it preserves behaviour for users assigned to
 *     feature-stripped locations (e.g. CCF Autos).
 *   - users with NO assignments (e.g. master) are allowed, as before.
 *
 * PUSH-LOC.1 — when `opts.locationId` is passed, a user's opt-out is
 * judged ONLY by their assignment(s) AT THAT LOCATION. The old
 * any-assignment-false rule silently killed every WhatsApp push to
 * Richard — owner at three locations (default on) — because he also
 * holds a `staff` row at SourceIt whose ROLE DEFAULT is
 * notify_whatsapp:false (live miss: Kevin's reply + the handoff alert,
 * 2026-07-03). Users with no assignment at the given location (master;
 * cross-location assignees) keep the conservative all-assignments rule.
 *
 * C16 PUSHREADERR.1 — returns the read errors beside the answer. `error`
 * (profiles or profile_locations unreadable): nobody can be judged, `allowed`
 * is empty and means nothing. `templatesError` (role templates unreadable):
 * `allowed` is judged on the code defaults, as it always silently was, so a
 * refusal in it may be a default standing in for a template that turns the
 * category ON (the staff/fte template does, for bookings) — the caller must
 * not read that refusal as an opt-out.
 *
 * @param {object} db        service-role supabase client
 * @param {string[]} ids     profile ids to consider
 * @param {string} [category]  notify_<category> to gate on (omit = master only)
 * @param {object} [opts]
 * @param {string} [opts.locationId]  the location this notification belongs to
 * @param {number} [opts.readRetryDelayMs]  pause before the one retry of a
 *   failed read (default READ_RETRY_DELAY_MS; tests pass 0)
 * @returns {Promise<{ allowed: Set<string>, error: object|null, templatesError: object|null }>}
 */
export async function readPushAllowedIds(db, ids, category, opts = {}) {
  const allowed = new Set()
  if (!ids?.length) return { allowed, error: null, templatesError: null }
  const retryDelay = opts.readRetryDelayMs ?? READ_RETRY_DELAY_MS
  // Each read gets one retry before it counts as failed (see the file header).
  // Without these two nobody can be judged: `active` and every opt-out live
  // here. A failed read is not "nobody may be told" (and not "everybody").
  const { data: profiles, error: profilesErr } = await readWithOneRetry(
    () => db.from('profiles').select('id, active, employment_type').in('id', ids), retryDelay,
  )
  if (profilesErr) return { allowed, error: profilesErr, templatesError: null }
  const { data: links, error: linksErr } = await readWithOneRetry(
    () => db.from('profile_locations').select('profile_id, location_id, role, permissions').in('profile_id', ids),
    retryDelay,
  )
  if (linksErr) return { allowed, error: linksErr, templatesError: null }

  // Role templates (mig 364) for every (location, role) pair in play.
  // RECEPTION.2 (mig 367): 'all' rows apply to everyone of the role;
  // employment-type rows layer on top for matching users.
  const locationIds = [...new Set((links || []).map(l => l.location_id).filter(Boolean))]
  let templates = []
  let templatesError = null
  if (locationIds.length > 0) {
    // A builder RESOLVES with { error } rather than throwing, so the old
    // try/catch alone never saw a failed read. Both are kept: the catch for a
    // genuine throw (folded into `error`, so it gets the one retry too).
    // Either way we degrade to code defaults (as before) and SAY so, so
    // sendPush can count the refusals as unjudged.
    const { data, error } = await readWithOneRetry(async () => {
      try {
        return await db
          .from('location_role_permissions')
          .select('location_id, role, employment_type, permissions')
          .in('location_id', locationIds)
      } catch (err) {
        return { data: null, error: err }
      }
    }, retryDelay)
    if (error) templatesError = error
    else templates = data || []
  }
  const rowFor = (locId, role, emp) =>
    templates.find(t => t.location_id === locId && t.role === role && t.employment_type === emp)?.permissions || null
  const templateFor = (locId, role, userEmploymentType) =>
    mergeTemplates(
      rowFor(locId, role, 'all'),
      userEmploymentType ? rowFor(locId, role, userEmploymentType) : null
    )?.mobile || null

  const activeById = new Map((profiles || []).map(p => [p.id, p.active === true]))
  const employmentById = new Map((profiles || []).map(p => [p.id, p.employment_type || null]))
  const linksByUser = new Map()
  for (const l of links || []) {
    const arr = linksByUser.get(l.profile_id) || []
    arr.push(l)
    linksByUser.set(l.profile_id, arr)
  }

  const resolves = (link, key) => resolvePermission({
    role: link.role,
    location: null, // tier 1 deliberately skipped — see doc comment
    permissions: link.permissions?.mobile || null,
    roleTemplate: templateFor(link.location_id, link.role, employmentById.get(link.profile_id)),
    defaults: DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
    key,
  })

  for (const id of ids) {
    if (!activeById.get(id)) continue
    const userLinks = linksByUser.get(id) || []
    // PUSH-LOC.1 — the notification's own location decides, when we know it
    // and the user is assigned there; otherwise every assignment gates.
    let gateLinks = userLinks
    if (opts.locationId) {
      const atLocation = userLinks.filter(l => l.location_id === opts.locationId)
      if (atLocation.length) gateLinks = atLocation
    }
    if (gateLinks.some(l => !resolves(l, 'push_notifications'))) continue
    if (category && gateLinks.some(l => !resolves(l, `notify_${category}`))) continue
    // Optional capability gate — e.g. only staff who actually hold the mobile
    // WhatsApp Inbox permission should get "Mia is handling a chat" pings.
    if (opts.requireMobileKey && gateLinks.some(l => !resolves(l, opts.requireMobileKey))) continue
    allowed.add(id)
  }
  return { allowed, error: null, templatesError }
}

/**
 * The allowed set alone — the pre-C16 contract (an empty Set on a failed
 * read). No production caller may use it (tests/push-allowed-callers.test.js):
 * a caller that ledgers, claims or reports must use readPushAllowedIds and
 * treat `error` / `templatesError` as "not judged", never as "opted out".
 *
 * @returns {Promise<Set<string>>}
 */
export async function resolvePushAllowedIds(db, ids, category, opts = {}) {
  return (await readPushAllowedIds(db, ids, category, opts)).allowed
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
 * @param {object} [opts]
 * @param {string} [opts.locationId]  The location this notification belongs
 *                                    to — makes the per-category opt-out
 *                                    per-location (PUSH-LOC.1).
 * @param {string} [opts.requireMobileKey]  Extra mobile-permission capability
 *                                    the recipient must hold (e.g. 'whatsapp'
 *                                    inbox access) on top of the category gate.
 * @param {number} [opts.readRetryDelayMs]  Pause before the one retry of a
 *                                    failed read (default READ_RETRY_DELAY_MS).
 *
 * @returns {Promise<{sent:number, skipped:number, invalidated:number, failed:number, read_failed?:1}>}
 */
export async function sendPush(userIds, payload, opts = {}) {
  const ids = Array.isArray(userIds) ? userIds : [userIds]
  if (!ids.length) return { sent: 0, skipped: 0, invalidated: 0, failed: 0 }

  const db = createServerClient()

  // Pull permissions for all targets in one round-trip and respect the
  // per-user master switch + per-category opt-out before we even fetch
  // tokens. That avoids spending an Expo round-trip on users who would
  // immediately be filtered out anyway.
  // Per-category opt-out lives on profile_locations.permissions (mig 058);
  // profiles.permissions is stale and must NOT be read here.
  const meta = { candidates: ids.length, locationId: opts.locationId ?? null }
  const retryDelay = opts.readRetryDelayMs ?? READ_RETRY_DELAY_MS
  const { allowed: allowedSet, error: permErr, templatesError } = await readPushAllowedIds(
    db, ids, payload.category,
    { locationId: opts.locationId, requireMobileKey: opts.requireMobileKey, readRetryDelayMs: retryDelay },
  )
  // C16 PUSHREADERR.1 (D1/D2) — nobody could be judged: report it, never as
  // opt-outs.
  if (permErr) return pushReadFailed('permissions', meta, payload, permErr, { failed: ids.length })

  const allowedIds = ids.filter(id => allowedSet.has(id))
  const refused = ids.length - allowedIds.length
  // D3 — with the role templates unreadable, a refusal was made on the code
  // default, which a template may override (staff/fte turns bookings ON). It
  // is unjudged, not an opt-out: counted as failed so a ledger caller retries.
  const unjudged = templatesError ? refused : 0
  const skipped = refused - unjudged
  const readFlag = templatesError ? { read_failed: 1 } : {}
  if (templatesError) {
    logError('push', 'role templates read failed; judged on code defaults', {
      ...meta, refused, type: payload?.data?.type ?? null, category: payload?.category ?? null, err: templatesError,
    })
  }

  if (!allowedIds.length) return { sent: 0, skipped, invalidated: 0, failed: unjudged, ...readFlag }

  // Fetch all push tokens for the allowed users.
  //
  // ANDROID-VIS.1 (mig 565) — expo_push_token is NULLABLE: a device row can
  // now exist purely so the fleet report can see it (Android, until FCM
  // credentials exist; iOS with notifications declined). Those rows are not
  // recipients — `to: null` would be sent to Expo and come back as a
  // per-ticket error, counted as `failed`, which is a lie about the send.
  // One retry before it counts as failed (see the file header).
  const { data: tokens, error: tokensErr } = await readWithOneRetry(() => db
    .from('device_tokens')
    .select('id, expo_push_token')
    .not('expo_push_token', 'is', null)
    .in('user_id', allowedIds), retryDelay)

  // D4 — "no device" is only true when the read worked.
  if (tokensErr) {
    return pushReadFailed('device_tokens', { ...meta, candidates: allowedIds.length }, payload, tokensErr, {
      skipped, failed: allowedIds.length + unjudged,
    })
  }
  if (!tokens?.length) return { sent: 0, skipped, invalidated: 0, failed: unjudged, ...readFlag }

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

  return { sent, skipped, invalidated, failed: failed + unjudged, ...readFlag }
}

/**
 * The role rule, pure. PUSH-ROLES.1 — judge the PER-LOCATION role (roles are
 * per-location, mig 051), not the global profiles.role: filtering on the
 * global role both over-notified (global owner holding a staff row here) and,
 * worse, silently excluded every `master` from owner/manager fan-outs —
 * masters hold every decision right, so they are always included. Live miss:
 * Richard (global role master, owner at Stillorgan) never received the
 * new-time-off-request push, 2026-07-27.
 *
 * Exported so a caller that has ALREADY read the studio's profile_locations
 * rows (with `role` and `profiles(role, active)`) applies the same rule
 * without a second read (swap-cover-server.js notifyOpenPool).
 *
 * @param {object[]|null} links  profile_locations rows: { profile_id, role, profiles: { role, active } }
 * @param {string[]} roles
 * @returns {string[]} profile ids, in row order
 */
export function roleRecipientIdsFromLinks(links, roles) {
  if (!roles?.length) return []
  return (links || [])
    .filter(l => l?.profiles?.active && (roles.includes(l.role) || l.profiles.role === 'master'))
    .map(l => l.profile_id)
}

/**
 * The active profile ids holding one of `roles` at `locationId`, WITH the
 * read error. REPLACE.1b review 1: the "taken" notice of a claimed shift
 * offer stamped itself done on the empty list a failed read returned, so the
 * managers' only signal was lost. C1 RECIPIENTS.1 moved every caller here.
 * A caller that stamps, claims or reports after sending must treat `error`
 * as "try again" (or as a fault), never as "nobody to tell".
 *
 * @param {object} db          service-role supabase client
 * @param {string} locationId
 * @param {string[]} roles     e.g. ['owner', 'manager']
 * @returns {Promise<{ ids: string[], error: object|null }>}
 */
export async function readRoleRecipientIds(db, locationId, roles) {
  if (!locationId || !roles?.length) return { ids: [], error: null }
  const { data: links, error } = await db
    .from('profile_locations')
    .select('profile_id, role, profiles!inner(id, role, active)')
    .eq('location_id', locationId)
  if (error) return { ids: [], error }
  return { ids: roleRecipientIdsFromLinks(links, roles), error: null }
}

// C1 RECIPIENTS.1 — the fan-out wrappers' answer to a FAILED recipients read:
// logged once, structurally, and said in the result beside the zero counts,
// so it never passes for "nobody to tell" (plain zeros, no key).
function recipientsReadFailed(what, meta, payload, error) {
  logError('push', `${what} recipients read failed; nobody was told`, {
    ...meta, type: payload?.data?.type ?? null, category: payload?.category ?? null, err: error?.message ?? String(error),
  })
  return { sent: 0, skipped: 0, invalidated: 0, failed: 0, recipients_failed: 1 }
}

/**
 * Convenience: send a notification to every user with a given role at a
 * given location. Useful for fan-out events like "new time-off request
 * needs approval" → notify all managers at the requester's location.
 *
 * Never throws. C1 RECIPIENTS.1: a FAILED recipients read is logged here,
 * once, with logError, and returned as `recipients_failed: 1` beside the zero
 * counts, so it can never pass for "nobody holds the role" (plain zeros, no
 * key). Callers are one-shot best-effort alerts; the log is their signal.
 *
 * @param {string} locationId
 * @param {string[]} roles     e.g. ['owner', 'manager']
 * @param {object} payload     Same shape as sendPush()
 */
export async function sendPushToRolesAtLocation(locationId, roles, payload) {
  const db = createServerClient()
  const { ids, error } = await readRoleRecipientIds(db, locationId, roles)
  if (error) return recipientsReadFailed('role', { locationId, roles }, payload, error)
  if (!ids.length) return { sent: 0, skipped: 0, invalidated: 0, failed: 0 }
  // PUSH-LOC.1 — this fan-out is location-scoped by definition, so the
  // per-category opt-out is judged at THIS location, not any other
  // assignment the recipient happens to hold.
  return sendPush(ids, payload, { locationId })
}

/**
 * Every active profile linked to a location (any role), WITH the read error.
 * Candidate set for a fan-out that is then narrowed by a capability gate
 * (e.g. inbox access) + the per-category opt-out inside sendPush.
 *
 * C1 RECIPIENTS.1 — was resolveLocationMemberIds, which discarded the error
 * and returned [] on a failed read ("nobody here"). Renamed so no caller can
 * keep reading the old string[] shape by accident.
 *
 * @returns {Promise<{ ids: string[], error: object|null }>}
 */
export async function readLocationMemberIds(db, locationId) {
  if (!locationId) return { ids: [], error: null }
  const { data: links, error } = await db
    .from('profile_locations')
    .select('profile_id, profiles!inner(id, active)')
    .eq('location_id', locationId)
  if (error) return { ids: [], error }
  return { ids: (links || []).filter(l => l?.profiles?.active).map(l => l.profile_id), error: null }
}

/**
 * Convenience: notify everyone with WhatsApp INBOX access at a location —
 * i.e. anyone who can actually open the thread on their phone (the mobile
 * `whatsapp` permission), not just managers. Used for the "Mia is handling a
 * chat" agent-activity ping. Category opt-out + master switch still apply.
 *
 * Never throws. A FAILED member read is logged and returned as
 * `recipients_failed: 1`, exactly as sendPushToRolesAtLocation does.
 *
 * @param {string} locationId
 * @param {object} payload   Same shape as sendPush() (set payload.category)
 */
export async function sendPushToInboxStaffAtLocation(locationId, payload) {
  const db = createServerClient()
  const { ids, error } = await readLocationMemberIds(db, locationId)
  if (error) return recipientsReadFailed('inbox-staff', { locationId }, payload, error)
  if (!ids.length) return { sent: 0, skipped: 0, invalidated: 0, failed: 0 }
  return sendPush(ids, payload, { locationId, requireMobileKey: 'whatsapp' })
}
