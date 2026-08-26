// MAILBOX-CONNECT.5.2 — Vercel cron, every five minutes.
//
// Reads new mail off every mailbox whose `ingress` is 'imap' and POSTs each
// message at the existing inbound webhook, so a studio can connect an account
// on a domain whose MX we will never control (the whole point of the feature —
// see docs/superpowers/specs/2026-08-26-imap-mailbox-connector-design.md §1).
//
// SINCE PHASE 8 THIS ONE TICK SWEEPS TWO LANES: INBOX, then the account's Sent
// folder (§5). The second exists because a reply somebody types in Gmail never
// touches INBOX, so without it the ticket sits "needs reply" forever and a
// second person answers the member again. There is deliberately NO second cron
// and no second heartbeat: the lanes share one wall-clock budget inside
// pollAllMailboxes, which sweeps inbox to completion first precisely so a busy
// Sent folder can never delay a member's own mail. A tick that runs out of
// clock before the sent lane is a healthy tick — that lane's watermark did not
// move, so the next tick reads the same messages.
//
// A THIN WRAPPER, on purpose. Everything that decides anything lives in
// src/lib/mail/imap-poll.js, where it is unit-tested against a fake IMAP
// client and a fake fetch. What lives HERE is the CRON_SECRET gate, the
// heartbeat, and the JSON summary — the same skeleton as run-sequences and
// shelly-reconcile.
//
// DORMANT BY CONSTRUCTION. Until an operator connects a login in Phase 6 there
// are zero mailboxes with `ingress = 'imap'`, so a tick is one indexed SELECT
// that returns nothing — and it still stamps, because a dormant deploy must
// not page.
//
// 🔴 A FAILING TENANT IS NOT A FAILING CRON. One customer's revoked app
// password comes back as `failed: 1` in the summary and the tick still stamps
// the heartbeat. That is deliberate: the heartbeat answers "is the poller
// running", and letting one operator's expired credential mark the whole cron
// stale would page us for something only they can fix — while hiding the tick
// where the poller genuinely stopped. The per-mailbox state (`last_error`,
// `paused_until`, `last_ok_at` on email_mailbox_ingress) is what surfaces a
// broken mailbox, and Phase 9 alerts on an auth failure distinctly from a
// transport failure. The ONE thing that does not stamp is a sweep that could
// not read its own configuration.
//
// Auth: CRON_SECRET bearer, exactly as every other cron in this directory.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { pollAllMailboxes } from '@/lib/mail/imap-poll'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Worst case per mailbox is bounded by imap-connection.js's own timeouts (20s
// connect, 60s socket) plus up to `cap` messages, each costing a body
// download, its attachments, and one 30s-capped POST at our own webhook.
// Mailboxes run three at a time, so a handful of connected accounts with a
// backlog can genuinely use minutes. 300s is the Vercel Pro ceiling and the
// same budget run-sequences takes. Two lanes do NOT double it: they share the
// one DEFAULT_TICK_BUDGET_MS deadline, which is what 300s has always had 120s
// of headroom over.
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const out = await pollAllMailboxes(db)

  // STAMPED ONLY ON A COMPLETED SWEEP. `ok: false` means the mailbox list
  // itself could not be read — the poller cannot say whether any customer's
  // mail is arriving, which is exactly the tick the health check exists to
  // catch. Per-mailbox failures are counted, not fatal (see the header).
  //
  // The counters ride into cron_heartbeats.last_outcome so ops can tell "ran,
  // nothing connected" from "ran, three mailboxes failing" without opening the
  // logs. Every value is a number or a short reason code — no address, no
  // host, no error text, and certainly no credential.
  if (out.ok !== false) {
    await stampHeartbeat('poll-imap-mailboxes', out).catch((err) =>
      logWarn('cron-poll-imap-mailboxes', 'heartbeat failed', { err }))
  }

  return NextResponse.json({ success: out.ok !== false, ...out })
}
