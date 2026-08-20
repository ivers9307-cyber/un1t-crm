// NOTIF.8 — push + email-fallback orchestrator.
//
// Wraps sendPush() and adds transactional-email fallback for users
// who have NO device tokens registered AND whose target category is
// marked fallbackEmail: true in NOTIFICATION_REGISTRY. For categories
// without a fallback flag, behaves identically to sendPush.
//
// Why a wrapper rather than baking this into sendPush:
//   - push.js is consumed by 10+ existing routes that don't want
//     email side-effects (they'd be surprised to get bounces).
//   - The category-aware fallback decision lives in the registry,
//     which already documents which categories warrant the fallback
//     (contract_issued, time_off, invoice_*, shift_adjusted) and
//     which deliberately don't (task/booking reminders are too
//     time-sensitive for email).
//
// Callers opt in by calling notifyUsers() instead of sendPush().
// Migration path: leave push.js alone, migrate routes one at a
// time as the operator notices "this user didn't get the contract
// notification because they don't have the app."
//
// Returns:
//   {
//     sent:         number — Expo tickets reported 'ok'
//     skipped:      number — users blocked by master/category gates
//     invalidated:  number — Expo DeviceNotRegistered (auto-pruned)
//     emailed:      number — users with 0 tokens who got a fallback email
//     email_failed: number — fallback email attempted but Postmark rejected
//   }
//
// Best-effort throughout — never throws.

import { createServerClient } from './supabase'
import { sendPush, resolvePushAllowedIds, resolveRoleRecipientIds } from './push'
import { sendEmail } from './postmark'
import { getNotificationCategory } from './notifications-registry'
import { logInfo, logWarn } from './log'

/**
 * @param {string|string[]} userIds  profile id(s)
 * @param {object} payload  same shape as sendPush, plus optional emailHtml
 * @param {string} payload.title
 * @param {string} payload.body
 * @param {string} payload.category  must match a NOTIFICATION_REGISTRY entry
 * @param {object} [payload.data]
 * @param {string} [payload.emailHtml]  full HTML body for the fallback email.
 *                                       if missing, a plain-text-style envelope
 *                                       built from title/body is used.
 * @param {string} [payload.emailSubject]  overrides registry default.
 */
export async function notifyUsers(userIds, payload) {
  const ids = Array.isArray(userIds) ? userIds : [userIds]
  const totals = { sent: 0, skipped: 0, invalidated: 0, failed: 0, emailed: 0, email_failed: 0 }
  if (!ids.length) return totals

  const category = payload.category
  const registry = category ? getNotificationCategory(category) : null
  const shouldFallback = !!registry?.fallbackEmail

  // Fire the push to ALL users. push.js handles the per-user gate
  // (master switch + per-category notify_<cat>). For users with no
  // tokens, push.js silently nothing-to-deliver; we then optionally
  // email them as a backstop.
  const pushResult = await sendPush(ids, payload)
  totals.sent += pushResult.sent
  totals.skipped += pushResult.skipped
  totals.invalidated += pushResult.invalidated
  // Propagated so claim-before-send callers (push-dedup.js) can tell a
  // pipeline failure ("release the claim, retry later") apart from a
  // quiet no-op ("no tokens" — keep the claim, nothing to retry against).
  totals.failed += pushResult.failed || 0

  if (!shouldFallback) return totals

  // Find which of `ids` ended up with 0 deliverable tokens. We can't
  // tell from push.js's aggregate response which specific users had
  // tokens. Re-query device_tokens for the truth.
  const db = createServerClient()
  const { data: tokens } = await db
    .from('device_tokens')
    .select('user_id')
    .in('user_id', ids)
  const usersWithTokens = new Set((tokens || []).map(t => t.user_id))
  const noTokenIds = ids.filter(id => !usersWithTokens.has(id))
  if (!noTokenIds.length) return totals

  // For email fallback we need addresses + opt-in state. Mirror
  // push.js's gates: active=true + master push_notifications !== false.
  // We also respect notify_<category> at this level — if a user has
  // explicitly turned the category off, we don't go around their back
  // by emailing them.
  // Mirror push.js's gate against the LIVE source (profile_locations.permissions,
  // mig 058 — profiles.permissions is stale). Don't email around an opt-out.
  const { data: profiles } = await db
    .from('profiles')
    .select('id, full_name, email')
    .in('id', noTokenIds)
  const allowed = await resolvePushAllowedIds(db, noTokenIds, category)
  const fallbackTargets = (profiles || []).filter(p => p.email && allowed.has(p.id))
  if (!fallbackTargets.length) return totals

  // CHROME.1 — this fallback goes to STAFF (`profiles` rows above), so it is
  // platform chrome, not gym identity.
  const subject = payload.emailSubject || registry.emailSubject || payload.title || 'Repset notification'
  const html = payload.emailHtml || defaultFallbackHtml(payload, registry)

  for (const target of fallbackTargets) {
    try {
      const res = await sendEmail({
        to: target.email,
        subject,
        htmlBody: html,
        stream: 'outbound', // transactional, never broadcast
        tag: `push-fallback-${category}`,
        metadata: {
          notif_category: category,
          recipient_id: target.id,
          reason: 'no_device_tokens',
        },
      })
      // sendEmail returns the raw Postmark response — check the
      // ErrorCode field (0 = sent).
      if (res?.ErrorCode === 0 || res?.MessageID) {
        totals.emailed++
      } else {
        totals.email_failed++
        logWarn('notify-fallback', 'postmark non-ok', { res, to: target.email })
      }
    } catch (err) {
      totals.email_failed++
      logWarn('notify-fallback', 'send threw', { err: err?.message, to: target.email })
    }
  }

  if (totals.emailed > 0 || totals.email_failed > 0) {
    logInfo('notify', 'used email fallback', {
      category,
      emailed: totals.emailed,
      email_failed: totals.email_failed,
      no_token_users: noTokenIds.length,
    })
  }

  return totals
}

/**
 * Plain envelope when the caller didn't supply a custom emailHtml.
 * Brand-light — we expect callers who care about polish to pass
 * their own template.
 */
function defaultFallbackHtml(payload, registry) {
  const title = escapeHtml(payload.title || registry?.label || 'Repset notification')
  const body = escapeHtml(payload.body || '')
  // CHROME.1 — the staff app ships to the stores as "Repset"
  // (mobile/app.config.js `name`). The old copy pointed staff at an app
  // under the legacy gym name, which is not a title they can search for.
  const note = `<p style="margin-top:24px;font-size:12px;color:#666">You're receiving this email because you don't have the Repset mobile app installed. To stop emails like this, install the app and grant push permission, or have an admin turn off the "${registry?.label || 'this'}" notification for your account.</p>`
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
      <h2 style="font-size:18px;margin:0 0 12px 0">${title}</h2>
      <p style="font-size:15px;line-height:1.5;margin:0">${body}</p>
      ${note}
    </div>
  `
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Sister of notifyUsers for the fan-out shape — notify every active
 * staff member at `locationId` with one of the supplied `roles`.
 *
 * Replaces the existing push.js sendPushToRolesAtLocation pattern
 * for callers that want email fallback (e.g. "new time-off request"
 * to owner/manager). Resolves the role set to a user-id list, then
 * delegates to notifyUsers — so it gets fallback eligibility from
 * the same registry flag.
 *
 * Same { sent, skipped, invalidated, emailed, email_failed } return
 * shape as notifyUsers.
 */
export async function notifyUsersAtRoles(locationId, roles, payload) {
  if (!locationId || !roles?.length) {
    return { sent: 0, skipped: 0, invalidated: 0, failed: 0, emailed: 0, email_failed: 0 }
  }
  const db = createServerClient()
  const ids = await resolveRoleRecipientIds(db, locationId, roles)
  return notifyUsers(ids, payload)
}
