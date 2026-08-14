import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { getRequestOrigin } from '@/lib/app-url'
import { CONSENT_ACTIONS } from '@/lib/consent-actions'
import { propagateOptOut } from '@/lib/consent-propagation'
import { suppressAtPostmark } from '@/lib/postmark-suppressions'
import {
  REFUSAL_REASONS,
  guardBeforeTokenLookup,
  penaliseInvalidToken,
  guardResolvedToken,
  recordRefusedOptOut,
} from '@/lib/consent-token-guard'

export const runtime = 'nodejs'

// UNSUB-RL.1 — this route used to open with a flat per-IP limiter
// (`checkRateLimit(db, \`unsubscribe:${ip}\`, { max: 10, windowMs: 15*60_000 })`),
// which is the wrong axis for an RFC 8058 endpoint and was a live compliance
// risk: one-click POSTs come from the recipient's MAIL PROVIDER, and Gmail
// sends them from a shared proxy pool, so many different people unsubscribing
// from one campaign share a source IP. The 11th got a 429 before the token was
// even read, so their opt-out was dropped with nothing written anywhere.
// Measured live: 9 in a single 15-minute window on 2026-08-05, against a
// limit of 10.
//
// The budgets now live in @/lib/consent-token-guard, split by whether the
// token resolves — read that module's header for the full rationale, including
// what the old limiter defended and how each of those is still covered.

// Channels accepted by the unified unsubscribe POST. Any subset can
// be passed in the body; missing body = email_marketing only
// (back-compat with Gmail's List-Unsubscribe header which POSTs
// with no body).
const UNSUB_CHANNELS = ['email_marketing', 'whatsapp_marketing', 'sms_marketing']

// `contact_preferences.unsubscribe_token` is `UUID DEFAULT gen_random_uuid()`
// (mig 005). Postgres-permissive on purpose, matching `uuidLike` in schemas.js.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// One-click unsubscribe.
//
// Two callers:
//   1. Email clients that follow the List-Unsubscribe header. They
//      POST with no body — we default to email_marketing only so a
//      Gmail user clicking "Unsubscribe" doesn't accidentally lose
//      their WhatsApp / SMS marketing too.
//   2. The unified unsubscribe page (Phase 5A) at /unsubscribe/[token].
//      It POSTs `{ channels: ['email_marketing', ...] }` to opt the
//      contact out of every marketing channel they ticked.
//
// Body shape: `{ channels?: string[] }`. Unknown channel names are
// silently dropped. Empty / absent → defaults to ['email_marketing'].
//
// POST /api/unsubscribe/[token]
export async function POST(request, props) {
  const params = await props.params;
  const db = createServerClient()
  const { token } = params

  const ip = getClientIp(request)
  const userAgent = request.headers.get('user-agent') || null

  // Parse the body if any. Tolerate empty / non-JSON for the
  // List-Unsubscribe path which doesn't always send a content-type.
  let requested = null
  try {
    const text = await request.text()
    if (text) {
      const json = JSON.parse(text)
      if (Array.isArray(json?.channels)) requested = json.channels
    }
  } catch {
    // Ignore — fall through to the default below.
  }
  let channels = (requested && requested.length
    ? requested.filter(c => UNSUB_CHANNELS.includes(c))
    : ['email_marketing'])
  if (channels.length === 0) channels = ['email_marketing']

  // LOCCOMMS.4 — `?l=` scopes the opt-out to the location whose email this was.
  //
  // NO `l` = unsubscribe from EVERY location. That is deliberate and is exact
  // back-compat: emails already delivered carry the old location-less URL, and
  // someone clicking one expects to be removed. Removing them from everything
  // is the only direction that cannot generate a spam complaint.
  //
  // UNSUB-RL.1 — shape-checked, for the same reason `?c=` already is just
  // below. It is caller-supplied and reaches `.eq('location_id', …)` and a
  // location_id FK; a non-UUID raises on the cast, which on this route means a
  // 500 in place of somebody's opt-out. A garbage value now falls back to the
  // global (unscoped) opt-out, which is the direction that cannot leave
  // someone subscribed against their wishes.
  const requestUrl = new URL(request.url)
  const rawScopeLocationId = requestUrl.searchParams.get('l')
  const scopeLocationId = UUID_RE.test(rawScopeLocationId || '') ? rawScopeLocationId : null

  // COMMSFIX.C.4 — `?c=` names the campaign whose email carried this link.
  // Shape-checked, not looked up: a garbage value must be IGNORED, never
  // passed to increment_campaign_metric (whose UPDATE would simply match no
  // row, but a non-uuid would raise on the cast and fail the request — for a
  // metric, on the unsubscribe path, which must never fail).
  const rawCampaignId = requestUrl.searchParams.get('c')
  const campaignId = UUID_RE.test(rawCampaignId || '') ? rawCampaignId : null

  // UNSUB-RL.1 tier 0 — shape. `contact_preferences.unsubscribe_token` is a
  // UUID (mig 005), so anything that is not one cannot possibly resolve.
  // Rejecting on shape means the cheapest form of enumeration — spraying
  // arbitrary strings — costs us no database read at all, which is the load
  // protection the old per-IP limiter was really buying. It is still recorded
  // and still charged, so a sprayer burns their per-IP budget just as fast.
  if (!UUID_RE.test(token || '')) {
    await penaliseInvalidToken(db, 'unsubscribe', ip)
    await recordRefusedOptOut(db, {
      endpoint: 'unsubscribe',
      reason: REFUSAL_REASONS.INVALID_TOKEN,
      ip, token, campaignId, locationId: scopeLocationId, channels, userAgent,
    })
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
  }

  // UNSUB-RL.1 tier 1 — anti-enumeration, per IP, PEEKED not spent.
  //
  // NOTE ON THE ONE CASE THIS STILL REFUSES: a valid token arriving from an IP
  // that has *already* burned its invalid-token budget is refused before the
  // lookup. That is deliberate — dropping the pre-lookup gate entirely would
  // leave an unauthenticated caller able to drive unbounded service-role
  // queries. It cannot be reached by a mail provider, whose POSTs carry the
  // tokens WE minted and therefore never spend invalid budget; reaching it
  // requires an active enumerator on the very same egress IP. And unlike
  // before, when it does happen it is written to unsubscribe_refusals with the
  // token fingerprint, so the opt-out can be found and honoured by hand.
  //
  // Spending here is what broke one-click unsubscribe: it charged legitimate
  // holders for the crime of sharing Gmail's proxy with each other. The budget
  // is only charged below, once we know the token did not resolve. A caller
  // who has already exhausted it is refused before we run a single query,
  // which is exactly the DB-load protection the old limiter provided.
  const ipBudget = await guardBeforeTokenLookup(db, 'unsubscribe', ip)
  if (!ipBudget.allowed) {
    await recordRefusedOptOut(db, {
      endpoint: 'unsubscribe',
      reason: REFUSAL_REASONS.IP_ENUMERATION,
      ip, token, campaignId, locationId: scopeLocationId, channels, userAgent,
    })
    return rateLimitResponse(ipBudget)
  }

  // Find the contact preference by token
  const { data: pref, error } = await db
    .from('contact_preferences')
    .select('*, contacts(id, name, email, location_id, wa_phone)')
    .eq('unsubscribe_token', token)
    .single()

  if (error || !pref) {
    // Charge the per-IP budget: this caller is guessing. Twenty of these in a
    // window and the peek above starts refusing them outright.
    await penaliseInvalidToken(db, 'unsubscribe', ip)
    await recordRefusedOptOut(db, {
      endpoint: 'unsubscribe',
      reason: REFUSAL_REASONS.INVALID_TOKEN,
      ip, token, campaignId, locationId: scopeLocationId, channels, userAgent,
    })
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
  }

  // UNSUB-RL.1 tier 2 — per TOKEN, with no IP component at all, so a shared
  // provider proxy can never reach it. This is what caps the original
  // limiter's stated target: a misconfigured mail client looping on one
  // unsubscribe URL. It caps that client on that one token and leaves every
  // other recipient behind the same egress IP completely untouched.
  const tokenBudget = await guardResolvedToken(db, 'unsubscribe', token)
  if (!tokenBudget.allowed) {
    await recordRefusedOptOut(db, {
      endpoint: 'unsubscribe',
      reason: REFUSAL_REASONS.TOKEN_FLOOD,
      ip, token, campaignId, channels, userAgent,
      contactId: pref.contact_id,
      locationId: scopeLocationId,
    })
    return rateLimitResponse(tokenBudget)
  }

  // Build the patch + audit log entries together. Only flip channels
  // that are currently TRUE so the consent log doesn't record
  // duplicate opt-outs for already-opted-out contacts.
  const updates = { updated_at: new Date().toISOString() }
  const logEntries = []
  const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null

  // LOCCOMMS.4 — decide "is this channel currently ON?" against the row we are
  // about to write, NOT always the global one.
  //
  // Getting this wrong is silent and severe: someone opted out globally but
  // opted IN at one location (the exact shape of the leads recovered in
  // LEADCAP.1) has pref.email_marketing === false, so a scoped unsubscribe
  // would produce an EMPTY patch and their click would do nothing at all.
  let currentState = pref
  if (scopeLocationId) {
    const { data: locRow } = await db
      .from('contact_location_preferences')
      .select('email_marketing, sms_marketing, whatsapp_marketing')
      .eq('contact_id', pref.contact_id)
      .eq('location_id', scopeLocationId)
      .maybeSingle()
    // No row = they are not on that list, so there is nothing to leave.
    // Fall through with an all-false state; the response stays identical so
    // the URL is never an oracle for which lists someone is on.
    currentState = locRow || { email_marketing: false, sms_marketing: false, whatsapp_marketing: false }
  }

  for (const channel of channels) {
    if (currentState[channel] === true) {
      updates[channel] = false
      logEntries.push({
        contact_id: pref.contact_id,
        channel,
        action: CONSENT_ACTIONS.OPT_OUT,
        source: 'one_click_unsubscribe',
        ip_address: ipAddress,
      })
    }
  }

  // LOCCOMMS.4 — where the opt-out is written, and why it matters.
  //
  // A SCOPED unsubscribe must NOT touch contact_preferences. The mig 489 sync
  // trigger propagates any global channel going FALSE to ALL of that contact's
  // location rows — correct for a global opt-out, catastrophic here: leaving a
  // Hatch Street list would silently strip the person off Stillorgan's too,
  // which is the exact harm this PR exists to stop.
  //
  // So: scoped -> write only that location's row. Global -> write
  // contact_preferences and let the trigger fan the OFF out everywhere.
  const channelPatch = {}
  for (const ch of Object.keys(updates)) if (ch !== 'updated_at') channelPatch[ch] = updates[ch]
  const hasChanges = Object.keys(channelPatch).length > 0

  if (hasChanges) {
    // UNSUBAUTO.3 — THE ASYMMETRY BETWEEN THESE TWO WRITES IS DELIBERATE.
    // Do not tidy it into consistency; they carry different weight.
    //
    // THE PREFERENCE WRITE *IS* THE OPT-OUT. Both branches used to be awaited
    // with the error discarded, and the handler returned `{ success: true }`
    // unconditionally below — the repo's documented discarded-error defect
    // class (CLAUDE.md, `no-discarded-single-error`). That was survivable
    // while the page sat behind a confirm button. UNSUBAUTO.1 made the page
    // auto-submit and key its "You've been unsubscribed" screen off
    // `data.success`, so a failed write now renders that screen to somebody
    // who is still fully subscribed — the exact harm this branch exists to
    // remove. If this write fails, say so.
    let writeError = null
    if (scopeLocationId) {
      const { error: locWriteErr } = await db.from('contact_location_preferences')
        .update({ ...channelPatch, updated_at: updates.updated_at })
        .eq('contact_id', pref.contact_id)
        .eq('location_id', scopeLocationId)
      writeError = locWriteErr
    } else {
      const { error: globalWriteErr } = await db.from('contact_preferences').update(updates).eq('id', pref.id)
      writeError = globalWriteErr
    }
    if (writeError) {
      console.error('[unsubscribe] preference write failed — opt-out NOT recorded:', {
        contactId: pref.contact_id,
        locationId: scopeLocationId,
        channels: Object.keys(channelPatch),
        message: writeError.message,
      })
      return NextResponse.json(
        { success: false, error: 'Could not record your preference' },
        { status: 500 },
      )
    }

    // THE CONSENT_LOG INSERT IS THE AUDIT ROW, and by this line the person
    // genuinely IS unsubscribed — the write above landed. Failing the request
    // here would make a mail provider retry an opt-out that has ALREADY taken
    // effect, and an unbounded retry loop against a working opt-out is a worse
    // outcome than a missing audit row. So this one logs and continues, and
    // the request still returns success. That is why it does not mirror the
    // 500 above.
    if (logEntries.length) {
      const { error: logErr } = await db.from('consent_log').insert(
        logEntries.map((e) => ({ ...e, location_id: scopeLocationId })),
      )
      if (logErr) {
        console.error('[unsubscribe] consent_log insert failed (the opt-out itself IS recorded):', {
          contactId: pref.contact_id,
          locationId: scopeLocationId,
          message: logErr.message,
        })
      }
    }

    // DUPEUNSUB.1 — best-effort, after the person's own opt-out is durable.
    await propagateOptOut(db, {
      contactId: pref.contact_id,
      email: pref.contacts?.email,
      waPhone: pref.contacts?.wa_phone,
      channels: Object.keys(channelPatch),
      locationId: scopeLocationId,
    })

    // PMSUPP.1 — suppress the address at POSTMARK too, so the two systems
    // refuse independently. Same best-effort contract as propagateOptOut
    // directly above, and it sits here for the same reason: the opt-out is
    // already durable in our database by this line.
    //
    // WHY IT EXISTS. Postmark's own mail-client Unsubscribe button suppresses
    // at Postmark and webhooks us (SubscriptionChange) — 74 opt-outs. An
    // opt-out taken HERE told Postmark nothing, so for those our database was
    // the SINGLE gate. mig 544 is what a single gate failing looks like:
    // eleven contacts logged as opted out while the column the sender reads
    // said mailable, straight through the audience filter. Postmark would have
    // been the backstop; we had never built it.
    //
    // GLOBAL OPT-OUTS ONLY — `scopeLocationId` must be null. A Postmark
    // suppression is per (server, stream), NOT per location, so pushing one on
    // a scoped opt-out would silently stop mail from every OTHER location the
    // person is still opted in to. That is precisely the LOCCOMMS.4 harm the
    // write above bends over backwards to avoid, and it would be worse here:
    // invisible, because it lands outside our database entirely. The daily
    // reconciliation (consent-drift-check) reads the same rule.
    //
    // Gated on email_marketing having ACTUALLY flipped — channelPatch is built
    // only from channels that were true — so a repeat click or an SMS-only
    // opt-out sends nothing.
    if (!scopeLocationId && channelPatch.email_marketing === false && pref.contacts?.email) {
      try {
        const result = await suppressAtPostmark(pref.contacts.email)
        if (result?.failed?.length) {
          console.error('[unsubscribe] Postmark suppression failed (the opt-out itself IS recorded; consent-drift-check will retry):', {
            contactId: pref.contact_id,
            message: result.failed[0]?.message,
          })
        }
      } catch (err) {
        // The helper is best-effort by contract and should never throw — but a
        // Postmark problem must not reach the customer's opt-out even if it
        // one day does.
        console.error('[unsubscribe] Postmark suppression threw (the opt-out itself IS recorded):', err?.message || err)
      }
    }

    // COMMSFIX.C.4 — attribute the unsubscribe to the campaign that carried
    // the link. Gated on email_marketing having ACTUALLY flipped in this
    // request (channelPatch is built only from channels that were true), which
    // is the same replay guard the SubscriptionChange handler uses: a second
    // click, or an already-unsubscribed contact, produces an empty patch and
    // counts nothing. An SMS-only opt-out is not an email unsubscribe.
    // Best-effort — the counter must never fail someone's opt-out, and
    // supabase-js builders are thenables with no .catch.
    if (campaignId && channelPatch.email_marketing === false) {
      try {
        const { error: incErr } = await db.rpc('increment_campaign_metric', {
          p_campaign_id: campaignId,
          p_field: 'total_unsubscribed',
        })
        if (incErr) console.error('[unsubscribe] total_unsubscribed increment failed:', incErr.message)
      } catch (err) {
        console.error('[unsubscribe] total_unsubscribed increment threw:', err?.message || err)
      }
    }
  }

  // Stamp contacts.email_status only when email_marketing was actually
  // flipped — preserves the convention used by Postmark-aware filters
  // elsewhere. No equivalent contacts.* fields exist for whatsapp /
  // sms marketing; those are read off contact_preferences directly.
  // LOCCOMMS.4 — only stamp the GLOBAL email_status on a GLOBAL unsubscribe.
  // On a scoped opt-out it would be a lie: the person still receives mail from
  // their other locations, and this flag blocks manual staff sends everywhere.
  // Retiring the column entirely is PR 5, with the five readers that use it.
  // LOCCOMMS.5 — the global email_status stamp is GONE. The opt-out is recorded
  // in contact_location_preferences (globally, the mig 489 trigger fans it to
  // every location), and email_status now carries reputation only.
  //   PR 4 note retained: on a SCOPED opt-out this stamp was already skipped,
  //   because it would have blocked manual sends from every other location too.

  // UNSUB-RL.1 — a REPEAT opt-out is a success, not an error.
  //
  // Mail providers retry a one-click POST (network blips, and Gmail will
  // re-issue on a user's second tap), and people click the link in two
  // different emails. None of that is a failure: the requested end state —
  // "stop marketing to me on these channels" — already holds. Saying so
  // explicitly keeps the provider's retry from looking like a rejection,
  // which is what gets a sender's one-click support marked unreliable.
  //
  // This is also why the per-token budget can be generous: the common repeat
  // case costs one read and no writes.
  return NextResponse.json({
    success: true,
    message: 'Unsubscribed successfully',
    unsubscribed_channels: channels.filter(c => updates[c] === false),
    already_unsubscribed: !hasChanges,
  })
}

// GET redirects to preference centre. Use the request's own origin so the
// redirect always lands on the same domain the user typed — no env var
// dependency, no chance of redirecting to a stale domain.
export async function GET(request, props) {
  const params = await props.params;
  const { token } = params
  return NextResponse.redirect(`${getRequestOrigin(request)}/preferences/${token}`)
}
