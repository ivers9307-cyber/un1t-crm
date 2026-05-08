// Roster v2 phase 5 — email helper for over-budget approval
// requests. Uses the same Postmark transactional flow as the
// rest of the app (stream='outbound').
//
// Recipients: every owner-at-this-location (per
// profile_locations.role = 'owner'). The sender is the manager
// who attempted the publish.

import { sendEmail } from './postmark'
import { getAppUrl } from './app-url'
import { logWarn } from './log'

function formatEur(n) {
  if (n == null) return '€0'
  return `€${Math.round(Number(n)).toLocaleString('en-IE')}`
}

export async function sendOverBudgetApprovalEmail(db, args) {
  const {
    rosterId,
    locationId,
    publisherName,
    periodStart,
    periodEnd,
    overrunEur,
    budgetEur,
  } = args

  // Find every owner-at-this-location.
  const { data: owners, error: ownersErr } = await db
    .from('profile_locations')
    .select('profile_id, profiles:profile_id(id, full_name, email, active)')
    .eq('location_id', locationId)
    .eq('role', 'owner')
  if (ownersErr) {
    throw new Error(`Owner lookup failed: ${ownersErr.message}`)
  }

  // Location name for the subject line.
  const { data: loc } = await db
    .from('locations')
    .select('name')
    .eq('id', locationId)
    .single()
  const locationName = loc?.name || 'this location'

  const recipients = (owners || [])
    .map(o => o.profiles)
    .filter(p => p && p.active && p.email)
    .map(p => ({ id: p.id, name: p.full_name, email: p.email }))

  if (recipients.length === 0) {
    // Nothing to send to. The roster still exists in draft so an
    // owner can approve it from the UI when they next log in.
    return { sent: 0, recipients: 0 }
  }

  const approvalUrl = `${getAppUrl()}/schedule/approvals?roster_id=${rosterId}`
  const subject = `Roster approval needed — ${locationName} is ${formatEur(overrunEur)} over budget`

  const period = periodStart === periodEnd
    ? periodStart
    : `${periodStart} – ${periodEnd}`

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #111827; line-height: 1.5;">
      <h2 style="margin: 0 0 16px; font-size: 18px;">Roster approval needed</h2>
      <p>${escapeHtml(publisherName)} has published a roster for <strong>${escapeHtml(locationName)}</strong> covering <strong>${escapeHtml(period)}</strong>.</p>
      <p>The projected contractor labour cost for the month is <strong style="color: #dc2626;">${formatEur(overrunEur)} over the ${formatEur(budgetEur)} monthly budget</strong>.</p>
      <p>The roster is held in draft until an owner approves it. Staff cannot see their shifts until then.</p>
      <p style="margin: 28px 0;">
        <a href="${approvalUrl}" style="display: inline-block; padding: 10px 16px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500;">Review &amp; approve</a>
      </p>
      <p style="font-size: 13px; color: #6b7280;">This is an automated notification from the UN1T CRM.</p>
    </div>
  `

  let sent = 0
  for (const r of recipients) {
    try {
      await sendEmail({
        to: r.email,
        subject,
        htmlBody,
        stream: 'outbound',
        tag: 'roster-approval',
        metadata: { roster_id: rosterId, location_id: locationId, recipient_id: r.id },
      })
      sent++
    } catch (e) {
      // Best-effort — surface in logs but don't fail the publish.
      logWarn('roster-email', 'send failed', { email: r.email, recipientId: r.id, err: e })
    }
  }

  return { sent, recipients: recipients.length }
}

function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
