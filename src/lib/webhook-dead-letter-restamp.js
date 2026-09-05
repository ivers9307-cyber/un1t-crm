// MAIL-DEADLETTER.2 — re-stamp orphan inbound dead-letter rows when a mailbox
// appears.
//
// THE HOLE. An inbound email that matches no active mailbox is dead-lettered
// as `no_matching_mailbox` with location_id NULL — correctly, because at
// capture the resolver found nothing to stamp (bestEffortInboundLocation in
// the postmark-inbound route). The morgue is org-scoped (MAIL-DEADLETTER.1,
// #1608): an owner sees a row only where they are owner at ITS location, and
// the list route bounds its query with `.in('location_id', …)`, which excludes
// NULL rows outright. So the one row that most needs an owner's attention —
// "mail arrived before you configured the account" — stays invisible to that
// owner FOREVER, even after they configure the account: nothing revisits the
// stamp. Mig 586 fixed the rows that existed on 5 Sep 2026 once; this is the
// same repair, run at the moment that makes it true — a mailbox is created or
// reactivated — so the hole cannot reopen.
//
// WHAT IT DOES. Scans the NULL-location postmark_inbound rows that are still
// pending/failed (resolved/discarded rows are history; the visibility model
// already answers them from their own location_id), resolves each payload's
// recipients against the ACTIVE mailboxes as they stand NOW with the very
// resolver the capture path uses (recipientEmails → resolveMailboxByRecipient:
// ToFull, then CcFull, then the display `To`, then OriginalRecipient; first
// hit on an active mailbox wins), and stamps the location it finds. Rows that
// still match nothing stay NULL — the fail-open default, never a guess.
//
// It does NOT filter to the address that just changed: the set of orphans is
// tiny (single digits live), the mailbox set is one bounded read, and running
// the full repair means a row missed for any reason — a mailbox created by a
// path that never called this, a manual INSERT — is healed on the next change
// rather than never. Idempotent: `.is('location_id', null)` guards the UPDATE
// as well as the SELECT, so a row another process stamped between the two is
// left as that process left it.
//
// CONTRACT. Best-effort, NEVER throws, never blocks the caller's own outcome:
// a mailbox create that succeeds must answer 201 whether or not the morgue
// could be tidied. Every failure is logged and answered as `{ ok: false }`;
// the caller is expected to ignore the answer (it is for tests and logs).

import { recipientEmails } from '@/lib/email-inbox'
import { resolveMailboxByRecipient } from '@/lib/email-mailboxes'
import { logInfo, logWarn } from '@/lib/log'

/**
 * Ceiling on orphan rows read per run. The live NULL set is single digits;
 * this is the 1k-row-cap discipline (CLAUDE.md), not an expectation. A run
 * that hits it stamps what it read and the next mailbox change reads again.
 */
export const RESTAMP_SCAN_LIMIT = 500

/** Ceiling on active mailboxes loaded — one page, the same cap the app uses. */
export const RESTAMP_MAILBOX_LIMIT = 1000

/** The statuses a row can still be acted on in. Mirrors mig 586. */
export const RESTAMP_STATUSES = Object.freeze(['pending', 'failed'])

/**
 * Stamp `location_id` onto every orphan inbound dead-letter row whose
 * recipients resolve to an active mailbox today.
 *
 * @param {object} db service-role supabase client
 * @param {{ reason?: string, mailboxId?: string|null }} [ctx] for the log line only
 * @returns {Promise<{ ok: boolean, scanned: number, stamped: number, error?: string }>}
 */
export async function restampOrphanInboundDeadLetters(db, { reason = 'mailbox_change', mailboxId = null } = {}) {
  const meta = { reason, mailboxId }
  try {
    const { data: rows, error: readErr } = await db
      .from('webhook_dead_letter')
      .select('id, payload')
      .eq('provider', 'postmark_inbound')
      .is('location_id', null)
      .in('status', [...RESTAMP_STATUSES])
      .order('id', { ascending: true })
      .limit(RESTAMP_SCAN_LIMIT)
    if (readErr) {
      logWarn('webhook-dead-letter-restamp', 'orphan read failed', { ...meta, err: readErr })
      return { ok: false, scanned: 0, stamped: 0, error: readErr.message || String(readErr) }
    }
    const orphans = Array.isArray(rows) ? rows : []
    if (orphans.length === 0) return { ok: true, scanned: 0, stamped: 0 }

    const { data: mailboxes, error: mbErr } = await db
      .from('email_mailboxes')
      .select('id, location_id, address, active')
      .eq('active', true)
      .limit(RESTAMP_MAILBOX_LIMIT)
    if (mbErr) {
      logWarn('webhook-dead-letter-restamp', 'mailbox read failed', { ...meta, err: mbErr })
      return { ok: false, scanned: orphans.length, stamped: 0, error: mbErr.message || String(mbErr) }
    }

    // Group by the location each row resolves to, so the UPDATE is one
    // statement per studio rather than one per row.
    const idsByLocation = new Map()
    for (const row of orphans) {
      const mailbox = resolveMailboxByRecipient(mailboxes || [], recipientEmails(row?.payload))
      const locationId = mailbox?.location_id
      if (!locationId) continue
      if (!idsByLocation.has(locationId)) idsByLocation.set(locationId, [])
      idsByLocation.get(locationId).push(row.id)
    }

    let stamped = 0
    let failed = 0
    for (const [locationId, ids] of idsByLocation) {
      const { data: updated, error: upErr } = await db
        .from('webhook_dead_letter')
        .update({ location_id: locationId })
        .in('id', ids)
        // Idempotency guard: never overwrite a stamp something else wrote
        // between our read and this write.
        .is('location_id', null)
        .select('id')
      if (upErr) {
        failed += 1
        logWarn('webhook-dead-letter-restamp', 'stamp failed', { ...meta, locationId, count: ids.length, err: upErr })
        continue
      }
      stamped += Array.isArray(updated) ? updated.length : 0
    }

    if (stamped > 0 || failed > 0) {
      logInfo('webhook-dead-letter-restamp', 'orphans re-stamped', {
        ...meta, scanned: orphans.length, stamped, failedLocations: failed,
      })
    }
    return failed > 0
      ? { ok: false, scanned: orphans.length, stamped, error: `${failed} location update(s) failed` }
      : { ok: true, scanned: orphans.length, stamped }
  } catch (err) {
    logWarn('webhook-dead-letter-restamp', 'threw', { ...meta, err })
    return { ok: false, scanned: 0, stamped: 0, error: String(err?.message || err) }
  }
}
