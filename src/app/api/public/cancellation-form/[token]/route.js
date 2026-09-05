// /api/public/cancellation-form/[token] — the membership cancellation form's
// public API (CANCEL-FORM.3). No session: the capability is the token in the
// URL, minted per contact per send by staff (src/lib/cancellation-form).
//
// GET  → what the page needs: first name, plan name, branding, the
//        operator's copy (rendered), and the option bounds. Marks the link
//        opened. Never returns email, phone, price, credits, ids or capacity.
// POST → files ONE agent_membership_requests row (kind pause | cancellation)
//        on the channel the link was delivered by, and notifies staff. The
//        link is single-use: the claim is atomic, a second submit answers
//        `submitted` and inserts nothing.
//
// Failure posture copied from /api/preferences/[token]: a uniform 404 for
// forged / expired / revoked / unknown tokens (no existence oracle), a
// per-IP budget only for tokens that do NOT resolve, and a per-token budget
// for the ones that do — so a NAT full of real members can't lock each
// other out (consent-token-guard.js). POST validates the body BEFORE any
// limiter or lookup so a malformed body costs nobody a window.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getClientIp, checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { guardBeforeTokenLookup, penaliseInvalidToken, guardResolvedToken } from '@/lib/consent-token-guard'
import { getLocationBranding } from '@/lib/location-branding'
import { dublinTodayStr } from '@/lib/dublin-time'
import { notifyAgentApprovalRequest } from '@/lib/agent/approval-notify'
import { resolveLink, markOpened, claimLink, unclaimLink, attachRequest } from '@/lib/cancellation-form/links'
import { resolveCancellationFormCopy, renderCopy } from '@/lib/cancellation-form/copy'
import { SubmitSchema, formOptions, validateSubmission } from '@/lib/cancellation-form/rules'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SCOPE = 'cancel-form'
const NO_STORE = { 'Cache-Control': 'no-store' }

const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
const notFound = () => json({ success: false, error: 'Not found' }, 404)

/** Shared front half of GET and POST: IP peek → resolve → per-token charge. */
async function gate(db, request, token) {
  const ip = getClientIp(request)
  const ipBudget = await guardBeforeTokenLookup(db, SCOPE, ip)
  if (!ipBudget.allowed) return { refused: rateLimitResponse(ipBudget) }
  const resolved = await resolveLink(db, token)
  if (!resolved) {
    await penaliseInvalidToken(db, SCOPE, ip)
    return { refused: notFound() }
  }
  const tokenBudget = await guardResolvedToken(db, SCOPE, token)
  if (!tokenBudget.allowed) return { refused: rateLimitResponse(tokenBudget) }
  return { ...resolved, ip }
}

async function loadCopy(db, locationId) {
  const { data: loc } = await db.from('locations').select('name, settings').eq('id', locationId).maybeSingle()
  return {
    locationName: loc?.name || null,
    copy: resolveCancellationFormCopy(loc?.settings?.customer_agent?.cancellation_form),
  }
}

function firstNameOf(contact) {
  return (contact?.first_name || '').trim() || String(contact?.name || '').trim().split(/\s+/)[0] || ''
}

export async function GET(request, props) {
  const { token } = await props.params
  const db = createServerClient()
  const g = await gate(db, request, token)
  if (g.refused) return g.refused
  const { link, contact } = g

  const [{ locationName, copy }, branding] = await Promise.all([
    loadCopy(db, link.location_id),
    getLocationBranding(db, link.location_id),
  ])

  let submittedKind = null
  if (link.used_at && link.request_id) {
    const { data: req } = await db.from('agent_membership_requests').select('kind').eq('id', link.request_id).maybeSingle()
    submittedKind = req?.kind || null
  }
  if (!link.used_at) await markOpened(db, link.id)

  const vars = {
    first_name: firstNameOf(contact),
    plan: contact.glofox_membership_plan || 'current',
    location: branding.companyName || locationName || '',
  }
  const today = dublinTodayStr()
  return json({
    success: true,
    data: {
      state: link.used_at ? 'submitted' : 'open',
      submitted_kind: submittedKind,
      first_name: vars.first_name,
      plan_name: contact.glofox_membership_plan || null,
      branding: { companyName: branding.companyName, logoUrl: branding.logoUrl || null },
      copy: {
        form_intro: renderCopy(copy.form_intro, vars),
        pause_offer_text: renderCopy(copy.pause_offer_text, vars),
        end_date_help_text: renderCopy(copy.end_date_help_text, vars),
        confirm_text: renderCopy(copy.confirm_text, vars),
        // {start_date}/{end_date} are filled client-side once chosen.
        thanks_cancel_text: renderCopy(copy.thanks_cancel_text, { ...vars, end_date: '{end_date}' }),
        thanks_pause_text: renderCopy(copy.thanks_pause_text, { ...vars, start_date: '{start_date}', end_date: '{end_date}' }),
      },
      options: formOptions(copy, today),
    },
  })
}

export async function POST(request, props) {
  const { token } = await props.params
  // Validate first (pure, no DB): a malformed body 400s without spending
  // anyone's limiter or touching the token.
  const v = await validateBody(request, SubmitSchema)
  if (!v.ok) return v.response

  const db = createServerClient()
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `cancelform:submit:${ip}`, { max: 10, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes and try again.')

  const g = await gate(db, request, token)
  if (g.refused) return g.refused
  const { link, contact } = g

  const { copy } = await loadCopy(db, link.location_id)
  const checked = validateSubmission(v.data, copy, dublinTodayStr())
  if (!checked.ok) return json({ success: false, error: checked.error, field: checked.field }, 400)

  // Single-use: the atomic claim decides who files. A lost claim means a
  // request already exists for this link — answer as submitted, never
  // insert a second row.
  const claimed = await claimLink(db, link.id)
  if (!claimed) return json({ success: true, data: { state: 'submitted', kind: null } })

  const { data: row, error } = await db.from('agent_membership_requests').insert({
    location_id: link.location_id,
    contact_id: contact.id,
    kind: checked.kind,
    channel: link.channel,
    conversation_id: link.conversation_id || null,
    details: { ...checked.details, link_id: link.id, delivered_via: link.channel },
    customer_note: checked.customerNote,
    status: 'pending',
    retention_flagged: checked.kind === 'cancellation',
  }).select('id').single()
  if (error || !row) {
    await unclaimLink(db, link.id)
    console.error(`[cancel-form] request insert failed for link ${link.id}: ${error?.message || 'no row'}`)
    return json({ success: false, error: 'We could not save your request. Please try again in a moment.' }, 500)
  }

  await attachRequest(db, link.id, row.id)
  await notifyAgentApprovalRequest(db, {
    requestId: row.id,
    locationId: link.location_id,
    kind: checked.kind,
    customerName: contact.name || firstNameOf(contact) || null,
    summary: checked.summary,
  })
  return json({ success: true, data: { state: 'submitted', kind: checked.kind } })
}
