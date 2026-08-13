// EMAIL-HYGIENE.1 — nightly engagement-based list hygiene sweep.
//
// docs/EMAIL_DELIVERABILITY.md: suppress addresses that haven't opened
// in 90 days — the biggest available deliverability lever. This cron
// stamps contacts.email_suppressed_at (mig 395) on contacts where ALL
// hold (thresholds + predicate in src/lib/email-hygiene.js):
//   • email_marketing = true               (still consented)
//   • email_suppressed_at IS NULL          (not already suppressed)
//   • email_hygiene_released_at IS NULL    (no operator release — HYGREL.1)
//   • ≥3 marketing (broadcast) sends in the last 90 days
//   • zero opens AND zero clicks in the last 90 days (any stream)
//   • first marketing send >90 days ago (never punish new contacts)
//
// Reversible: any Open/Click webhook clears the stamp (postmark-webhook-
// processor), as does re-consent via the preference centre. The stamp is
// read by the marketing audience gate (buildAudienceQuery) and sequences'
// email step — administrative/transactional mail is never affected.
//
// HYGREL.1 — AND AN OPERATOR RELEASE IS PERMANENT. The three reversals above
// are all evidence-driven: the contact did something, or changed their mind.
// A release from the list-health hygiene surface is neither, and it must
// outlast this cron, because the contact still satisfies every criterion above
// the moment it is granted — a release with no gate would be undone by the
// very next 05:15 run, seven hours later. contacts.email_hygiene_released_at
// (mig 535) is that gate, and it is deliberately never cleared here: the same
// rule the repeat-bounce release route states, "a rule that overrules a human
// every night is not a rule, it is a nag". The audit row naming the operator
// and the reason lives in email_hygiene_releases; this column is only the
// filter, because an embedded-resource filter would break the count path
// (CLASSIFY.1) and an .in() of every release ever made is unbounded.
//
// Batch-safe: contacts are keyset-paginated by id (order id, gt lastId) —
// NOT offset pagination, because stamping rows mid-scan shrinks the
// "email_suppressed_at IS NULL" population and offset pages would skip
// rows. Keyset is immune: stamped rows are always behind the cursor.
// Every email_sends fetch .range()-paginates (1k-row cap invariant).
//
// Idempotent. Nightly at 05:15 UTC. CRON_SECRET bearer auth + heartbeat,
// same pattern as sweep-stale-push-tokens.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { logInfo, logError } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import {
  hygieneCutoffIso,
  computeSuppressionCandidates,
  fetchWindowMarketingSends,
  fetchEngagedContactIds,
  fetchPreWindowSenderIds,
} from '@/lib/email-hygiene'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CONTACT_PAGE = 500   // contacts evaluated per batch (id-keyset pages)
const STAMP_CHUNK = 200    // ids per UPDATE .in() — keeps the URL bounded

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const cutoffIso = hygieneCutoffIso()
  const nowIso = new Date().toISOString()

  let scanned = 0
  let suppressed = 0
  let lastId = null

  try {
    for (;;) {
      // Keyset page of the candidate population. Suppression is a global
      // hygiene concern, so the sweep runs across all locations.
      //
      // HYGREL.1 — email_hygiene_released_at excludes contacts an operator has
      // already released. It is a plain column rather than a join for the
      // reason mig 535 gives: an embedded-resource filter silently returns 0
      // under a count-only select. mig 535 widened idx_contacts_hygiene_scan to
      // carry this third condition, so released contacts are never visited
      // rather than filtered out after the scan.
      let pageQuery = db
        .from('contacts')
        .select('id')
        .eq('email_marketing', true)
        .is('email_suppressed_at', null)
        .is('email_hygiene_released_at', null)
        .order('id')
        .limit(CONTACT_PAGE)
      if (lastId) pageQuery = pageQuery.gt('id', lastId)

      const { data: page, error: pageErr } = await pageQuery
      if (pageErr) throw new Error(`contacts page failed: ${pageErr.message}`)
      if (!page || page.length === 0) break

      lastId = page[page.length - 1].id
      scanned += page.length
      const ids = page.map((c) => c.id)

      // Window facts for this page, then the pure predicate.
      const windowSends = await fetchWindowMarketingSends(db, ids, cutoffIso)
      const engagedIds = await fetchEngagedContactIds(db, ids, cutoffIso)

      // The pre-window (first-send-age) check only matters for contacts
      // that already pass count + zero-engagement — evaluate with an
      // everyone-passes set first, then confirm against real history.
      const provisional = computeSuppressionCandidates({
        contactIds: ids,
        windowSends,
        engagedIds,
        preWindowSenderIds: new Set(ids),
      })
      const preWindowSenderIds = await fetchPreWindowSenderIds(db, provisional, cutoffIso)
      const toSuppress = computeSuppressionCandidates({
        contactIds: ids,
        windowSends,
        engagedIds,
        preWindowSenderIds,
      })

      // Stamp in bounded chunks, re-asserting the guards so a concurrent
      // open-webhook clear, unsubscribe, or operator release between scan and
      // stamp wins. The sweep can take minutes; a release granted inside that
      // window must not be undone by the pass that was already running.
      for (let i = 0; i < toSuppress.length; i += STAMP_CHUNK) {
        const chunk = toSuppress.slice(i, i + STAMP_CHUNK)
        const { error: updErr } = await db
          .from('contacts')
          .update({ email_suppressed_at: nowIso })
          .in('id', chunk)
          .eq('email_marketing', true)
          .is('email_suppressed_at', null)
          .is('email_hygiene_released_at', null)
        if (updErr) throw new Error(`suppression stamp failed: ${updErr.message}`)
        suppressed += chunk.length
      }

      if (page.length < CONTACT_PAGE) break
    }
  } catch (err) {
    logError('cron-email-engagement-sweep', 'sweep failed', {
      err: err?.message || String(err), scanned, suppressed,
    })
    return NextResponse.json({ ok: false, error: err?.message || 'sweep failed' }, { status: 500 })
  }

  logInfo('cron-email-engagement-sweep', 'sweep complete', {
    scanned,
    suppressed,
    cutoff_iso: cutoffIso,
  })

  await stampHeartbeat('email-engagement-sweep')
  return NextResponse.json({ ok: true, scanned, suppressed, cutoff: cutoffIso })
}
