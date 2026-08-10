// GAPS-P8 — POST /api/campaigns/copy-assist.
//
// An operator writing a campaign asks for a few alternative subject lines (or
// body versions) in the house style. It is an ASSIST: it returns text, the
// operator picks or edits one, and nothing here applies, schedules or sends
// anything.
//
// Three properties this route is built around:
//
//  1. It spends money per call, so it is session-guarded (never an API key, and
//     never public), gated on the same `email` permission as the send paths,
//     checked at the TARGET location, metered by two rate-limit buckets before
//     the model is touched (per user and per location), and — since COPYCAP.1 —
//     held to the same per-location prepaid wallet cap the send paths enforce.
//     The limiter fails open on a DB outage by design (src/lib/rate-limit.js) —
//     auth and the permission gate, not the limiter, are what stop an
//     anonymous bill.
//
//  2. It fails SOFT. No key, an exhausted wallet, a 529 from Anthropic, a
//     socket reset: the response is still 200 with `available:false` and an
//     empty list, because the composer must keep working exactly as it did
//     before this feature existed. An assist that can break the compose screen
//     is a dependency, not an assist.
//
//  3. It does not trust its own model. Everything comes back through
//     parseSuggestions() in src/lib/copy-assist.js, which scrubs deterministically
//     and drops any suggestion that invents a fact or surfaces class capacity.
//
// PII: only the operator's brief and their own draft copy go into the prompt.
// No contact names, emails, audience or recipient data is read by this route at
// all — it queries no tenant table.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { checkSpend } from '@/lib/wallet-enforcement'
import { anthropicMessages } from '@/lib/anthropic'
import {
  COPY_ASSIST_MODEL,
  COPY_ASSIST_KINDS,
  MAX_SUGGESTIONS,
  BRIEF_MAX_CHARS,
  DRAFT_BODY_MAX_CHARS,
  buildCopyAssistMessages,
  extractModelText,
  parseSuggestions,
  toPlainText,
} from '@/lib/copy-assist'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Per user: enough for a real writing session (a few goes at a subject, then at
// the body), far short of a script. Per location: the backstop when several
// staff at one studio hammer it on the same day.
const USER_LIMIT = { max: 20, windowMs: 15 * 60_000 }
const LOCATION_LIMIT = { max: 120, windowMs: 24 * 60 * 60_000 }

const CopyAssistSchema = z.object({
  location_id: uuidLike,
  kind: z.enum(COPY_ASSIST_KINDS),
  brief: z.string().max(BRIEF_MAX_CHARS).optional(),
  subject: z.string().max(500).optional(),
  // The draft body arrives as whatever the editor holds (Unlayer HTML export or
  // hand-written HTML); it is flattened to text below and never forwarded raw.
  body: z.string().max(200_000).optional(),
  count: z.number().int().min(1).max(MAX_SUGGESTIONS).optional(),
})

const unavailable = (reason) =>
  NextResponse.json({
    success: true,
    data: { available: false, reason, suggestions: [], dropped: [], generated_by: 'model', reviewed: false },
  })

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const v = await validateBody(request, CopyAssistSchema)
  if (!v.ok) return v.response
  const input = v.data

  const guard = assertLocationAccess(user, input.location_id)
  if (guard) return guard

  // Same gate as the real send paths (COMMSFIX.D.5), resolved at the campaign's
  // location rather than the session's active one.
  if (!hasPermissionForLocation(user, input.location_id, 'email')) {
    return NextResponse.json({ success: false, error: 'No email permission at this location' }, { status: 403 })
  }

  const brief = (input.brief || '').trim()
  const subject = (input.subject || '').trim()
  const bodyText = toPlainText(input.body, DRAFT_BODY_MAX_CHARS)
  if (!brief && !subject && !bodyText) {
    return NextResponse.json({
      success: false,
      error: 'Add a short brief, a draft subject, or some draft copy first. Suggestions are only ever a rewrite of what you supply.',
    }, { status: 400 })
  }

  const db = createServerClient()
  for (const [key, limit] of [
    [`copy-assist:user:${user.id}`, USER_LIMIT],
    [`copy-assist:loc:${input.location_id}`, LOCATION_LIMIT],
  ]) {
    const result = await checkRateLimit(db, key, limit)
    if (!result.allowed) {
      return rateLimitResponse(result, 'That is a lot of suggestions in a short time. Try again shortly.')
    }
  }

  // COPYCAP.1 — the per-location prepaid wallet cap (INTEG-C3), the same gate
  // every other Anthropic caller in the estate already passes through: the
  // campaign send path, the WhatsApp broadcasts, and Mia's auto-reply. This
  // route metered its spend into usage_events from day one but never asked
  // whether the location was allowed to spend it, so a tier-pinned location
  // with an exhausted ai_message allowance and an empty wallet kept billing.
  //
  // BEFORE the model, obviously — a cap checked afterwards is a report.
  //
  // A capped call takes the route's existing SOFT shape (200 + available:
  // false + a reason), not an error, for the same reason an unset API key
  // does: the composer must keep working exactly as it did before this
  // feature existed. The operator writes their own subject line; they do not
  // get a broken screen because billing said no.
  //
  // Fails OPEN on any throw. checkSpend is documented never to throw and
  // answers allow:true on any infrastructure failure, but an assist must not
  // be the thing that breaks the composer if that ever changes. Unpinned
  // locations — every UN1T location today — answer 'unpinned' and are
  // completely unaffected.
  //
  // NOT extended to the rate limiter above, which still fails open by design
  // (src/lib/rate-limit.js): a limiter that fails closed takes the compose
  // screen down with the rate_limits table.
  try {
    const spend = await checkSpend(db, input.location_id, 'ai_message', 'ai')
    if (!spend.allow) return unavailable(spend.reason || 'wallet_empty')
  } catch { /* fail open — checkSpend already never throws */ }

  // Fail soft #1: not configured. Checked AFTER the guards so an unauthorised
  // caller cannot use the response shape to probe whether the key is set.
  if (!process.env.ANTHROPIC_API_KEY) return unavailable('not_configured')

  const { system, user: userPrompt } = buildCopyAssistMessages({
    kind: input.kind,
    brief,
    subject,
    body: bodyText,
    count: input.count,
  })

  let text = ''
  try {
    const { res, data } = await anthropicMessages(
      {
        model: COPY_ASSIST_MODEL,
        max_tokens: input.kind === 'body' ? 1500 : 500,
        system,
        messages: [{ role: 'user', content: userPrompt }],
      },
      { locationId: input.location_id, source: 'campaign_copy_assist' },
    )
    // Fail soft #2: upstream said no. The operator keeps writing.
    if (!res.ok) return unavailable('upstream_error')
    text = extractModelText(data)
  } catch {
    // Fail soft #3: network/abort. Deliberately swallowed — see the header.
    return unavailable('upstream_error')
  }

  const { suggestions, dropped } = parseSuggestions(text, {
    kind: input.kind,
    source: [brief, subject, bodyText].filter(Boolean).join('\n'),
    draft: input.kind === 'body' ? bodyText : subject,
    count: input.count,
  })

  return NextResponse.json({
    success: true,
    data: {
      available: true,
      kind: input.kind,
      suggestions,
      // Reasons only, never the rejected text: showing the operator the
      // invented price would defeat the point of having dropped it.
      dropped,
      generated_by: 'model',
      reviewed: false,
    },
  })
}
