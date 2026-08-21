// CAMPAIGN.13 — chunk-aware campaign sender.
//
// Replaces the all-in-one sendCampaign that loaded the full audience
// + sent everything in a single function invocation (timed out for
// large audiences, locked the operator's browser, and burst the
// Postmark webhook receiver). New shape:
//
//   1. Operator clicks "Send" or scheduled_at fires → campaign
//      moves to status='queued' (no work in the request thread).
//   2. /api/cron/run-campaigns picks queued campaigns up. First
//      invocation per campaign:
//        a. Load audience (paginated — CAMPAIGN.11 fix).
//        b. Pre-populate campaign_recipients (status='queued',
//           one row per intended recipient).
//        c. Set status='sending'.
//      Subsequent invocations:
//        d0. Reclaim lease-expired 'sending' rows (CAMPAIGN-REL.2).
//        d. SELECT first CHUNK_SIZE campaign_recipients WHERE
//           status='queued' for this campaign, CAS-claim them
//           queued→sending (claimed_at stamps the lease).
//        e. Send them via Postmark batch.
//        f. UPDATE each to 'sent' / 'bounced' (permanent rejection) /
//           back to 'queued' (transient error, attempts+1, capped at
//           MAX_SEND_ATTEMPTS then 'failed') + log sends to email_sends.
//        g. Check campaigns.cancel_requested_at — if set, halt and
//           transition status='cancelled'.
//        h. If no more queued for this campaign, status='sent',
//           call recalculate_campaign_stats.
//
// Throttle: each cron tick processes one CHUNK_SIZE (500) per
// campaign and at most MAX_CAMPAIGNS_PER_TICK campaigns. With a
// 1-minute cron, that gives ~500/min/campaign, well under
// Postmark's batch limits and well within the deferred-webhook
// queue's drain rate.
//
// CAMPAIGN-AB (mig 398) — subject-line A/B testing. When
// campaigns.ab_subject_b is set, the same tick function runs a
// column-driven sub-machine (resolveAbPhase, src/lib/campaign-ab.js):
//
//   populate  — recipients get a deterministic ab_variant
//               ('a'|'b' for the ab_test_pct% test slice, NULL for
//               the remainder) stamped at populate time, so the
//               assignment is stable across ticks.
//   slice     — chunk selection is restricted to ab_variant IS NOT
//               NULL; each row's subject comes from its variant
//               (A = campaigns.subject, B = ab_subject_b). When the
//               slice fully drains (nothing queued OR sending),
//               ab_test_started_at is CAS-stamped (…IS NULL guard).
//   waiting   — now < started + ab_wait_hours: the tick no-ops for
//               the remainder (it only touches updated_at so the
//               waiting campaign rotates to the back of the cron's
//               pick order instead of hogging a per-tick slot).
//   decide    — open rates per variant come from the
//               campaign_ab_variant_stats RPC (email_sends joined
//               via campaign_recipients.ab_variant), read by
//               decideAbOutcome. ABHONEST.1: an INCONCLUSIVE reading
//               (too few opens, a tie, or a difference under the 1.5x
//               bar) is a real third outcome, and it resolves to
//               sendWith 'a' so the remainder still goes out with
//               campaigns.subject rather than the campaign hanging on
//               a decision it can never make. ab_winner is CAS-stamped
//               (…IS NULL) so exactly one overlapping tick decides;
//               the decider falls through and starts the remainder.
//               NOTE ab_winner records what was SENT: mig 398's CHECK
//               allows only 'a'|'b'|NULL, so "inconclusive" is not
//               storable and is instead re-derived for display from
//               the same stat rows by CampaignDetail.
//   final     — the normal chunked path, each row's subject resolved
//               via subjectForVariant (remainder → winning subject;
//               retried slice rows keep their own variant).
//
// Campaigns without ab_subject_b never enter the sub-machine — the
// default path is unchanged. Cancel (cancel_requested_at) is checked
// before any phase work, so mid-test cancels behave exactly like
// mid-send cancels.

import { buildAudienceQueryAsync, applyMergeTags, buildUnsubscribeUrl, appendUnsubscribeFooter, sendBatch, consentFieldForStream, consentColumnFor, isTransientSendError, getDefaultMailboxAddress } from './postmark.js'
import { resolveEmailSender } from './tenant-email.js'
import { injectPreheader, htmlToPlainText } from './email-content.js'
import { resolveAbPhase, assignAbVariants, clampAbTestPct, decideAbOutcome, subjectForVariant, AB_FALLBACK_VARIANT } from './campaign-ab.js'
import { frequencyCapFromLocationSettings, capCutoffIso, stampMarketingTouch, CAMPAIGN_CAP_SKIP_AFTER_MS } from './frequency-cap.js'
import { loadNonOpenerContactIds } from './campaign-resend.js'
import { getAppUrl } from './app-url.js'
import { logInfo } from './log.js'
import { buildCampaignViewUrl, prependViewInBrowserLink, fetchLocationEmailCopy } from './campaign-web-view.js'
import { isFeatureEnabledAtLocation } from '@shared/permissions'
import { withSendMarker } from './postmark-send-marker.js'

const CHUNK_SIZE = 500             // recipients per cron tick per campaign
const AUDIENCE_PAGE_SIZE = 1000    // audience load page (CAMPAIGN.11)
const RECIPIENT_INSERT_CHUNK = 1000

// CAMPAIGN-REL.1 — bounded retry for transient provider errors.
// A recipient is attempted at most MAX_SEND_ATTEMPTS times; each
// transient failure (network blip, HTTP 429/5xx, Postmark rate
// limit/maintenance) returns it to 'queued' with attempts+1 until
// the cap, then it's marked 'failed'. Permanent rejections (invalid
// address, inactive recipient) never retry. Requires the
// campaign_recipients.attempts / claimed_at columns (mig 392).
export const MAX_SEND_ATTEMPTS = 3

// CAMPAIGN-REL.2 — how long a 'sending' claim is honoured before a
// later tick assumes the claiming invocation died mid-flight and
// reclaims the row. Mirrors the sequences scheduler's CLAIM_LEASE_MS
// (src/lib/sequences/scheduler.js): long enough to cover a tick's
// processing, short enough that a crashed tick's rows retry promptly.
export const SENDING_LEASE_MS = 10 * 60_000

/**
 * BAREWRITE.1 — every status/stamp write in this file used to be a BARE
 * `await db.from(…).update(…)`: supabase-js RESOLVES with `{ data, error }`
 * rather than throwing, so a failed write produced a resolved promise and the
 * tick carried on as though the transition had happened. The consequences here
 * are not cosmetic — a lost `campaign_recipients` status write re-queues a
 * recipient who already received the mail (a DUPLICATE marketing email), and a
 * lost `campaigns.updated_at` bump pins a waiting campaign at the FRONT of the
 * cron's ascending fair-pick order forever, burning one of the per-tick slots
 * on every tick while other queued campaigns starve.
 *
 * This is the one place that judgement lives: read the error, log it at error
 * level with the campaign it belongs to, and hand it back so callers that have
 * somewhere better to put it (campaigns.last_error, the returned tick result)
 * can. It deliberately does NOT throw — a bookkeeping failure must not abort a
 * tick that has already handed mail to Postmark.
 *
 * @param {PromiseLike<{ error: any }>} builder — an un-awaited supabase write
 * @param {string} what — human description for the log line
 * @param {string} campaignId
 * @returns {Promise<any|null>} the supabase error, or null
 */
async function writeOrLog(builder, what, campaignId) {
  const { error } = await builder
  if (error) console.error(`[campaign-sender] ${what} failed (campaign ${campaignId}): ${error.message}`)
  return error || null
}

/**
 * Process one cron tick of work for one campaign.
 *
 * @param {SupabaseClient} db — service-role client
 * @param {object} campaign — full campaigns row (joined with
 *   locations(name, slug, email_inbox_reply_to, settings) — settings feeds
 *   the FREQ-CAP.1 gate; a missing join degrades to cap-disabled)
 * @returns {Promise<{ phase: string, sent?: number, error?: string }>}
 */
export async function tickCampaignSend(db, campaign) {
  const campaignId = campaign.id

  // Marketing (broadcast) vs Utility (outbound). Drives the consent gate,
  // the Postmark stream, and whether an unsubscribe footer is appended.
  const stream = campaign.postmark_stream === 'outbound' ? 'outbound' : 'broadcast'
  const consentField = consentFieldForStream(stream)

  // FREQ-CAP.1 — cross-channel marketing frequency cap. Setting rides the
  // run-campaigns join (locations.settings); a missing join degrades to
  // disabled (fail open). Only MARKETING (broadcast-stream) campaigns are
  // gated OR stamped — utility/outbound campaigns are administrative mail
  // and must never consume a contact's marketing window.
  const capSetting = frequencyCapFromLocationSettings(campaign.locations?.settings)
  // CAMPAIGN-RESEND — a resend child (parent_campaign_id set) bypasses the
  // cap: the operator deliberately chose to re-contact exactly these people,
  // and the original send already stamped their window (which would
  // otherwise hold the entire resend until the cap cleared, then the 7-day
  // valve would skip everyone). Successful sends still stamp the touch below
  // so SUBSEQUENT campaigns count the resend.
  const capActive = stream === 'broadcast' && capSetting.enabled && !campaign.parent_campaign_id

  // Hard stop — cancel-while-sending.
  if (campaign.cancel_requested_at) {
    await writeOrLog(
      db.from('campaign_recipients')
        .update({ status: 'cancelled' })
        .eq('campaign_id', campaignId)
        .eq('status', 'queued'),
      'cancel queued recipients', campaignId)
    const cancelErr = await writeOrLog(
      db.from('campaigns')
        .update({ status: 'cancelled', sent_at: new Date().toISOString() })
        .eq('id', campaignId),
      'cancel campaign', campaignId)
    // A campaign that failed to record its own cancellation is still 'sending'
    // and WILL be picked again next tick — say so rather than reporting a
    // clean 'cancelled'.
    return cancelErr ? { phase: 'cancelled', error: cancelErr.message } : { phase: 'cancelled' }
  }

  // TENANT.8 (item 3b) — location bundle/feature gate. Closes TENANT.6's
  // accepted gap #2 for campaigns: a campaign configured before the
  // location's email/bundle_messaging/bundle_marketing was turned off
  // used to keep sending regardless — no gate anywhere in this file
  // consulted isFeatureEnabledAtLocation. campaign.locations.features
  // rides the same run-campaigns join FREQ-CAP.1's settings read already
  // depends on; a missing join defaults OPEN (isFeatureEnabledAtLocation's
  // own contract), matching every other call site's "don't block on
  // missing data" posture.
  //
  // Deliberately NOT an error result: this is a valid, intentional
  // location state, not a send failure, so it must never feed
  // campaignFailurePatch's repeated-error escalation (run-campaigns
  // route.js) into status='failed'. Mirrors the CAMPAIGN-AB 'ab_waiting'
  // phase below — touch updated_at so the campaign rotates to the BACK
  // of the cron's fair-pick order instead of pinning a per-tick slot,
  // and record the reason on last_error (operator-visible, but not an
  // error-count field) so the pause is visible without being a failure.
  if (!isFeatureEnabledAtLocation(campaign.locations, 'email')) {
    // The updated_at bump IS the rotation — if it is lost, this campaign stays
    // at the head of the ascending pick order and occupies a per-tick slot on
    // every tick until the next successful write. It was a bare await until
    // BAREWRITE.1.
    //
    // BAREWRITE.4 — it is reported as a `warning`, NOT an `error`, and that
    // distinction is load-bearing on THIS path specifically. The bundle gate
    // writes `last_error` on every single tick by design, so a bundle-disabled
    // campaign always enters the next tick with `last_error` already set. A
    // returned `error` reaches campaignFailurePatch, whose "genuinely stuck"
    // test is (last_error already present) && (no send_started_at) && (older
    // than the grace window) — and a bundle-disabled campaign satisfies the
    // last two permanently. So the branch's `error` turned ONE transient bump
    // failure into a campaign marked 'failed' forever, needing an operator to
    // resurrect it. That is a louder failure than the silent one it replaced,
    // which is exactly what this PR exists not to do.
    //
    // A warning is surfaced by the cron (logged at error level, counted in the
    // response) without feeding the kill switch. A lost rotation bump is a
    // fairness problem, never a reason to destroy a campaign.
    const bumpErr = await writeOrLog(
      db.from('campaigns')
        .update({
          updated_at: new Date().toISOString(),
          last_error: 'Skipped — email is disabled at this location (feature toggle or bundle off).',
        })
        .eq('id', campaignId),
      'bundle-disabled rotation bump', campaignId)
    return bumpErr
      ? { phase: 'bundle_disabled', sent: 0, warning: `rotation bump failed (campaign will pin a per-tick slot until a later write lands): ${bumpErr.message}` }
      : { phase: 'bundle_disabled', sent: 0 }
  }

  // Phase 1 — if the campaign has not finished populating, populate it.
  // This normally happens on the FIRST cron tick after the operator queues
  // the campaign. We don't send any emails this tick — populate is its own
  // time budget. Next tick picks up the first chunk.
  //
  // POPFIX.1 — the guard is send_started_at (mig 507), NOT a recipient row
  // count. Rows go in as RECIPIENT_INSERT_CHUNK batches below, so a chunk
  // that fails (transient DB error, Vercel timeout, deploy mid-tick) leaves
  // chunks 1..N-1 committed. Under the old `existingCount === 0` guard the
  // next tick saw those rows, skipped populate entirely, sent only the
  // partial set and finalised 'sent' with plausible-looking stats — the same
  // outcome as the 8 Aug 2026 truncation (CAMPAIGN.14), by the one path that
  // fix did not close. send_started_at is stamped ONLY after every chunk has
  // succeeded (below), so it answers the question actually being asked:
  // "did populate finish?".
  //
  // Self-healing, deliberately: a campaign whose chunks all landed but whose
  // stamp failed re-runs populate as a no-op upsert and re-stamps.
  if (campaign.send_started_at == null) {
    const contacts = []
    if (campaign.parent_campaign_id) {
      // CAMPAIGN-RESEND — the child's audience is the parent's non-openers,
      // re-intersected with contact_location_audience AT POPULATE TIME so
      // consent, suppression and bounces since the original send are
      // honoured. Query the VIEW itself, never inner-join around it
      // (LOCCOMMS invariant: a missing preference row must mean "never
      // send", which the view encodes). Resends are broadcast-only, so
      // the gate set is always the marketing one.
      let nonOpenerIds
      try {
        nonOpenerIds = await loadNonOpenerContactIds(db, campaign.parent_campaign_id)
      } catch (err) {
        return { phase: 'populate', error: err?.message || String(err) }
      }
      for (let i = 0; i < nonOpenerIds.length; i += AUDIENCE_PAGE_SIZE) {
        const chunk = nonOpenerIds.slice(i, i + AUDIENCE_PAGE_SIZE)
        const { data, error } = await db
          .from('contact_location_audience')
          .select('id')
          .eq('audience_location_id', campaign.location_id)
          .eq('loc_email_marketing', true)
          .not('email_status', 'in', '("bounced","complained")')
          .is('email_suppressed_at', null)
          .in('id', chunk)
        if (error) return { phase: 'populate', error: `resend audience load failed: ${error.message}` }
        contacts.push(...(data || []))
      }
    } else {
      // CAMPAIGN.14 — .range() pagination is only stable under an explicit
      // ORDER BY (CLAUDE.md: 1,000-row cap invariant). Without it the 8 Aug
      // 2026 sale send got overlapping pages: the duplicated contact blew up
      // the recipient insert on the (campaign_id, contact_id) unique key
      // after chunk 1, so exactly 1,000 of 3,053 matched contacts were
      // enrolled and the rest silently never received the campaign. The
      // Set is belt-and-braces for rows that shift pages mid-pagination.
      const seenContactIds = new Set()
      for (let from = 0; ; from += AUDIENCE_PAGE_SIZE) {
        const { query } = await buildAudienceQueryAsync(db, campaign.audience_filter, campaign.location_id, { consentField })
        const { data, error } = await query
          .order('id', { ascending: true })
          .range(from, from + AUDIENCE_PAGE_SIZE - 1)
        if (error) return { phase: 'populate', error: `audience load failed: ${error.message}` }
        if (!data || data.length === 0) break
        for (const contact of data) {
          if (seenContactIds.has(contact.id)) continue
          seenContactIds.add(contact.id)
          contacts.push(contact)
        }
        if (data.length < AUDIENCE_PAGE_SIZE) break
      }
    }

    if (contacts.length === 0) {
      // A `warning`, not an `error`, for the same reason as the rotation bumps
      // — and it is NOT the same as the finalise at the end of the send loop.
      // This one runs inside populate, where `send_started_at` is still null,
      // which is one of the three conditions campaignFailurePatch tests for
      // "genuinely stuck". `campaigns.last_error` is never cleared by the cron
      // (only /api/campaigns/[id]/send clears it), so any campaign carrying an
      // old error would be flipped to 'failed' by ONE transient blip here — and
      // 'failed' is terminal: the cron only picks 'queued'/'sending', so
      // nothing ever finishes it. `main` was silent and simply looped, and the
      // loop is RIGHT: the campaign stays 'sending', the next tick re-runs
      // populate, finds the same empty audience and finalises the moment the
      // write lands. Keep the self-healing, add the visibility, drop the kill.
      const emptyErr = await writeOrLog(
        db.from('campaigns').update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          total_recipients: 0,
        }).eq('id', campaignId),
        'finalise empty-audience campaign', campaignId)
      return emptyErr
        ? { phase: 'populate', sent: 0, warning: `could not finalise an empty-audience campaign (it stays open and the next tick retries): ${emptyErr.message}` }
        : { phase: 'populate', sent: 0 }
    }

    // CAMPAIGN-AB — assign the test slice at populate time so it's
    // stable across ticks. Deterministic (hash-ordered) inside
    // assignAbVariants; the DB row is the source of truth afterwards.
    // The ab_variant key is only written for A/B campaigns so the
    // default path's insert payload is byte-identical to today.
    const abEnabled = !!campaign.ab_subject_b
    const variantById = abEnabled
      ? assignAbVariants(contacts.map(c => c.id), clampAbTestPct(campaign.ab_test_pct))
      : null

    // Bulk insert recipients in chunks.
    const recipientRows = contacts.map(c => {
      const row = {
        campaign_id: campaignId,
        contact_id: c.id,
        status: 'queued',
      }
      if (abEnabled) row.ab_variant = variantById.get(c.id) || null
      return row
    })
    // POPFIX.1 — idempotent write, so a resumed populate FINISHES the job
    // instead of aborting on the (campaign_id, contact_id) unique key
    // (campaign_recipients_campaign_id_contact_id_key). ignoreDuplicates
    // leaves an already-inserted row completely untouched: its status
    // ('sent'!), ab_variant, attempts and timestamps are never reset, so a
    // re-run can never re-send anyone. Only missing rows are added.
    for (let i = 0; i < recipientRows.length; i += RECIPIENT_INSERT_CHUNK) {
      const chunk = recipientRows.slice(i, i + RECIPIENT_INSERT_CHUNK)
      const { error } = await db.from('campaign_recipients')
        .upsert(chunk, { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true })
      if (error) return { phase: 'populate', error: `recipient insert failed: ${error.message}` }
    }

    const populateUpdate = {
      status: 'sending',
      total_recipients: contacts.length,
      send_started_at: new Date().toISOString(),
    }
    // CAMPAIGN-AB — an audience too small to test (assignAbVariants
    // returned no slice) short-circuits straight to winner A so the
    // campaign doesn't sit through a pointless wait window.
    if (abEnabled && variantById.size === 0) {
      const nowIso = new Date().toISOString()
      populateUpdate.ab_winner = 'a'
      populateUpdate.ab_test_started_at = nowIso
      populateUpdate.ab_decided_at = nowIso
    }
    // CAMPAIGN.14 — surface the status update's error. This update failed
    // silently on every campaign while campaigns.send_started_at didn't
    // exist in prod (added in mig 507): the campaign still limped to 'sent'
    // via finalise + recalculate_campaign_stats, which masked populate
    // problems like the truncation above.
    const { error: populateUpdateError } = await db.from('campaigns').update(populateUpdate).eq('id', campaignId)
    if (populateUpdateError) {
      return { phase: 'populate', error: `populate status update failed: ${populateUpdateError.message}` }
    }

    return { phase: 'populate', sent: 0 }
  }

  // CAMPAIGN-REL.2 — reclaim stuck 'sending' rows BEFORE reading the
  // queue. If a cron invocation dies between the CAS claim (queued→
  // sending below) and result application, its rows stay 'sending'
  // forever — and finalisation (which only checks remaining 'queued')
  // would close the campaign as 'sent' around them. Rows whose lease
  // (claimed_at) expired — or that predate leasing entirely
  // (claimed_at IS NULL) — go back to 'queued' for another attempt,
  // or to 'failed' once the attempt cap is spent. NOTE: a crashed
  // tick MAY have handed the batch to Postmark before dying, so a
  // reclaimed retry can double-send — that's the accepted trade
  // (bounded by MAX_SEND_ATTEMPTS) versus silently never delivering.
  await reclaimStuckSending(db, campaignId)

  // CAMPAIGN-AB — derive the A/B phase from the campaign row (pure,
  // so overlapping cron ticks agree; the transitions below are CAS'd).
  const abPhase = resolveAbPhase(campaign)
  // Set by the tick that wins the decide CAS — its local campaign row
  // predates the ab_winner stamp, so subject resolution needs the
  // freshly decided winner explicitly.
  let abWinnerOverride = null

  if (abPhase === 'waiting') {
    // Inside the wait window: the remainder must not send yet. Touch
    // updated_at so this campaign rotates to the BACK of the cron's
    // pick order (run-campaigns orders by updated_at ascending and
    // ticks at most MAX_CAMPAIGNS_PER_TICK campaigns) — otherwise an
    // hours-long wait would pin one of the per-tick slots and starve
    // other queued campaigns.
    // Same as the bundle-gate bump above, and a `warning` for the same reason:
    // it must reach the cron, but a lost rotation bump is never grounds for
    // marking a campaign 'failed'.
    const bumpErr = await writeOrLog(
      db.from('campaigns')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', campaignId),
      'ab_waiting rotation bump', campaignId)
    return bumpErr
      ? { phase: 'ab_waiting', sent: 0, warning: `rotation bump failed (campaign will pin a per-tick slot until a later write lands): ${bumpErr.message}` }
      : { phase: 'ab_waiting', sent: 0 }
  }

  if (abPhase === 'decide') {
    // Open rate per variant from email_sends (same source of truth as
    // recalculate_campaign_stats), joined via campaign_recipients.ab_variant
    // inside the campaign_ab_variant_stats RPC (mig 398).
    const { data: statRows, error: statsErr } = await db
      .rpc('campaign_ab_variant_stats', { p_campaign_id: campaignId })
    if (statsErr) return { phase: 'ab_decide', error: `variant stats failed: ${statsErr.message}` }

    const reading = decideAbOutcome(statRows || [])
    // ABHONEST.1 — sendWith is ALWAYS 'a' or 'b', including when the reading is
    // inconclusive (it falls back to AB_FALLBACK_VARIANT). That is what keeps a
    // campaign that learned nothing from stalling before its remainder: the
    // stamp is what unblocks the 'final' phase.
    const winner = reading.sendWith || AB_FALLBACK_VARIANT
    if (reading.outcome === 'inconclusive') {
      logInfo('campaign-sender', 'A/B test inconclusive; remainder sends with subject A', {
        campaignId, reason: reading.reason,
      })
    }
    // CAS on ab_winner IS NULL — exactly one overlapping tick decides.
    // The error is bound (BAREWRITE.1 follow-up): without it a failed CAS
    // returns data:null, which is byte-identical to "a concurrent tick won" —
    // so a persistent DB failure would look like a permanent race and the
    // campaign would sit in 'decide' forever with nothing recorded anywhere.
    const { data: won, error: casError } = await db.from('campaigns')
      .update({ ab_winner: winner, ab_decided_at: new Date().toISOString() })
      .eq('id', campaignId)
      .is('ab_winner', null)
      .select('id')
    if (casError) return { phase: 'ab_decide', sent: 0, error: `ab_winner CAS failed: ${casError.message}` }
    if (!won || won.length === 0) {
      // A concurrent tick decided first; the next tick sends with its winner.
      return { phase: 'ab_decide', sent: 0 }
    }
    abWinnerOverride = winner
    // Fall through — the deciding tick starts the remainder immediately.
  }

  // Phase 2 — process one CHUNK_SIZE batch of queued recipients.
  // Join contacts inline so we have email + name + preferences for
  // the merge tags + unsubscribe URL without a second round-trip.
  // During the A/B slice phase only test-slice rows (ab_variant set)
  // are eligible; the remainder stays queued but unclaimable.
  let queuedQuery = db
    .from('campaign_recipients')
    .select(`
      id,
      contact_id,
      attempts,
      ab_variant,
      contact:contacts!inner(
        id, email, first_name, last_name, name, phone, pipeline_stage_slug,
        email_status, glofox_passcode,
        last_marketing_touch_at,
        contact_preferences(unsubscribe_token)
      )
    `)
    .eq('campaign_id', campaignId)
    .eq('status', 'queued')
  if (abPhase === 'slice') {
    queuedQuery = queuedQuery.not('ab_variant', 'is', null)
  }
  // FREQ-CAP.1 — when the cap is on, contacts inside their marketing window
  // are NOT selectable this tick: the embedded-contact filter (contacts is
  // !inner-joined, so it drops the parent row) leaves their recipient rows
  // 'queued' and untouched — no attempts bump, no terminal status — and a
  // later tick sends them once the window clears. Filtering in the query
  // (not post-fetch) also stops a fully-capped front-of-queue chunk from
  // starving uncapped rows behind it (selection is ordered by id).
  // Runs AFTER the consent gate in spirit: consent was applied at populate
  // time and is re-checked post-claim below; a contact who is both capped
  // and since-unsubscribed just stays queued until the window clears, then
  // gets cancelled by the consent re-check — never sent, never stamped.
  if (capActive) {
    queuedQuery = queuedQuery.or(
      `last_marketing_touch_at.is.null,last_marketing_touch_at.lt.${capCutoffIso(capSetting)}`,
      { referencedTable: 'contact' },
    )
  }
  const { data: candidateRows, error: queuedErr } = await queuedQuery
    .order('id', { ascending: true })
    .limit(CHUNK_SIZE)

  if (queuedErr) return { phase: 'send', error: `queued fetch failed: ${queuedErr.message}` }

  if (!candidateRows || candidateRows.length === 0) {
    // FREQ-CAP.1 — with the cap filter on, an empty fetch can mean "every
    // remaining queued row is cap-deferred", NOT "done". Count the queue
    // without the cap filter before finalising (or before starting the A/B
    // wait clock — a capped slice row hasn't been sent its variant yet).
    if (capActive) {
      let remainingQuery = db
        .from('campaign_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .eq('status', 'queued')
      if (abPhase === 'slice') remainingQuery = remainingQuery.not('ab_variant', 'is', null)
      const { count: capHeld } = await remainingQuery
      if ((capHeld || 0) > 0) {
        // Safety valve: a contact re-touched by other channels every day
        // could hold this campaign at 'sending' forever. Rows still cap-
        // deferred CAMPAIGN_CAP_SKIP_AFTER_MS (7 days) after the send
        // started are skipped terminally ('skipped_frequency_cap' — free
        // TEXT status; stats come from email_sends so counters stay true),
        // and the next tick finalises normally.
        const startedMs = campaign.send_started_at ? new Date(campaign.send_started_at).getTime() : null
        if (startedMs && Date.now() - startedMs > CAMPAIGN_CAP_SKIP_AFTER_MS) {
          let skipQuery = db
            .from('campaign_recipients')
            .update({ status: 'skipped_frequency_cap' })
            .eq('campaign_id', campaignId)
            .eq('status', 'queued')
          if (abPhase === 'slice') skipQuery = skipQuery.not('ab_variant', 'is', null)
          await writeOrLog(skipQuery, 'cap-skip queued recipients', campaignId)
          return { phase: 'cap_skipped', skipped: capHeld, sent: 0 }
        }
        // Leave the campaign 'sending' (acceptable — the window is hours)
        // and rotate it to the back of the cron's pick order, mirroring
        // ab_waiting, so an hours-long cap hold can't pin a per-tick slot.
        const bumpErr = await writeOrLog(
          db.from('campaigns')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', campaignId),
          'cap_deferred rotation bump', campaignId)
        return bumpErr
          ? { phase: 'cap_deferred', deferred: capHeld, sent: 0, warning: `rotation bump failed (campaign will pin a per-tick slot until a later write lands): ${bumpErr.message}` }
          : { phase: 'cap_deferred', deferred: capHeld, sent: 0 }
      }
    }

    if (abPhase === 'slice') {
      // Slice drained — but only start the wait clock once nothing is
      // still in flight ('sending' within its lease). Reclaim above
      // already returned lease-expired rows to the queue.
      const { count: inflight } = await db
        .from('campaign_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .eq('status', 'sending')
        .not('ab_variant', 'is', null)
      if ((inflight || 0) > 0) return { phase: 'ab_slice', sent: 0 }

      // CAS on ab_test_started_at IS NULL — one tick starts the clock.
      // No row-count check: the `.is(…, null)` CAS means "zero rows updated"
      // is the ordinary losing-tick outcome, not a failure.
      await writeOrLog(
        db.from('campaigns')
          .update({ ab_test_started_at: new Date().toISOString() })
          .eq('id', campaignId)
          .is('ab_test_started_at', null),
        'ab_test_started CAS', campaignId)
      return { phase: 'ab_test_started', sent: 0 }
    }

    // Done — no more queued. Finalize.
    const finaliseErr = await writeOrLog(
      db.from('campaigns').update({
        status: 'sent',
        sent_at: campaign.sent_at || new Date().toISOString(),
      }).eq('id', campaignId),
      'finalise campaign', campaignId)

    await db.rpc('recalculate_campaign_stats', { p_campaign_id: campaignId })
      .then(({ error }) => { if (error) console.error('[campaign-sender] recalc failed:', error.message) })

    return finaliseErr ? { phase: 'finalise', sent: 0, error: finaliseErr.message } : { phase: 'finalise', sent: 0 }
  }

  // Double-send guard (HIGH) — Vercel cron does NOT skip an overlapping
  // invocation, so two ticks can SELECT the same queued chunk and both
  // call sendBatch. Atomically claim the chunk: flip queued→sending and
  // keep only the rows THIS tick won. A concurrent tick re-evaluates
  // status='queued' after our row lock releases, matches 0 of these ids,
  // and claims a different chunk — so no recipient is ever sent twice.
  const candidateIds = candidateRows.map(r => r.id)
  const { data: claimedRows, error: claimError } = await db
    .from('campaign_recipients')
    // claimed_at starts the CAMPAIGN-REL.2 lease clock — see
    // reclaimStuckSending above.
    .update({ status: 'sending', claimed_at: new Date().toISOString() })
    .in('id', candidateIds)
    .eq('status', 'queued')
    .select('id')
  // Same reason as the ab_winner CAS above: a failed claim and a lost race
  // both arrive as an empty list, so without the error a broken claim reads
  // as "another tick has it" every tick and the campaign never sends.
  if (claimError) return { phase: 'send', sent: 0, bounced: 0, error: `recipient claim failed: ${claimError.message}` }
  const claimedIds = new Set((claimedRows || []).map(r => r.id))
  const claimed = candidateRows.filter(r => claimedIds.has(r.id))
  if (claimed.length === 0) {
    // Another concurrent tick claimed this whole chunk — nothing to do.
    return { phase: 'send', sent: 0, bounced: 0 }
  }

  // Consent re-check (HIGH) — the audience was filtered at POPULATE time,
  // possibly many ticks (minutes — or, under an A/B wait / frequency-cap
  // deferral, hours to days) ago. A contact who has since unsubscribed or
  // hard-bounced must NOT be emailed.
  //
  // COMMSFIX.A.1 — re-apply the populate-time gate against the PER-LOCATION
  // view (contact_location_audience), not the embedded contacts columns:
  // those are GLOBAL (mig 155), and since LOCCOMMS.4 every unsubscribe link
  // is ?l=-scoped and writes ONLY contact_location_preferences — which never
  // flips the global column — so a location-scoped opt-out between populate
  // and send was invisible here (and the inverse skew wrongly cancelled
  // per-location-consented recipients whose global flag was false). The
  // view read also re-applies email_suppressed_at (marketing only, matching
  // buildAudienceQueryAsync) for free. One extra indexed read per chunk;
  // chunk ≤ CHUNK_SIZE (500), so a single .in() stays under the 1k cap.
  let viewQuery = db
    .from('contact_location_audience')
    .select('id')
    .eq('audience_location_id', campaign.location_id)
    .eq(consentColumnFor(consentField), true)
    .in('id', claimed.map(r => r.contact_id))
  if (consentField === 'email_marketing') {
    viewQuery = viewQuery.is('email_suppressed_at', null)
  }
  const { data: stillEligible, error: viewErr } = await viewQuery
  if (viewErr) {
    // Fail the tick for this chunk rather than sending unverified. Release
    // the claim (no attempts bump — nothing reached Postmark) so a later
    // tick retries; if this release itself fails, reclaimStuckSending
    // sweeps the rows back after SENDING_LEASE_MS anyway.
    await writeOrLog(
      db.from('campaign_recipients')
        .update({ status: 'queued', claimed_at: null })
        .in('id', claimed.map(r => r.id))
        .eq('status', 'sending'),
      'release claim after consent re-check failure', campaignId)
    return { phase: 'send', error: `consent re-check failed: ${viewErr.message}` }
  }
  const eligibleIds = new Set((stillEligible || []).map(r => r.id))
  // Membership in the view read = consent still granted; keep the
  // bounced/complained reputation re-check from the embedded contact.
  const consentOk = (c) =>
    eligibleIds.has(c.id) && !['bounced', 'complained'].includes(c.email_status)
  const suppressed = claimed.filter(r => !consentOk(r.contact))
  // `let` — the UNSUBTOKEN.2 gate below narrows this again.
  let queuedRows = claimed.filter(r => consentOk(r.contact))
  if (suppressed.length > 0) {
    // Park them out of the queue without sending. Engagement counters are
    // sourced from email_sends (recalculate_campaign_stats), so a 'cancelled'
    // recipient row simply never counts as sent — no stat corruption.
    // A lost cancel leaves these rows 'sending'; reclaimStuckSending returns
    // them to 'queued' after the lease and the next tick would re-evaluate
    // consent — correct, but only because that sweeper exists. Log it.
    await writeOrLog(
      db.from('campaign_recipients')
        .update({ status: 'cancelled' })
        .in('id', suppressed.map(r => r.id)),
      'cancel consent-suppressed recipients', campaignId)
  }
  // UNSUBTOKEN.2 — a MARKETING email with no working unsubscribe link never
  // leaves the building. buildUnsubscribeUrl returns null when the contact has
  // no contact_preferences.unsubscribe_token; it used to fall back to
  // contact.id, which /api/unsubscribe/[token] cannot resolve (token column
  // only), so both the footer link and the RFC 8058 List-Unsubscribe header
  // 404'd — silently, on the one recipient least able to complain about it.
  //
  // Refusing beats the alternative of just omitting the URL. That path exists
  // and is well-handled (the utility/outbound stream takes it: no footer,
  // empty {{unsubscribe_url}}, no List-Unsubscribe header), but on a broadcast
  // it would mean shipping marketing mail with NO opt-out mechanism at all —
  // trading a dead link for a missing one, both non-compliant, both invisible.
  //
  // 'failed' + last_error, not the 'cancelled' used above: 'cancelled' is the
  // ordinary consent-suppression outcome an operator is meant to ignore, while
  // this is a data fault that needs fixing. 'failed' is terminal (the candidate
  // query only picks up 'queued'), so this never retries in a loop, and
  // campaigns.last_error surfaces it in the campaign UI rather than only in a
  // log nobody reads. Per-recipient, so one bad row cannot fail the chunk.
  //
  // Mig 532 gave every contact a preferences row, so nothing hits this today.
  let unsendable = []
  if (stream === 'broadcast') {
    const hasToken = (c) => {
      const p = c?.contact_preferences?.[0] || c?.contact_preferences
      return Boolean(p?.unsubscribe_token)
    }
    unsendable = queuedRows.filter(r => !hasToken(r.contact))
    queuedRows = queuedRows.filter(r => hasToken(r.contact))
    if (unsendable.length > 0) {
      const msg = `${unsendable.length} recipient(s) have no contact_preferences.unsubscribe_token — refused rather than send marketing email with a dead unsubscribe link. Contacts: ${unsendable.map(r => r.contact_id).join(', ')}`
      console.error('[campaign-sender]', msg)
      await writeOrLog(
        db.from('campaign_recipients')
          .update({ status: 'failed', last_error: 'no unsubscribe token — refused (a marketing email needs a working opt-out link)' })
          .in('id', unsendable.map(r => r.id)),
        'fail recipients with no unsubscribe token', campaignId)
      await writeOrLog(db.from('campaigns').update({ last_error: msg }).eq('id', campaignId), 'record unsubscribe-token error', campaignId)
    }
  }

  if (queuedRows.length === 0) {
    return { phase: 'send', sent: 0, bounced: 0, suppressed: suppressed.length, unsendable: unsendable.length }
  }

  // Build email batch for this chunk.
  const baseUrl = getAppUrl()

  // EMAIL-MAILBOX-ADMIN.1 — where replies to this campaign go. Resolved ONCE
  // per chunk, not per recipient. A per-campaign reply_to still wins; below
  // it the studio's DEFAULT email account (email_mailboxes, mig 485), and
  // below that the deprecated locations.email_inbox_reply_to the embed still
  // carries for studios configured before the accounts model. Without the
  // mailbox lookup this path would keep reading a column no operator can edit
  // any more — the Reply-To would silently freeze at whatever it held when
  // the accounts editor shipped.
  const locationReplyTo = campaign.reply_to
    ? null
    : (await getDefaultMailboxAddress(db, campaign.location_id))
      || campaign.locations?.email_inbox_reply_to
      || null
  // WEBVIEW.1 — one hosted-copy URL for the whole send. Signed HMAC over the
  // campaign id only; no DB round-trip, no column, no per-recipient variation.
  const campaignViewUrl = buildCampaignViewUrl(campaignId, baseUrl)
  // K7 — the "view in browser" label is operator-editable per location
  // (company_settings, mig 530). Resolved ONCE per chunk like the Reply-To
  // above, not per recipient: it is a property of the studio, not the person.
  // Falls back to the code-side default on a missing row or a failed read, so
  // a settings hiccup can never fail a send.
  const emailCopy = await fetchLocationEmailCopy(db, campaign.location_id)

  const emailBatch = queuedRows.map(row => {
    const contact = row.contact
    // Utility (outbound) emails carry no marketing chrome — no unsubscribe
    // footer, no List-Unsubscribe header, empty {{unsubscribe_url}} merge tag.
    // COMMSFIX.C.4 — the campaign id rides along so /api/unsubscribe/[token]
    // can attribute the opt-out to this campaign (footer link AND the
    // List-Unsubscribe header both resolve there).
    const unsubscribeUrl = stream === 'broadcast' ? buildUnsubscribeUrl(contact, baseUrl, campaign.location_id, campaignId) : null
    // UNSUBTOKEN.2 — /api/preferences/[token] resolves the same
    // contact_preferences.unsubscribe_token column the unsubscribe API does, so
    // `|| contact.id` minted a second dead link here for exactly the same
    // reason. No token → no preference URL, and {{preference_url}} merges to ''
    // (applyMergeTags' own fallback). Broadcast recipients never reach this
    // line without a token — the gate above refused them — so in practice this
    // only ever goes empty on the utility stream, which carries no such chrome.
    const prefs = contact.contact_preferences?.[0] || contact.contact_preferences
    const preferenceUrl = prefs?.unsubscribe_token
      ? `${baseUrl}/preferences/${prefs.unsubscribe_token}`
      : null

    const merged = applyMergeTags(campaign.html_content, contact, {
      location_name: campaign.locations?.name || '',
      unsubscribe_url: unsubscribeUrl,
      preference_url: preferenceUrl,
    })
    const personalizedHtml = unsubscribeUrl ? appendUnsubscribeFooter(merged, unsubscribeUrl) : merged

    // CAMPAIGN-REL.4 — derive the plain-text alternative from the
    // rendered content BEFORE the preheader goes in (the preheader is
    // inbox chrome, not content — it shouldn't lead the text part).
    const textBody = htmlToPlainText(personalizedHtml)

    // CAMPAIGN-REL.3 — campaigns.preview_text was collected/stored by
    // the editor but never used at send time. Inject it as a standard
    // hidden preheader, first thing inside the body, merge tags applied.
    const previewText = campaign.preview_text
      ? applyMergeTags(campaign.preview_text, contact, { location_name: campaign.locations?.name || '' })
      : null
    // WEBVIEW.1 — "view in browser", inserted AFTER the plain-text part is
    // derived (the text alternative is never clipped, so it does not need the
    // link) and BEFORE the preheader, so the hidden preheader still leads the
    // body for inbox preview.
    //
    // Broadcast only, like the unsubscribe footer: a utility/transactional
    // email is small enough that Gmail never clips it, and hosting a public
    // copy of one would be a step backwards.
    //
    // The URL is per-CAMPAIGN, not per-recipient — identical for everyone on
    // this send. That is the whole PII design (see campaign-web-view.js): a
    // view-in-browser link is the most-forwarded link in any email, so it must
    // not resolve to anybody's personal data.
    const htmlWithWebView = stream === 'broadcast'
      ? prependViewInBrowserLink(personalizedHtml, campaignViewUrl, emailCopy)
      : personalizedHtml

    const finalHtml = previewText ? injectPreheader(htmlWithWebView, previewText) : htmlWithWebView

    // CAMPAIGN-AB — per-recipient subject: variant A/B in the test
    // slice, the winning subject for the remainder. Non-A/B campaigns
    // always resolve to campaign.subject (identical to before).
    const rawSubject = subjectForVariant(campaign, row.ab_variant, abWinnerOverride)

    return {
      to: contact.email,
      // COMMSFIX.D.4b — the subject gets the SAME extras as the body. It was
      // merged with no extras at all, so {{location_name}}, {{unsubscribe_url}}
      // and {{preference_url}} — all three advertised by the editor's merge-tag
      // panel as usable "in your subject line or email body" — resolved to
      // applyMergeTags' '' fallbacks. 'News from {{location_name}}' shipped as
      // 'News from ' while the identical tag in the body rendered correctly.
      subject: applyMergeTags(rawSubject, contact, {
        location_name: campaign.locations?.name || '',
        unsubscribe_url: unsubscribeUrl,
        preference_url: preferenceUrl,
      }),
      htmlBody: finalHtml,
      textBody,
      from: campaign.from_name
        ? `${campaign.from_name} <${campaign.from_email || process.env.POSTMARK_FROM_EMAIL}>`
        : undefined,
      // EMAIL-INBOX.1 / EMAIL-MAILBOX-ADMIN.1 — a per-campaign reply_to wins;
      // otherwise the studio's default account, resolved once above.
      replyTo: campaign.reply_to || locationReplyTo || undefined,
      stream,
      tag: `campaign-${campaignId}`,
      // POSTMARK-RACE.1 — `crm_send` promises the webhook processor that an
      // email_sends row is coming for this message, so a Delivery that beats
      // the insert below is retried instead of discarded. Safe to promise
      // unconditionally here: every result carrying a MessageID gets a
      // sendRecords entry a few lines down, and if that insert genuinely fails
      // the retry budget converts the promise into a dead-letter row — which
      // is the artefact this path has never had.
      metadata: withSendMarker({
        campaign_id: campaignId,
        contact_id: contact.id,
      }),
      unsubscribeUrl,
      _recipientId: row.id,
      _contactId: contact.id,
      _attempts: row.attempts || 0,
      _rawSubject: rawSubject,
    }
  })

  // INTEG-B3 — resolve the org's tenant sending config ONCE for the whole
  // chunk. With no live tenant email domain (every org today) this is the
  // global default: sendBatch sends byte-identically and loggedFromEmail
  // keeps the campaign's own from_email. With a live tenant, the batch
  // rides that org's Postmark server + verified From, logged honestly.
  const tenantSender = await resolveEmailSender(db, campaign.location_id)
  const loggedFromEmail = tenantSender.serverToken
    ? tenantSender.fromEmail
    : (campaign.from_email || process.env.POSTMARK_FROM_EMAIL)

  const results = await sendBatch(emailBatch, { sender: tenantSender })

  // COMMSFIX.C.1 — WRITE email_sends FIRST. This ordering is the whole fix.
  //
  // Postmark's Delivery webhook lands within a second or two of this batch
  // response. The per-recipient UPDATE loop below is sequential over the whole
  // chunk (up to CHUNK_SIZE rows), so when the insert sat AFTER it the early
  // webhooks arrived to find no email_sends row, silently no-opped, and
  // recalculate_campaign_stats then baked the loss in permanently (live:
  // campaign f66d6576 reported delivered 48/1000 against ~950 real
  // deliveries). Building the rows and inserting them as the first write after
  // sendBatch closes that window to roughly nothing.
  //
  // The insert's error was also discarded entirely — a failed insert produced
  // a campaign whose every engagement counter read zero with no trace anywhere.
  // One retry (the realistic failure is a transient deadlock/timeout), then a
  // loud console.error plus campaigns.last_error so it surfaces in the UI.
  let sentCount = 0
  let bouncedCount = 0
  let retriedCount = 0
  let failedCount = 0
  const sendRecords = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const item = emailBatch[i]
    if (result.ErrorCode === 0 || result.MessageID) {
      sendRecords.push({
        contact_id: item._contactId,
        location_id: campaign.location_id,
        source_type: 'campaign',
        campaign_id: campaignId,
        // CAMPAIGN-AB — log the subject this recipient actually got
        // (variant B / winning subject), not blindly campaign.subject.
        subject: item._rawSubject,
        from_email: loggedFromEmail,
        to_email: item.to,
        postmark_message_id: result.MessageID,
        postmark_stream: stream,
        status: 'sent',
      })
    }
  }

  if (sendRecords.length > 0) {
    let insertErr = (await db.from('email_sends').insert(sendRecords))?.error || null
    if (insertErr) {
      console.error('[campaign-sender] email_sends insert failed, retrying once:', insertErr.message)
      insertErr = (await db.from('email_sends').insert(sendRecords))?.error || null
    }
    if (insertErr) {
      const msg = `email_sends insert failed for ${sendRecords.length} recipients — delivery/open webhooks for this chunk will find no row: ${insertErr.message}`
      console.error('[campaign-sender]', msg)
      await writeOrLog(db.from('campaigns').update({ last_error: msg }).eq('id', campaignId), 'record email_sends insert error', campaignId)
    }
    // FREQ-CAP.1 — batch marketing-touch stamp for this chunk's successful
    // sends. Marketing stream only (utility campaigns never stamp); stamped
    // even while the cap is DISABLED so enabling it later has history.
    // Best-effort inside the helper — a stamp failure never fails the tick.
    // Runs whatever the insert did: Postmark accepted the mail, so the contact
    // WAS touched, and the frequency cap must know that either way.
    if (stream === 'broadcast') {
      await stampMarketingTouch(db, sendRecords.map(r => r.contact_id))
    }
  }

  // Apply the per-recipient results.
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const item = emailBatch[i]

    if (result.ErrorCode === 0 || result.MessageID) {
      sentCount++
      // The most consequential write in the file: this row is what stops the
      // next tick re-sending. A lost 'sent' leaves the recipient 'sending'
      // until the lease expires, at which point reclaimStuckSending re-queues
      // them and they receive the SAME marketing email a second time.
      await writeOrLog(
        db.from('campaign_recipients')
          .update({
            status: 'sent',
            postmark_message_id: result.MessageID,
            sent_at: new Date().toISOString(),
          })
          .eq('id', item._recipientId),
        `stamp recipient ${item._recipientId} sent`, campaignId)
    } else if (isTransientSendError(result)) {
      // CAMPAIGN-REL.1 — transient (network/-1, HTTP 429/5xx, Postmark
      // rate-limit/maintenance): retry on a later tick, bounded by
      // MAX_SEND_ATTEMPTS. Previously ANY non-zero ErrorCode marked
      // the recipient bounced — one Postmark blip mis-recorded a whole
      // 500-chunk as permanently bounced.
      const attempts = (item._attempts || 0) + 1
      if (attempts < MAX_SEND_ATTEMPTS) {
        retriedCount++
        await writeOrLog(
          db.from('campaign_recipients')
            .update({ status: 'queued', attempts, last_error: result.Message || null })
            .eq('id', item._recipientId),
          `requeue recipient ${item._recipientId}`, campaignId)
      } else {
        failedCount++
        await writeOrLog(
          db.from('campaign_recipients')
            .update({ status: 'failed', attempts, last_error: result.Message || null })
            .eq('id', item._recipientId),
          `fail recipient ${item._recipientId}`, campaignId)
      }
    } else {
      // Permanent rejection (300 invalid email, 406 inactive recipient,
      // ...): retrying can never succeed. Terminal immediately.
      //
      // BOUNCEDAT.1 — bounced_at is stamped HERE as well as in the Postmark
      // webhook. It was omitted originally, and the omission was invisible
      // because the row still read status='bounced' everywhere it was
      // counted by status. But every reader keyed on the TIMESTAMP silently
      // skipped these rows: the contact timeline's Bounced chip
      // (contacts/[id]/page.js), the sequence bounce count
      // (/api/sequences/[id]/stats), integration-health's
      // `.not('bounced_at','is',null)`. Live that was 42 events over 11
      // contacts reading as zero. `now` is the truthful instant — Postmark
      // rejected the address on this call, milliseconds ago.
      bouncedCount++
      await writeOrLog(
        db.from('campaign_recipients')
          .update({
            status: 'bounced',
            bounce_type: 'rejected',
            bounced_at: new Date().toISOString(),
            attempts: (item._attempts || 0) + 1,
            last_error: result.Message || null,
          })
          .eq('id', item._recipientId),
        `stamp recipient ${item._recipientId} bounced`, campaignId)
    }
  }

  // Refresh all rollup counters from email_sends so the progress
  // bar reflects reality after this chunk. recalculate_campaign_stats
  // (mig 157) is a single UPDATE with 7 COUNT(*) sub-selects against
  // indexed columns — ~100ms for typical sizes, dominated by
  // sub-selects on email_sends.campaign_id which is indexed. Cheaper
  // than the prior per-row increment approach AND keeps total_sent /
  // total_bounced / etc consistent so the operator-facing campaign
  // editor never shows weird mid-flight deltas.
  await db.rpc('recalculate_campaign_stats', { p_campaign_id: campaignId })
    .then(({ error }) => { if (error) console.error('[campaign-sender] mid-send recalc failed:', error.message) })

  return {
    phase: 'send',
    sent: sentCount,
    bounced: bouncedCount,
    retried: retriedCount,
    failed: failedCount,
    suppressed: suppressed.length,
  }
}

/**
 * CAMPAIGN-REL.2 — return lease-expired 'sending' recipients to the
 * queue (or 'failed' once the attempt cap is spent).
 *
 * A row is stuck when a cron invocation claimed it (queued→sending)
 * and then died before applying the send result — Vercel invocation
 * killed, deploy mid-tick, unhandled throw after the claim. Without
 * this sweep those rows sit in 'sending' forever and the campaign
 * finalises as 'sent' around them.
 *
 * Bulk-updated per attempts-bucket (at most MAX_SEND_ATTEMPTS distinct
 * values) because PostgREST can't express `attempts = attempts + 1`.
 * claimed_at IS NULL rows are pre-mig-392 strays — swept too, so any
 * historically stuck recipients self-heal.
 */
async function reclaimStuckSending(db, campaignId) {
  const cutoff = new Date(Date.now() - SENDING_LEASE_MS).toISOString()
  const { data: stale, error } = await db
    .from('campaign_recipients')
    .select('id, attempts')
    .eq('campaign_id', campaignId)
    .eq('status', 'sending')
    .or(`claimed_at.lt.${cutoff},claimed_at.is.null`)
  if (error) {
    console.error('[campaign-sender] stuck-sending sweep failed:', error.message)
    return
  }
  if (!stale || stale.length === 0) return

  const buckets = new Map() // attempts value → ids
  for (const row of stale) {
    const key = row.attempts || 0
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(row.id)
  }
  for (const [prevAttempts, ids] of buckets) {
    // The claim counted as an attempt — the batch may have reached
    // Postmark before the tick died.
    const attempts = prevAttempts + 1
    const update = attempts < MAX_SEND_ATTEMPTS
      ? { status: 'queued', attempts, last_error: 'send attempt timed out (reclaimed from sending)' }
      : { status: 'failed', attempts, last_error: 'send attempt timed out (reclaimed from sending)' }
    await writeOrLog(db.from('campaign_recipients').update(update).in('id', ids), 'reclaim stuck sending rows', campaignId)
  }
}
