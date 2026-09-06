// HOST-METRICS.1 — Postmark backfill for host_campaign_sends.
//
// One-off + repair job: walks a host's own campaigns, pulls Postmark's own
// outbound-message history (listOutboundMessages / getOutboundMessageDetails,
// src/lib/postmark-messages.js — never throws), matches each message back to
// a host_campaign_sends row by Metadata (host_campaign_id + contact_id), and
// folds delivery/open/click/bounce/unsubscribe events into the mig-590
// columns.
//
// BOUNCE-LOG PASS: before paging messages, this pages Postmark's bounce log
// (listBounces, same module) for the same window into a MessageID -> bounce
// map. The message-details timeline's Bounced event carries no bounce type,
// and spam complaints never appear in the timeline at all — both live only
// in the bounce log, so hard/soft/complaint classification comes from there,
// matched back onto a message by MessageID. A bounce-log failure is
// collected as an error but does not abort the run: timeline folding still
// works, bounce types just default (see foldMessageEvents below).
//
// WHY THIS EXISTS: those columns were added after real sends had already gone
// out, so their history lives only in Postmark, not in our own send records.
// Postmark retains outbound message history AND the bounce log for 45 DAYS —
// the earliest real host-campaign sends (31 Jul 2026) fall out of that
// window around 14 Sep 2026, so this backfill (both passes) must run (or be
// re-run) before then or that tail is lost forever.
//
// IDEMPOTENT: every write is a null-guarded or zero-guarded conditional
// update — a repeat run against messages already folded touches nothing.
// Real host sends are tagged 'host-campaign'; test sends are tagged
// 'host-campaign-test' and are skipped by tag before a details call is ever
// made (Postmark's own 45-day retention makes an extra idle call a real cost,
// not just noise).
//
// DEFAULT IS A DRY RUN — the admin route only writes on an explicit ?dry=0.

import { listOutboundMessages, getOutboundMessageDetails, listBounces } from './postmark-messages.js'
import { logError, logWarn } from './log.js'

const PAGE = 500
const PAUSE_MS = 40
const TAG = 'host-campaign'

const TIMESTAMP_KEYS = ['delivered_at', 'opened_at', 'clicked_at', 'bounced_at', 'complained_at', 'unsubscribed_at']
const COUNT_KEYS = ['open_count', 'click_count']

/**
 * Would applying `patch` onto `row` actually change anything, per the same
 * null/zero guards the live writes use? Pure — used to make dry-run's
 * `updated` count honest (matching what a live run would actually write)
 * and, mutated in, to avoid double-counting a resend of the same row within
 * one run.
 *
 * @param {object} row
 * @param {object} patch
 * @returns {boolean}
 */
function wouldChangeRow(row, patch) {
  for (const key of TIMESTAMP_KEYS) {
    if (key in patch && row[key] == null) return true
  }
  for (const key of COUNT_KEYS) {
    if (key in patch && row[key] === 0 && patch[key] > 0) return true
  }
  return false
}

/**
 * Mutate `row` in place with whichever `patch` keys would actually change it
 * (the same guard as wouldChangeRow). Used in dry mode, where nothing is
 * written to the DB, so a second message matching the same row (a resend)
 * within one run is still judged against the post-fold state instead of
 * being counted again.
 */
function applyGuardedPatch(row, patch) {
  for (const key of TIMESTAMP_KEYS) {
    if (key in patch && row[key] == null) row[key] = patch[key]
  }
  for (const key of COUNT_KEYS) {
    if (key in patch && row[key] === 0 && patch[key] > 0) row[key] = patch[key]
  }
}

/**
 * Fold one message's Postmark event history into a host_campaign_sends
 * patch. Pure — no I/O. Only the keys that actually apply are returned
 * (counts only when > 0), so callers can null/zero-guard each key
 * independently without re-deriving "did this event type occur".
 *
 * @param {Array<{Type: string, ReceivedAt: string, Details?: object}>} events
 * @param {{type: 'hard'|'soft'|'transient'|'complaint', at: string}|null} [bounce]
 *   This message's bounce-log match, if any (see listBounces / the
 *   module header's BOUNCE-LOG PASS note). The timeline's own Bounced event
 *   carries no type, so classification comes from here; without a match we
 *   default to hard. A complaint is not a bounce in our model — it sets
 *   complained_at instead of bounced_at (precedence complained > bounced).
 * @returns {object}
 */
export function foldMessageEvents(events, bounce = null) {
  const patch = {}
  if (!Array.isArray(events)) return patch

  let openCount = 0
  let clickCount = 0

  for (const event of events) {
    switch (event?.Type) {
      case 'Delivered':
        if (!patch.delivered_at) patch.delivered_at = event.ReceivedAt
        break
      case 'Opened':
        if (!patch.opened_at) patch.opened_at = event.ReceivedAt
        openCount += 1
        break
      case 'LinkClicked':
        if (!patch.clicked_at) patch.clicked_at = event.ReceivedAt
        clickCount += 1
        break
      case 'Bounced':
        if (bounce?.type === 'complaint') {
          if (!patch.complained_at) patch.complained_at = bounce.at
        } else if (!patch.bounced_at) {
          // The timeline carries no type; without a bounce-log match we
          // default to hard. This is NOT the same default the webhook uses
          // for a missing HardBounce type — it's stated here, not inherited.
          patch.bounced_at = event.ReceivedAt
          patch.bounce_type = ['hard', 'soft', 'transient'].includes(bounce?.type) ? bounce.type : 'hard'
        }
        break
      case 'SubscriptionChanged':
        if (!patch.unsubscribed_at && String(event.Details?.SuppressSending).toLowerCase() === 'true') {
          patch.unsubscribed_at = event.ReceivedAt
        }
        break
      default:
        // Transient (bare) and anything else Postmark might add later —
        // ignored rather than erroring, per the module's best-effort posture.
        break
    }
  }

  if (openCount > 0) patch.open_count = openCount
  if (clickCount > 0) patch.click_count = clickCount

  return patch
}

/**
 * Backfill Postmark delivery/open/click/bounce/unsubscribe events onto one
 * host's host_campaign_sends rows.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {{hostId: string, dry?: boolean, fromDate?: string, toDate?: string, sleep?: (ms:number)=>Promise<void>}} opts
 * @returns {Promise<{dry: boolean, scanned: number, matched: number, stamped: number, updated: number, skipped: number, errors: Array<object>}>}
 *   Never throws — a list/campaign-load failure is collected in `errors` and
 *   the summary returned so far.
 */
export async function backfillHostCampaignEvents(db, { hostId, dry = true, fromDate, toDate, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const summary = { dry, scanned: 0, matched: 0, stamped: 0, updated: 0, skipped: 0, errors: [] }

  // 1. Which campaigns belong to this host — scopes every message match
  // below so a stray Metadata collision can never touch another host's rows.
  // eslint-disable-next-line guardrails/no-uncapped-supabase-limit -- a host has a handful of campaigns (daily cap 2); 1000 is a ceiling, not a page
  const { data: campaignRows, error: campaignsError } = await db
    .from('host_campaigns')
    .select('id')
    .eq('host_id', hostId)
    .limit(1000)
  if (campaignsError) {
    logError('host-campaign-backfill', 'failed to load host campaigns', { hostId, error: campaignsError })
    summary.errors.push({ stage: 'campaigns', error: campaignsError })
    return summary
  }
  const campaignIds = new Set((campaignRows ?? []).map((c) => c.id))
  if (campaignIds.size === 0) return summary

  // 2. Every send row across those campaigns, keyed by campaign+contact —
  // that pair is what Postmark's own Metadata carries back on each message.
  // The widened column list is what makes `updated` honest below: whether a
  // patch would actually change anything is judged against this snapshot.
  const rowsByKey = new Map()
  for (const campaignId of campaignIds) {
    let from = 0
    for (;;) {
      const { data, error } = await db
        .from('host_campaign_sends')
        .select('id, campaign_id, contact_id, postmark_message_id, delivered_at, opened_at, clicked_at, bounced_at, complained_at, unsubscribed_at, open_count, click_count')
        .eq('campaign_id', campaignId)
        .order('id')
        .range(from, from + PAGE - 1)
      if (error) {
        logError('host-campaign-backfill', 'failed to load campaign sends', { hostId, campaignId, error })
        summary.errors.push({ stage: 'rows', campaign_id: campaignId, error })
        break
      }
      const page = data ?? []
      for (const row of page) rowsByKey.set(`${row.campaign_id}:${row.contact_id}`, row)
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  // 3. Page through Postmark's bounce log for this window — hard/soft
  // bounces and spam complaints (see the module header's BOUNCE-LOG PASS
  // note). A failure here is non-fatal: it's collected and the run
  // continues with timeline folding only (bounce types default to hard).
  const bounceByMessage = new Map()
  let bounceScanned = 0
  let bounceOffset = 0
  for (;;) {
    const { total: bounceTotal, bounces, error: bouncesError } = await listBounces({ tag: TAG, fromDate, toDate, count: PAGE, offset: bounceOffset })
    if (bouncesError) {
      logError('host-campaign-backfill', 'Postmark bounce list failed', { hostId, error: bouncesError })
      summary.errors.push({ stage: 'bounces', error: bouncesError })
      break
    }
    bounceScanned += bounces.length
    for (const b of bounces) {
      if (!b?.MessageID) continue
      const type =
        b.Type === 'SpamComplaint' ? 'complaint' :
        b.Type === 'HardBounce' ? 'hard' :
        b.Type === 'SoftBounce' ? 'soft' :
        'transient'
      bounceByMessage.set(b.MessageID, { type, at: b.BouncedAt })
    }
    if (bounces.length < PAGE || bounceScanned >= bounceTotal) break
    bounceOffset += PAGE
  }

  // 4. Page through Postmark's outbound history for this window and fold
  // each real host-campaign message onto the row it matches.
  let offset = 0
  for (;;) {
    const { total, messages, error } = await listOutboundMessages({ tag: TAG, fromDate, toDate, count: PAGE, offset })
    if (error) {
      logError('host-campaign-backfill', 'Postmark list failed', { hostId, error })
      summary.errors.push({ stage: 'list', error })
      break
    }

    summary.scanned += messages.length

    for (const message of messages) {
      const meta = message.Metadata
      const campaignId = meta?.host_campaign_id
      const contactId = meta?.contact_id
      const key = campaignId && contactId ? `${campaignId}:${contactId}` : null
      const row = key ? rowsByKey.get(key) : null

      if (message.Tag !== TAG || !meta || !campaignIds.has(campaignId) || !row) {
        summary.skipped += 1
        continue
      }
      summary.matched += 1

      if (!row.postmark_message_id) {
        summary.stamped += 1
        if (!dry) {
          const { error: stampErr } = await db
            .from('host_campaign_sends')
            .update({ postmark_message_id: message.MessageID })
            .eq('id', row.id)
            .is('postmark_message_id', null)
          if (stampErr) {
            logWarn('host-campaign-backfill', 'failed to stamp postmark_message_id', { row_id: row.id, error: stampErr })
            summary.errors.push({ message_id: message.MessageID, error: stampErr })
            await sleep(PAUSE_MS)
            continue
          }
          row.postmark_message_id = message.MessageID
        }
      }

      // Nothing left to learn: every timestamp column this backfill can set
      // is already set, so no patch derived from the details call could
      // ever change this row. Skip the (rate-limited) details call outright.
      const nothingLeftToLearn =
        row.postmark_message_id && row.delivered_at && row.opened_at && row.clicked_at &&
        (row.bounced_at || row.complained_at || row.unsubscribed_at)
      if (nothingLeftToLearn) continue

      const { details, error: detailsError } = await getOutboundMessageDetails(message.MessageID)
      if (detailsError) {
        summary.errors.push({ message_id: message.MessageID, error: detailsError })
        await sleep(PAUSE_MS)
        continue
      }

      const patch = foldMessageEvents(details?.MessageEvents, bounceByMessage.get(message.MessageID) ?? null)
      if (Object.keys(patch).length === 0) {
        await sleep(PAUSE_MS)
        continue
      }

      if (dry) {
        if (wouldChangeRow(row, patch)) {
          summary.updated += 1
          applyGuardedPatch(row, patch) // so a resend within this run isn't double-counted
        }
      } else {
        let anyWritten = false
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'open_count' || k === 'click_count') {
            if (row[k] > 0) continue // already counted — never re-count
            const { data, error: writeErr } = await db
              .from('host_campaign_sends').update({ [k]: v }).eq('id', row.id).eq(k, 0).select('id')
            if (writeErr) {
              logWarn('host-campaign-backfill', `failed to write ${k}`, { row_id: row.id, error: writeErr })
              summary.errors.push({ message_id: message.MessageID, error: writeErr })
              continue
            }
            if (data?.length) { row[k] = v; anyWritten = true }
            continue
          }
          const { data, error: writeErr } = await db
            .from('host_campaign_sends').update({ [k]: v }).eq('id', row.id).is(k, null).select('id')
          if (writeErr) {
            logWarn('host-campaign-backfill', `failed to write ${k}`, { row_id: row.id, error: writeErr })
            summary.errors.push({ message_id: message.MessageID, error: writeErr })
            continue
          }
          if (data?.length) { row[k] = v; anyWritten = true }
        }
        if (anyWritten) summary.updated += 1
      }

      await sleep(PAUSE_MS)
    }

    if (messages.length < PAGE || summary.scanned >= total) break
    offset += PAGE
  }

  return summary
}
