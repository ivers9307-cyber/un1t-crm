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

/**
 * OVERBUDGET-COPY.1 — "September 2026" from an ISO month start. Formatted in
 * UTC: the input is a bare calendar date, and letting the process timezone
 * parse it is how a 1st becomes the previous month.
 */
export function monthLabel(monthStartIso) {
  const [y, m] = String(monthStartIso).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/**
 * OVERBUDGET-COPY.1 — what this draft actually does to what staff can see.
 *
 * The email used to say, flatly, "Staff cannot see their shifts until then."
 * That is true of a period nobody has published yet. It is FALSE of the
 * commonest over-budget draft there is: a re-publish of a week that is
 * already live, where every shift on it stays exactly as visible as it was
 * and the draft holds back the CHANGES, not the roster. An owner reading the
 * untrue version has been told the studio is unstaffed on paper and will
 * approve on urgency that does not exist.
 *
 * @param {{ alreadyPublished?: boolean, fullyPublished?: boolean }} state
 * @returns {string}
 */
export function approvalVisibilityLine({ alreadyPublished = false, fullyPublished = false } = {}) {
  if (fullyPublished) {
    return 'These dates are already published, so staff can still see the shifts that are live now. What is held back is the change in this draft, until an owner approves it.'
  }
  if (alreadyPublished) {
    return 'Part of this period is already published, so staff can still see the shifts that are live on those days. The rest of the period, and the changes in this draft, reach them when an owner approves it.'
  }
  return 'The roster is held in draft until an owner approves it. Staff cannot see their shifts until then.'
}

/**
 * BUDGETAPPROVE.1 / OVERBUDGET-COPY.1 — the per-month breakdown. The budget is
 * MONTHLY and #1704 projects per month, so a period crossing a month boundary
 * has one overrun per month and a single summed figure tells the approver
 * nothing about which month to look at. Rendered only when the period touches
 * more than one month; a single-month draft keeps the one-line summary it had.
 */
function monthBreakdownHtml(months) {
  if (!Array.isArray(months) || months.length < 2) return ''
  const rows = months.map((m) => {
    const verdict = m.overrunEur > 0
      ? `<strong style="color: #dc2626;">${formatEur(m.overrunEur)} over</strong>`
      : 'within budget'
    return `<li style="margin-bottom: 4px;">${escapeHtml(monthLabel(m.monthStart))}: ${formatEur(m.monthProjectedTotalEur)} projected against the ${formatEur(m.monthlyBudgetEur)} monthly budget &mdash; ${verdict}</li>`
  }).join('')
  return `
      <p style="margin-bottom: 6px;">This period runs across ${months.length} months, and the budget is monthly, so each one is judged on its own:</p>
      <ul style="margin: 0 0 16px; padding-left: 20px; font-size: 14px;">${rows}</ul>`
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
    months,
    alreadyPublished = false,
    fullyPublished = false,
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
      <p>The projected contractor labour cost is <strong style="color: #dc2626;">${formatEur(overrunEur)} over the ${formatEur(budgetEur)} monthly budget</strong>.</p>
      ${monthBreakdownHtml(months)}
      <p>${approvalVisibilityLine({ alreadyPublished, fullyPublished })}</p>
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
