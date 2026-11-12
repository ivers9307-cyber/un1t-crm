// MCPEMAIL.1 — POST /api/communications/campaigns/approve/[token]: the button
// on the signed-in approve page. This is the ONLY way a campaign an agent
// prepared is released: no MCP tool can move a campaign out of draft. It
// releases exactly the content, audience and timing that were tested, once,
// for the person the approval was issued to.
//
// Cookie session only. The proxy already refuses an OAuth-issued token on
// every /api path but /api/mcp, and this route is not proxy-public; it also
// refuses ANY Authorization header itself, because getCurrentUser() would
// otherwise take a Bearer before the cookie.
//
// Order: the person (never an impersonated or support session) → the approval and its campaign (loadApprovalView: theirs,
// unused, unexpired, studio access, the email permission, content key, timing,
// audience) → the release preflight → spend the approval (compare-and-set) →
// release (compare-and-set on status AND the updated_at of the row whose
// content key was checked, so an edit landing in between is never released
// untested) → void any other live approval (best effort). The approval is
// spent BEFORE the release: a spent approval with no send is the safe failure;
// a send with a reusable approval is not. Every refusal before the release
// leaves the campaign untouched.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import {
  loadApprovalView, approvalRefusalMessage, APPROVABLE_STATUSES, actingAsSomeoneElse, OWN_SESSION_MESSAGE,
} from '@/lib/campaign-approval-view'
import { consumeApproval, voidApprovals, findApproval } from '@/lib/campaign-approval'
import { releasePreflight, releaseCampaign } from '@/lib/campaign-release'
import { logError } from '@/lib/log'

export const dynamic = 'force-dynamic'

const fail = (status, error) => NextResponse.json({ success: false, error }, { status })
const NEW_TEST = 'Nothing was sent. Ask Claude to send a new test.'
const ALREADY_APPROVED = 'This campaign was already approved.'
const WITHDRAWN_DURING_PRESS = 'This approval was withdrawn: a newer test was sent, or the campaign was edited or '
  + 'cancelled through Claude. Nothing was sent by this press.'
const RELEASE_ERROR = 'Something went wrong releasing the campaign. Nothing was sent. Ask Claude to send a new test.'

// The consume touched no row: read the approval again and say why. A failed
// re-read still answers 409 (nothing was released either way).
async function lostConsumeMessage(db, token, user, nowMs) {
  let state
  try {
    state = await findApproval(db, { token, profileId: user.id, nowMs })
  } catch (e) {
    logError('campaign-approve', 'approval re-read after a lost consume failed', { error: e?.message })
    return 'This approval could not be used. Nothing was sent by this press.'
  }
  if (state.code === 'voided') return WITHDRAWN_DURING_PRESS
  if (state.code === 'expired') return approvalRefusalMessage({ reason: 'expired' })
  return ALREADY_APPROVED
}

const REFUSAL_STATUS = {
  not_found: 404,
  no_permission: 403,
}

export async function POST(request, props) {
  const { token } = await props.params

  if (request.headers.get('authorization')) return fail(401, 'Unauthorized')
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorized')
  // Under "View as" user.id is the target's: refuse before any approval lookup.
  if (actingAsSomeoneElse(user)) return fail(403, OWN_SESSION_MESSAGE)

  const db = createServerClient()
  const nowMs = Date.now()

  let view
  try {
    view = await loadApprovalView(db, user, token, nowMs)
  } catch (e) {
    logError('campaign-approve', 'approval view failed', { error: e?.message })
    return fail(500, 'This approval could not be checked. Try again.')
  }
  if (!view.ok) {
    // not_found carries no detail at all: it reads the same for a random token.
    if (view.reason === 'not_found') return fail(404, 'Not found')
    return fail(REFUSAL_STATUS[view.reason] ?? 409, approvalRefusalMessage(view))
  }

  const { approval, campaign } = view
  if (!hasPermissionForLocation(user, campaign.location_id, 'email')) {
    return fail(403, approvalRefusalMessage({ reason: 'no_permission' }))
  }

  const preflight = await releasePreflight(db, campaign, { statuses: [...APPROVABLE_STATUSES] })
  if (!preflight.ok) {
    if (preflight.code === 'status') {
      return fail(409, `This campaign is ${campaign.status}, so it can no longer be released from an approval.`)
    }
    return fail(409, preflight.message)
  }

  let spent
  try {
    spent = await consumeApproval(db, approval.id, nowMs)
  } catch (e) {
    logError('campaign-approve', 'approval consume failed', { approval_id: approval.id, error: e?.message })
    return fail(500, 'This approval could not be used. Nothing was sent. Try again.')
  }
  if (!spent) return fail(409, await lostConsumeMessage(db, token, user, nowMs))

  const release = await releaseCampaign(db, campaign, {
    sendAt: approval.send_at ? new Date(approval.send_at) : null,
    statuses: [...APPROVABLE_STATUSES],
    expectUpdatedAt: campaign.updated_at,
  })
  if (!release.ok) {
    logError('campaign-approve', 'release after consume did not apply', {
      campaign_id: campaign.id, approval_id: approval.id, code: release.code, current_status: release.current_status ?? null,
    })
    if (release.code === 'error') return fail(500, RELEASE_ERROR)
    return fail(409, `The campaign changed while it was being released. ${NEW_TEST}`)
  }

  // The one-live index means no other live approval should exist; this is a
  // second fence. The release already happened, so a failure here is logged
  // and never turned into a failed press.
  try {
    await voidApprovals(db, campaign.id, nowMs)
  } catch (e) {
    logError('campaign-approve', 'void after release failed', { campaign_id: campaign.id, error: e?.message })
  }

  return NextResponse.json({ success: true, data: { status: release.status, scheduled_at: release.scheduled_at } })
}
