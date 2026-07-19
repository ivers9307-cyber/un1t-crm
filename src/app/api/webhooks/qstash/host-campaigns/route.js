// QSTASH.8 — push-delivery worker for host campaign sends: campaign-level
// kick + chunk chaining (the first BULK job on the QStash push pattern).
//
// Unlike the previous five workers (one message per queue ROW), a host
// campaign can hold thousands of host_campaign_sends rows — a per-recipient
// publish would burn the QStash free-tier request budget (1000/day) and
// lose the cron's chunked pacing. So the send route publishes ONE
// campaign-level kick { campaignId }, and each delivery here processes ONE
// ≤50-row chunk through the SAME claim-before-send CAS the sweeper cron
// uses (src/lib/host-campaign-queue.js — the two consumers race safely;
// overlapping claimants win disjoint rows), then SELF-CHAINS: while
// pending rows remain, publish the next kick { campaignId, link+1 } with a
// 2s delay (gentle pacing) and — deliberately — NO dedup id: each chain
// link is a distinct message, and a dedup id would be swallowed inside
// QStash's dedup window because the body is otherwise identical.
//
// Chain-break safety: if the chain publish fails (or a link's invocation
// crashes), the sweeper cron (*/2) picks the 'sending' campaign up and
// drains the remainder — the queue table is the delivery guarantee, the
// chain is the latency/pacing optimisation. MAX_CHAIN (40 links per
// delivery lineage ≈ 2000 rows) is the defensive cap on runaway chains;
// at the cap we 200-and-stop-chaining and the cron takes over.
//
// Status-code contract with QStash retries:
//   200 — chunk_sent (chained or not), drained (campaign finalised),
//         halted (kill switch: sender unverified — the campaign
//         deliberately stays 'sending' and resumes via the cron sweeper
//         when UN1T re-verifies the domain; a QStash retry cannot help),
//         or skipped (campaign already terminal / unknown).
//   401 — signature rejected (QStash will retry; each retry re-verifies —
//         a rotated key heals this).
//   500 — infrastructure error inside the chunk. Retry-safe: rows a
//         crashed attempt left 'claimed' are NEVER re-sent — the cron's
//         stale sweep takes them terminal — so a redelivery only ever
//         claims fresh pending rows.
//
// host_campaign_sends stays the source of truth throughout — QStash going
// away entirely (env vars unset) reverts cleanly to cron-only draining.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyQStashSignature, publishQueuePush, HOST_CAMPAIGNS_WORKER_PATH } from '@/lib/qstash'
import { processHostCampaignChunk } from '@/lib/host-campaign-queue'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // same budget as the cron — a 50-row Postmark chunk can crawl

// Defensive cap on links per delivery lineage (40 × 50 rows ≈ 2000
// recipients pushed at chain speed; anything bigger drains on the cron).
export const MAX_CHAIN = 40
export const CHAIN_DELAY_SECONDS = 2

/**
 * missing_keys means WE are misconfigured (route reachable but signing keys
 * unset) — 503 flags it as a server problem. Every other reason is a bad
 * or forged delivery — 401.
 */
export function statusForVerifyFailure(reason) {
  return reason === 'missing_keys' ? 503 : 401
}

/**
 * Chain only while THIS chunk sent and pending rows remain, under the
 * lineage cap. remaining 0 with in-flight claims elsewhere deliberately
 * does NOT chain — whoever resolves last finalises, and the cron covers
 * any gap.
 */
export function shouldChain(outcome, link) {
  return outcome.status === 'chunk_sent' && (outcome.remaining || 0) > 0 && link < MAX_CHAIN
}

export function responseForOutcome(outcome, { chained = false } = {}) {
  if (outcome.status === 'chunk_sent') {
    return { status: 200, body: { success: true, chunk_sent: true, remaining: outcome.remaining || 0, chained } }
  }
  if (outcome.status === 'drained') {
    return { status: 200, body: { success: true, drained: true } }
  }
  if (outcome.status === 'halted') {
    return { status: 200, body: { success: true, halted: true } }
  }
  if (outcome.status === 'skipped') {
    return { status: 200, body: { success: true, skipped: true } }
  }
  return {
    status: 500,
    body: { success: false, error: outcome.error || 'processing_failed' },
  }
}

export async function POST(request) {
  // Raw body FIRST — the signature's body claim hashes the exact bytes
  // delivered, so any parse-then-restringify would break verification.
  const rawBody = await request.text()

  let expectedUrl = null
  try {
    expectedUrl = `${getAppUrl()}${HOST_CAMPAIGNS_WORKER_PATH}`
  } catch {
    // NEXT_PUBLIC_APP_URL unset — verify everything else but skip the
    // sub check rather than rejecting deliveries over our own config.
    console.error('[qstash host-campaigns worker] NEXT_PUBLIC_APP_URL unset; skipping sub-claim check')
  }

  const verdict = verifyQStashSignature({
    signature: request.headers.get('upstash-signature'),
    rawBody,
    url: expectedUrl || undefined,
  })
  if (!verdict.ok) {
    console.warn(`[qstash host-campaigns worker] delivery rejected: ${verdict.reason}`)
    return NextResponse.json(
      { success: false, error: verdict.reason },
      { status: statusForVerifyFailure(verdict.reason) }
    )
  }

  let parsed
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }
  const campaignId = parsed?.campaignId
  if (!campaignId) {
    return NextResponse.json({ success: false, error: 'missing_campaign_id' }, { status: 400 })
  }
  // The initial kick carries no link — it is link 1 of its lineage.
  const link = Number.isInteger(parsed?.link) && parsed.link > 0 ? parsed.link : 1

  const db = createServerClient()
  const outcome = await processHostCampaignChunk(db, campaignId)
  if (outcome.status === 'failed') {
    console.warn(`[qstash host-campaigns worker] campaign ${campaignId} chunk failed: ${outcome.error}`)
  }

  let chained = false
  if (shouldChain(outcome, link)) {
    try {
      const res = await publishQueuePush({
        path: HOST_CAMPAIGNS_WORKER_PATH,
        body: { campaignId, link: link + 1 },
        delaySeconds: CHAIN_DELAY_SECONDS,
        // NO deduplicationId — see the header: each link must be a
        // distinct message or QStash's dedup window swallows the chain.
      })
      chained = Boolean(res?.ok)
      if (!chained) {
        console.warn(`[qstash host-campaigns worker] chain publish failed for campaign ${campaignId} — cron sweeps the remainder`)
      }
    } catch {
      // publishQueuePush swallows its own errors; belt-and-braces only —
      // the cron sweeps whatever the broken chain leaves behind.
    }
  } else if (outcome.status === 'chunk_sent' && (outcome.remaining || 0) > 0) {
    console.warn(`[qstash host-campaigns worker] chain cap reached for campaign ${campaignId} (link ${link}) — cron takes over`)
  }

  const { status, body } = responseForOutcome(outcome, { chained })
  return NextResponse.json(body, { status })
}
