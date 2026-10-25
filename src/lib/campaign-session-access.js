// MEMBERWRITESWEEP.1e — the shared gate and schema for the campaign editor's
// session routes (/api/communications/campaigns and …/[id], …/[id]/schedule,
// …/[id]/stop).
//
// Until this PR CampaignEditor and CampaignDetail wrote `campaigns` straight
// from the browser Supabase client. The only fence was the mig 014 policy
// campaigns_location_scoped (FOR ALL, `private.auth_is_in_location`), so any
// member of a studio (plain staff and reception included, with or without the
// `email` permission the Communications pages require) could create, rewrite,
// schedule, stop or delete a campaign, choose its created_by, and skip the
// audience validation and the send route's subject/body guard. Mig 684 closes
// the table to clients once these routes are deployed.
//
// The gate is D7's "keep today's gates exactly": `email` at the CAMPAIGN's
// studio, which is what /communications/sent/email/[id] (the page that
// renders the editor) and /api/campaigns/[id]/send already require. Order:
// session (401) → the row by id (404) → the caller's studios (404, not 403,
// so ids are not enumerable) → email there (403).

import { NextResponse } from 'next/server'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { validateAudienceFilter, InvalidAudienceFilterError } from '@/lib/audience-filter'
import { campaignUndeletableReason } from '@/lib/campaign-editability'

export {
  CampaignContentSchema, CampaignCreateSchema, CampaignScheduleSchema, CONTENT_FIELDS, contentPatch,
} from '@/lib/campaign-session-schemas'

export const NOT_FOUND = () => NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
export const NO_EMAIL = () => NextResponse.json({ success: false, error: 'No email permission at this location' }, { status: 403 })
export const STATUS_CHANGED = "The campaign's status changed; reload."
export const serverError = (message) => NextResponse.json({ success: false, error: message || 'Something went wrong' }, { status: 500 })
export const conflict = (error, status) => NextResponse.json({ success: false, error, data: { status } }, { status: 409 })

// Postgres check_violation: what campaigns_lock_sent_content and
// campaigns_block_sent_delete (migs 522/523) raise when a status moved past
// 'scheduled' between our read and our write.
export const CHECK_VIOLATION = '23514'

/**
 * Load a campaign by id and apply the gate. Returns { campaign } or
 * { response } (the NextResponse to return as is). `columns` must include
 * location_id.
 */
export async function loadCampaignForUser(db, user, id, columns) {
  if (!user) return { response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!uuidLike.safeParse(id).success) return { response: NOT_FOUND() }
  const { data: campaign, error } = await db.from('campaigns').select(columns).eq('id', id).maybeSingle()
  if (error) return { response: serverError('Could not read the campaign') }
  // A campaign with no studio cannot be scoped to one (prod: none, 1 Oct 2026).
  if (!campaign || !campaign.location_id) return { response: NOT_FOUND() }
  const guard = assertLocationAccessOr404(user, campaign.location_id)
  if (guard) return { response: guard }
  if (!hasPermissionForLocation(user, campaign.location_id, 'email')) return { response: NO_EMAIL() }
  return { campaign }
}

/**
 * The campaign's status as it is NOW. Used after a write that touched no row
 * or that a guard trigger refused: the run-campaigns cron moved the campaign
 * between our read and our write, so the status we judged is stale. The 409
 * carries this one, and the editor redraws its pill and buttons from it
 * (a stale or null status there left the wrong buttons, or none). A failed
 * re-read answers `fallback`.
 */
export async function currentStatus(db, id, fallback = null) {
  const { data, error } = await db.from('campaigns').select('status').eq('id', id).maybeSingle()
  if (error) return fallback
  return data?.status ?? null
}

/** The delete refusal an operator reads for `status` (CAMPDEL.1's two texts). */
export function undeletableMessage(status) {
  return ['queued', 'sending'].includes(status)
    ? 'This campaign is sending. Cancel the send first, then delete.'
    : (campaignUndeletableReason(status) || STATUS_CHANGED)
}

/** 400 for an audience filter that can never resolve (COMMSFIX.B.7 / FILTER-P1.5), else null. */
export function audienceFilterRefusal(filter) {
  try {
    validateAudienceFilter(filter)
    return null
  } catch (e) {
    if (e instanceof InvalidAudienceFilterError) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 })
    }
    throw e
  }
}
