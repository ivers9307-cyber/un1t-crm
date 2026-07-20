// SAAS4-O2 — per-tenant ops-alert routing (SaaS machinery plan §4).
//
// Ops/billing notices (cap warnings, sync-stale, and future
// token-expiring / queue-backlog events) route to the ORG's configured
// recipient emails (org_settings.ops_alert_emails, mig 424 — editable
// beside the hard caps on /settings/usage). No recipients configured →
// the pre-O2 behaviour stays: a master-only push. So shipping this
// changes nothing until a tenant sets recipients.
//
// Design note: the plan sketched this on locations.notification_config,
// but that registry is lead-time/role shaped and per-location, while
// the live ops notices are org-level (caps) — org_settings emails are
// the simpler truth. Per-location granularity can layer later.
//
// Always best-effort: an alert-delivery failure must never fail the
// cron that raised it.

import { createServerClient } from '@/lib/supabase'
import { sendTransactionalEmail } from '@/lib/postmark'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { ADMIN_ROLES } from '@/lib/schemas'
import { logWarn } from '@/lib/log'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Normalise a comma-separated string or TEXT[] into clean emails. */
export function parseOpsAlertEmails(input) {
  const parts = Array.isArray(input) ? input : String(input || '').split(',')
  const out = []
  for (const raw of parts) {
    const email = String(raw || '').trim().toLowerCase()
    if (email && EMAIL_RE.test(email) && !out.includes(email)) out.push(email)
  }
  return out
}

/**
 * Deliver one ops alert for an org. Email to configured recipients;
 * master push fallback when none. Never throws.
 *
 * @param {{ organizationId: string, locationId?: string|null,
 *           subject: string, htmlBody: string, pushBody?: string }} alert
 *   locationId is used for email attribution/branding and as the push
 *   fallback target.
 * @param {{ db?: object, sendEmail?: Function, sendPush?: Function }} [deps]
 * @returns {Promise<{ channel: 'email'|'push_fallback'|'none', recipients?: number }>}
 */
export async function sendOpsAlert(alert, { db, sendEmail, sendPush } = {}) {
  try {
    const client = db || createServerClient()
    const email = sendEmail || sendTransactionalEmail
    const push = sendPush || sendPushToRolesAtLocation

    const { data: settings } = await client
      .from('org_settings')
      .select('ops_alert_emails')
      .eq('organization_id', alert.organizationId)
      .maybeSingle()
    const recipients = parseOpsAlertEmails(settings?.ops_alert_emails)

    if (recipients.length === 0) {
      // Pre-O2 behaviour: master-only push (no notify_* category fits an
      // ops notice — omitting the category routes to master per push.js).
      if (alert.locationId) {
        await push(alert.locationId, ADMIN_ROLES, {
          title: alert.subject,
          body: alert.pushBody || alert.subject,
        })
      }
      return { channel: 'push_fallback' }
    }

    for (const to of recipients) {
      try {
        await email({
          to,
          subject: alert.subject,
          htmlBody: alert.htmlBody,
          locationId: alert.locationId ?? null,
          tag: 'ops-alert',
        })
      } catch (e) {
        logWarn('ops-alerts', 'send failed', { to, err: e?.message || e })
      }
    }
    return { channel: 'email', recipients: recipients.length }
  } catch (e) {
    logWarn('ops-alerts', 'sendOpsAlert swallowed', { err: e?.message || e })
    return { channel: 'none' }
  }
}
