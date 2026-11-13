// MCPEMAIL.1 — helpers shared by the staff MCP email-campaign tools. Not a
// tool itself (no defineTool). Everything here acts at ONE studio, passed in.

import { createHash } from 'node:crypto'
import { hasPermissionForLocation } from '@/lib/permissions'
import { ToolRefusal } from './registry.js'
import { canReadSegmentsAt } from '@/lib/segment-access'
import { validateAudienceFilter, stripUnsetFilterRows, InvalidAudienceFilterError } from '@/lib/audience-filter'
import { listLandingMediaForUser } from '@/lib/landing-media-library'

export const LIST_CAP = 50

/** The gate every email tool shares: the Email Marketing permission at the studio. */
export const emailGate = (user, studioId) => hasPermissionForLocation(user, studioId, 'email')

/** Statuses at which a campaign has (or had) recipients, so results make sense. */
export const RESULT_STATUSES = Object.freeze(['queued', 'sending', 'sent', 'failed', 'cancelled'])

// The named columns the tools read, including the total_* counters that
// campaignDisplayStats falls back on. html_content is read only to judge
// "edited in the CRM" and is never returned.
export const CAMPAIGN_COLS = 'id, location_id, name, subject, preview_text, from_name, from_email, reply_to, html_content, '
  + 'audience_filter, postmark_stream, ab_subject_b, ab_test_pct, ab_wait_hours, parent_campaign_id, '
  + 'resend_enabled, resend_wait_hours, resend_subject, '
  + 'agent_blocks, created_via, status, scheduled_at, last_error, created_at, '
  + 'total_recipients, total_sent, total_delivered, total_opened, total_clicked, total_bounced, '
  + 'total_complained, total_unsubscribed'

/** sha256 hex of an email body, as stored in agent_blocks.html_sha256. */
export function htmlSha256(html) {
  return createHash('sha256').update(String(html ?? ''), 'utf8').digest('hex')
}

/** True when the filter has at least one real (set) filter row. */
export function hasFilterRows(filter) {
  const stripped = stripUnsetFilterRows(filter)
  return Array.isArray(stripped?.filters) && stripped.filters.length >= 1
}

/** One campaign at THIS studio. Another studio's id and a random uuid answer the same. */
export async function loadCampaignAtStudio(db, studio, campaignId) {
  const { data, error } = await db
    .from('campaigns')
    .select(CAMPAIGN_COLS)
    .eq('id', campaignId)
    .eq('location_id', studio.id)
    .maybeSingle()
  if (error) throw new Error(`Failed to load campaign: ${error.message}`)
  if (!data) throw new ToolRefusal('not_found', 'Campaign not found.')
  return data
}

/**
 * The audience filter for a tool call: exactly one of a saved segment at this
 * studio or an inline filter. It must validate and carry at least one row, so
 * "everyone" is never reached by leaving a filter empty.
 */
export async function resolveAudienceFilter(db, studio, user, { segment_id, filter } = {}) {
  const hasSegment = segment_id != null
  const hasFilter = filter != null
  if (hasSegment === hasFilter) {
    throw new ToolRefusal('invalid_input', 'Give exactly one of segment_id and filter.')
  }
  let chosen = filter
  if (hasSegment) {
    const { data, error } = await db
      .from('contact_segments')
      .select('id, filter')
      .eq('id', segment_id)
      .eq('location_id', studio.id)
      .maybeSingle()
    if (error) throw new Error(`Failed to load segment: ${error.message}`)
    if (!data || !canReadSegmentsAt(user, studio.id)) throw new ToolRefusal('not_found', 'Segment not found.')
    chosen = data.filter ?? {}
  }
  return cleanSegmentFilter(chosen)
}

/** This studio's image library entries, newest first. */
export async function studioImages(db, user, studio) {
  const { items } = await listLandingMediaForUser(db, user, { kind: 'image' })
  return (items || []).filter((i) => i.location_id === studio.id)
}

/** The image URLs a campaign at this studio may use. */
export async function allowedImageUrls(db, user, studio) {
  return new Set((await studioImages(db, user, studio)).map((i) => i.url))
}

/**
 * A segment's filter for saving: unset rows stripped, validated, and at least
 * one real row (the same rule and sentence as resolveAudienceFilter), so a
 * saved segment can never mean "everyone".
 */
export function cleanSegmentFilter(filter) {
  const cleaned = stripUnsetFilterRows(filter)
  try {
    validateAudienceFilter(cleaned)
  } catch (e) {
    if (e instanceof InvalidAudienceFilterError) throw new ToolRefusal('invalid_input', e.message)
    throw e
  }
  if (!hasFilterRows(cleaned)) {
    throw new ToolRefusal('invalid_input', 'The audience filter needs at least one filter row.')
  }
  return cleaned
}
