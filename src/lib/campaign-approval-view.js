// MCPEMAIL.1 — what the approve page shows and what its route acts on, read in
// one place so the two can never disagree. A tool emails a person a test with
// an approve link; this resolves that link for the signed-in person and judges
// it: the approval (theirs, unused, unvoided, unexpired), the campaign's studio
// (access, then the Email Marketing permission), the content key, the timing
// and the audience size.
//
// Runs on the service role, so it scopes itself: the approval is looked up by
// token hash AND the person's profile id, the campaign by the approval's
// campaign_id, and the person must hold the campaign's studio. A bad token,
// another person's token and a campaign at a studio the person does not hold
// all answer the same `not_found`, so nothing about another studio's campaign
// is ever shown.

import { findApproval, campaignContentKey, audienceGrewTooMuch } from '@/lib/campaign-approval'
import { emailAudienceCounts } from '@/lib/email-audience-counts'
import { stripUnsetFilterRows } from '@/lib/audience-filter'
import { describeFromAddress } from '@/lib/from-address'
import { hasPermissionForLocation } from '@/lib/permissions'

// The eight content-key fields plus what the page and the release need. Named
// columns; html_content is read for the content key and the preflight only and
// must never be handed to a client component.
export const APPROVAL_CAMPAIGN_COLUMNS = 'id, name, status, scheduled_at, updated_at, '
  + 'location_id, subject, preview_text, from_name, from_email, reply_to, html_content, audience_filter'

/** The statuses an approval may release (failed campaigns are out of v1). */
export const APPROVABLE_STATUSES = Object.freeze(['draft', 'scheduled'])

const refuse = (reason, extra = {}) => ({ ok: false, reason, ...extra })

// Holds the studio at all (membership, or master). Distinct from the
// permission: someone who still belongs to the studio but lost Email Marketing
// is told so; someone who does not belong there sees the ordinary not-found.
function holdsStudio(user, locationId) {
  if (user?.role === 'master') return true
  return (user?.locations || []).some((l) => l.id === locationId)
}

/**
 * Resolve and judge an approve link for `user`.
 * @returns {Promise<
 *   { ok: true, approval, campaign, studio, counts, sendsAs } |
 *   { ok: false, reason: 'not_found'|'used'|'expired'|'voided'|'changed'|'send_at_passed'|'audience_grew'|'audience_empty'|'no_permission', campaign?, tested?, now? }
 * >}
 * Throws on a read failure (the caller answers 500; never a silent refusal or pass).
 */
export async function loadApprovalView(db, user, token, nowMs = Date.now()) {
  if (!user?.id || typeof token !== 'string' || !token) return refuse('not_found')

  const found = await findApproval(db, { token, profileId: user.id, nowMs })
  if (!found.ok) return refuse(found.code)
  const { approval } = found

  const { data: campaign, error } = await db
    .from('campaigns')
    .select(APPROVAL_CAMPAIGN_COLUMNS)
    .eq('id', approval.campaign_id)
    .maybeSingle()
  if (error) throw new Error(`campaign read failed: ${error.message}`)
  if (!campaign || !holdsStudio(user, campaign.location_id)) return refuse('not_found')
  if (!hasPermissionForLocation(user, campaign.location_id, 'email')) return refuse('no_permission')

  const known = { campaign: { id: campaign.id } }
  if (campaignContentKey(campaign) !== approval.content_key) return refuse('changed', known)
  if (approval.send_at && Date.parse(approval.send_at) <= nowMs) return refuse('send_at_passed', known)

  const { data: studio, error: studioError } = await db
    .from('locations')
    .select('id, name, timezone')
    .eq('id', campaign.location_id)
    .maybeSingle()
  if (studioError) throw new Error(`studio read failed: ${studioError.message}`)
  if (!studio) return refuse('not_found')

  const counts = await emailAudienceCounts(db, {
    filter: stripUnsetFilterRows(campaign.audience_filter),
    locationId: campaign.location_id,
  })
  if (!(counts.eligible > 0)) return refuse('audience_empty', known)
  if (audienceGrewTooMuch(approval.audience_eligible, counts.eligible)) {
    return refuse('audience_grew', { ...known, tested: approval.audience_eligible, now: counts.eligible })
  }

  const { sends_as: sendsAs } = await describeFromAddress(db, campaign.location_id, campaign.from_email ?? null)
  return { ok: true, approval, campaign, studio, counts, sendsAs }
}

const NEW_TEST = 'Ask Claude to send a new test.'

/** The one sentence the page and the route say for a refusal. */
export function approvalRefusalMessage(view) {
  switch (view?.reason) {
    case 'used': return 'This approval has already been used.'
    case 'expired': return `This approval has expired. ${NEW_TEST}`
    case 'voided': return 'This approval was withdrawn: a newer test was sent, or the campaign was changed or stopped. '
      + 'Use the link in the newest test email, or ask Claude for a new test.'
    case 'changed': return `This campaign has changed since the test was sent. ${NEW_TEST}`
    case 'send_at_passed': return `The time this campaign was to be scheduled for has passed. ${NEW_TEST}`
    case 'audience_grew': return `The audience has grown from ${view.tested} to ${view.now} since the test. ${NEW_TEST}`
    case 'audience_empty': return 'Nobody in this audience can be emailed any more, so there is nothing to send.'
    case 'no_permission': return 'You no longer have Email Marketing access at this studio, so you cannot release this campaign.'
    default: return 'This approval link is not valid for you. Check you are signed in as the person the test was sent to.'
  }
}
