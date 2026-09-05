import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo } from '@/lib/log'
import { spamPurgeCutoff, SPAM_RETENTION_DAYS } from '@/lib/email-spam'
import { purgeAttachmentsForMessages } from '@/lib/email-attachments-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * How many quarantined tickets one page reads and deletes. Small on purpose:
 * each page's messages and attachments are read with their own paginated
 * scans, and a page of 200 spam tickets is a few hundred messages — well
 * inside one select cap per hop, with room to spare.
 */
export const PURGE_PAGE_SIZE = 200
/** Runaway guard — 5,000 tickets per tick; the backlog drains daily. */
const MAX_PAGES = 25
/** The per-hop scan size for messages, inside the 1,000-row select cap. */
const SCAN_PAGE = 1000

/**
 * GET /api/cron/purge-spam-tickets — MAIL-SPAM.1's 30-day purge.
 *
 * WHAT IT DELETES: email_tickets rows with `is_spam = true` whose
 * spam_flagged_at is older than SPAM_RETENTION_DAYS, and nothing else. Never a
 * live row of any age; never a merged tombstone (the merge machinery owns
 * those). The clock runs from spam_flagged_at, not created_at, so an operator
 * who marks an old thread as spam today still gets the full 30 days to change
 * their mind.
 *
 * ORDER, AND WHY: attachment OBJECTS go first, then the ticket rows (messages
 * and attachment rows CASCADE). The rows are the only thing that names the
 * objects — after the cascade nothing could find them, and an unreferenced
 * object is a cost line forever. purgeAttachmentsForMessages also releases
 * the bytes from the mailbox counter, or the quota reads full for space that
 * was freed. A failed object removal is logged loudly and the rows still go:
 * a leaked object is a cost, a spam ticket that can never be deleted is a
 * quarantine that never empties.
 *
 * MERGE TOMBSTONES (mig 536) ARE THE ONE FK THAT BITES. `merged_into_id`
 * (tombstone → target) and `email_inbox_messages.merged_from_ticket_id`
 * (moved message → tombstone) are both NO ACTION, and once a merge has moved
 * messages they point at each other: the tombstone cannot go while the
 * target's messages name it, and the target cannot go while the tombstone
 * names it. So a quarantined ticket that was ever a merge TARGET is deleted
 * IN THE SAME STATEMENT as its tombstones — Postgres checks NO ACTION at
 * statement end, by which point both rows and the cascaded messages are gone.
 * Two statements in either order fail forever, and a purge that fails every
 * night is a quarantine that never empties. A tombstone whose target is NOT
 * being purged is left alone (the merge machinery owns it).
 *
 * THE RACE THE ONE-STATEMENT .or() CANNOT CLOSE: a target released (Not spam)
 * between the candidate scan and the delete no longer matches its own half,
 * but its tombstones still match theirs — the statement would delete the
 * tombstones, leave the target, and merged_from_ticket_id on the target's
 * moved messages would refuse it: 500, no heartbeat that night. So the
 * targets' flags are RE-READ immediately before the statement and a released
 * target is dropped from BOTH halves. The window that remains is the
 * milliseconds between that re-read and the statement; a release inside it
 * still 500s once and self-heals the next night.
 *
 * PAGING: delete-as-you-go. Each iteration reads the OLDEST PURGE_PAGE_SIZE
 * candidates with .range(0, n-1) — after that page is deleted the next oldest
 * rows move into range 0, so the cursor never advances and never skips. A
 * short page ends the run; MAX_PAGES bounds it. Every hop pages with
 * .range(): every .select() caps at 1,000 rows whatever the code asks for.
 *
 * FAILURE: any hop that errors answers 500 and does NOT stamp — a purge that
 * is silently not purging would show up only as a Spam view that keeps
 * growing. Idle runs (nothing to purge) DO stamp: the cron ran and was right
 * to do nothing.
 *
 * Secured by CRON_SECRET (Vercel cron sends Authorization: Bearer <secret>).
 * Heartbeat row + vercel.json entry ship with mig 584.
 */
export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const cutoff = spamPurgeCutoff(Date.now())

  let ticketsDeleted = 0
  let tombstonesDeleted = 0
  let attachmentsRemoved = 0
  let bytesFreed = 0
  let pages = 0
  let capReached = false

  for (;;) {
    if (pages >= MAX_PAGES) { capReached = true; break }

    const { data: candidates, error: candErr } = await db.from('email_tickets')
      .select('id')
      .eq('is_spam', true)
      .is('merged_into_id', null)
      .lt('spam_flagged_at', cutoff)
      .order('spam_flagged_at', { ascending: true })
      .range(0, PURGE_PAGE_SIZE - 1)
    if (candErr) {
      logError('cron.purge-spam-tickets', 'candidate scan failed', { err: candErr.message })
      return NextResponse.json({ success: false, error: candErr.message }, { status: 500 })
    }
    const ticketIds = (candidates || []).map(t => t.id).filter(Boolean)
    if (ticketIds.length === 0) break
    pages += 1

    // Messages of this page's tickets — paged, since 200 spam tickets can
    // carry more than one select cap of messages between them.
    const messageIds = []
    for (let from = 0; ; from += SCAN_PAGE) {
      const { data: msgs, error: msgErr } = await db.from('email_inbox_messages')
        .select('id')
        .in('ticket_id', ticketIds)
        .order('id', { ascending: true })
        .range(from, from + SCAN_PAGE - 1)
      if (msgErr) {
        logError('cron.purge-spam-tickets', 'message scan failed', { err: msgErr.message })
        return NextResponse.json({ success: false, error: msgErr.message }, { status: 500 })
      }
      const page = msgs || []
      for (const m of page) if (m?.id) messageIds.push(m.id)
      if (page.length < SCAN_PAGE) break
    }

    // Merge tombstones pointing INTO this page — see the header. Paged for
    // form; a page of 200 targets has at most a handful.
    const tombstones = []
    for (let from = 0; ; from += SCAN_PAGE) {
      const { data: tombs, error: tombErr } = await db.from('email_tickets')
        .select('id, merged_into_id')
        .in('merged_into_id', ticketIds)
        .order('id', { ascending: true })
        .range(from, from + SCAN_PAGE - 1)
      if (tombErr) {
        logError('cron.purge-spam-tickets', 'tombstone scan failed', { err: tombErr.message })
        return NextResponse.json({ success: false, error: tombErr.message }, { status: 500 })
      }
      const page = tombs || []
      for (const t of page) if (t?.id) tombstones.push(t)
      if (page.length < SCAN_PAGE) break
    }
    // A tombstone holds no messages once merged (they moved to the target),
    // but if one ever did, its attachments must be freed like any other's.
    if (tombstones.length > 0) {
      for (let from = 0; ; from += SCAN_PAGE) {
        const { data: msgs, error: msgErr } = await db.from('email_inbox_messages')
          .select('id')
          .in('ticket_id', tombstones.map(t => t.id))
          .order('id', { ascending: true })
          .range(from, from + SCAN_PAGE - 1)
        if (msgErr) {
          logError('cron.purge-spam-tickets', 'tombstone message scan failed', { err: msgErr.message })
          return NextResponse.json({ success: false, error: msgErr.message }, { status: 500 })
        }
        const page = msgs || []
        for (const m of page) if (m?.id) messageIds.push(m.id)
        if (page.length < SCAN_PAGE) break
      }
    }

    // Objects BEFORE rows — see the header. Never throws; a leak is logged.
    if (messageIds.length > 0) {
      const purged = await purgeAttachmentsForMessages(db, messageIds)
      attachmentsRemoved += purged.removed
      bytesFreed += purged.bytesFreed
      if (!purged.ok) {
        logError('cron.purge-spam-tickets', 'attachment purge reported a failure — rows are still being deleted', {
          error: purged.error, messageCount: messageIds.length,
        })
      }
    }

    // The rows. The quarantine filter rides along on EVERY delete as
    // belt-and-braces: an id read seconds ago whose operator has just clicked
    // Not spam is no longer `is_spam` and survives — a stale id list can only
    // ever delete a quarantined row (or the tombstone of one).
    let remaining = ticketIds
    if (tombstones.length > 0) {
      const scannedTargets = [...new Set(tombstones.map(t => t.merged_into_id).filter(Boolean))]
      // Re-read the targets' flags NOW (the header's race): a target released
      // since the candidate scan leaves the statement with its tombstones and
      // stays out of the plain delete below too — it is no longer spam.
      const { data: stillSpam, error: recheckErr } = await db.from('email_tickets')
        .select('id')
        .in('id', scannedTargets)
        .eq('is_spam', true)
      if (recheckErr) {
        logError('cron.purge-spam-tickets', 'merge-target re-check failed', { err: recheckErr.message, page: pages })
        return NextResponse.json({ success: false, error: recheckErr.message }, { status: 500 })
      }
      const targetSet = new Set((stillSpam || []).map(t => t.id))
      const targets = scannedTargets.filter(id => targetSet.has(id))
      const tombIds = tombstones.filter(t => targetSet.has(t.merged_into_id)).map(t => t.id)
      if (targets.length > 0) {
        // ONE statement for target + tombstone (the header's FK cycle). The
        // .or() is the belt-and-braces in a form that admits both halves.
        const { error: pairErr } = await db.from('email_tickets')
          .delete()
          .in('id', [...targets, ...tombIds])
          .or(`is_spam.eq.true,merged_into_id.in.(${targets.join(',')})`)
        if (pairErr) {
          logError('cron.purge-spam-tickets', 'merged-ticket delete failed', { err: pairErr.message, page: pages })
          return NextResponse.json({ success: false, error: pairErr.message }, { status: 500 })
        }
        ticketsDeleted += targets.length
        tombstonesDeleted += tombIds.length
      }
      const scannedSet = new Set(scannedTargets)
      remaining = ticketIds.filter(id => !scannedSet.has(id))
    }
    if (remaining.length > 0) {
      const { error: delErr } = await db.from('email_tickets')
        .delete()
        .eq('is_spam', true)
        .in('id', remaining)
      if (delErr) {
        logError('cron.purge-spam-tickets', 'ticket delete failed', { err: delErr.message, page: pages })
        return NextResponse.json({ success: false, error: delErr.message }, { status: 500 })
      }
      ticketsDeleted += remaining.length
    }

    if (ticketIds.length < PURGE_PAGE_SIZE) break
  }

  const outcome = {
    cutoff,
    retention_days: SPAM_RETENTION_DAYS,
    tickets_deleted: ticketsDeleted,
    merge_tombstones_deleted: tombstonesDeleted,
    attachments_removed: attachmentsRemoved,
    bytes_freed: bytesFreed,
    pages,
    cap_reached: capReached,
  }
  logInfo('cron.purge-spam-tickets', 'run complete', outcome)

  await stampHeartbeat('purge-spam-tickets', outcome)
  return NextResponse.json({ success: true, data: outcome })
}
