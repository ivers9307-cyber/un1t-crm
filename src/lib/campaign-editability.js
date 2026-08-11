// CAMPHIST.1 — may this campaign's CONTENT still be changed?
//
// ─── THE DEFECT ────────────────────────────────────────────────────────────
// `?edit=1` on `/communications/sent/email/[id]` opened the full CampaignEditor
// for a campaign in ANY status. On a campaign that had already gone out that
// was a silent history corruption, three ways over:
//
//   • CampaignEditor persists by writing `campaigns` DIRECTLY from the browser
//     Supabase client (`db.from('campaigns').update(payload)`), so the 409
//     status guard on `PUT /api/campaigns/[id]` never ran — the UI does not
//     call that route.
//   • The RLS policy is `FOR ALL TO authenticated USING auth_is_in_location(...)`
//     (mig 014) with no status predicate, so the database allowed it too.
//   • The editor's header pill is hard-coded to read "Draft", so a sent
//     campaign LOOKED like a draft while being edited.
//
// The consequence is that `campaign_recipients` (14 timestamp/status columns
// per recipient), `campaign_link_clicks` and `email_sends` all keep pointing at
// a `campaigns` row whose subject and body are no longer what was sent. Every
// report built on them — open rate, click report, outcome stats, the monthly
// list-health rollup — then describes the wrong creative. Nothing errors; the
// numbers are just quietly attached to the wrong email, permanently, because
// the sent copy is not recorded anywhere else.
//
// ─── THE RULE ──────────────────────────────────────────────────────────────
// Content is editable only while nothing has been sent from it. Once a
// campaign is queued or beyond, its content is the historical record of what
// went out, and the reuse path is to DUPLICATE it
// (`POST /api/campaigns/[id]/duplicate`) — which is what the send route's own
// comment has been telling operators to do since CAMPAIGN.13, for a capability
// that did not exist until now.
//
// Note this is deliberately NOT the same set as the send route's
// `['draft','scheduled','failed']`. 'failed' is re-sendable (COMMSFIX.C.5 —
// the operator fixes the audience filter and sends again) but not re-writable:
// the cron only reaches 'failed' after a populate attempt, so recipient rows
// may already exist and some mail may already have gone out.

/** The only statuses in which subject / body / design / audience may change. */
export const EDITABLE_CAMPAIGN_STATUSES = Object.freeze(['draft', 'scheduled'])

/**
 * @param {string|null|undefined} status  A `campaigns.status` value.
 * @returns {boolean}
 *
 * Fails CLOSED on anything unrecognised. `campaigns.status` is plain TEXT with
 * no CHECK constraint (mig 005), so an unknown value is reachable; treating it
 * as editable would risk overwriting a sent campaign, while treating it as
 * locked costs an operator one duplicate. Take the recoverable error.
 */
export function isCampaignContentEditable(status) {
  return EDITABLE_CAMPAIGN_STATUSES.includes(status)
}

/**
 * Operator-facing explanation of why the editor is read-only, or null when it
 * is not. Kept here so the page, the editor and the API route all say the same
 * thing. No em-dashes: customer- and operator-facing copy convention.
 *
 * @param {string|null|undefined} status
 * @returns {string|null}
 */
export function campaignLockedReason(status) {
  if (isCampaignContentEditable(status)) return null
  const label = status || 'in an unknown state'
  return `This campaign is ${label}, so its content is locked. Its recipients, opens and clicks are the record of what was actually sent. Duplicate it to send a new version.`
}

/**
 * CAMPDEL.1 — the same rule applied to DELETION, or null when the campaign may
 * still be deleted.
 *
 * Deliberately the SAME predicate as the content lock: a campaign is deletable
 * exactly while it is still a plan rather than a record. Deleting is in fact
 * the stronger act, because campaign_recipients and campaign_link_clicks are
 * ON DELETE CASCADE, so it destroys the very rows the content lock exists to
 * keep honest.
 *
 * Separate copy from campaignLockedReason because the two say different things
 * to an operator: "duplicate it instead" is the answer to a blocked edit and
 * means nothing to somebody trying to tidy a list. No em-dashes.
 *
 * @param {string|null|undefined} status
 * @returns {string|null}
 */
export function campaignUndeletableReason(status) {
  if (isCampaignContentEditable(status)) return null
  const label = status || 'in an unknown state'
  return `This campaign is ${label}, so it cannot be deleted. Its recipients, opens and clicks are the record of what was actually sent, and deleting it would take them with it.`
}
