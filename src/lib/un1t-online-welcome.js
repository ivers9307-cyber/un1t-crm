// UN1TWELCOME.5 — the welcome sweep. Every 15 minutes (as an arm of the
// un1t-online-sync cron) it finds un1t.online clients the CRM has not yet
// considered (welcome_checked_at IS NULL) and enrols each in the studio's
// 'un1t_account_created' sequence, once.
//
// Rules, in order, per client:
//   - no linked contact yet and under 48 h old   -> waiting (the contact link
//     may still arrive; not stamped)
//   - no linked contact, older                   -> stamped, no_contact
//   - contact has no email                       -> stamped, no_email
//   - CRM-made row (crm_written_at) whose account email has not gone out and
//     is under 30 min old                        -> waiting (the mirror write
//     inserts the row seconds BEFORE the account email is stamped)
//   - otherwise enrol (crmMade = the account email already went out), then
//     stamp whatever the trigger answered: a refusal is counted as failed but
//     never retried, so one bad client cannot hold the queue.
//
// A studio with no active sequence is skipped before anything is read or
// stamped, so switching a sequence on later still welcomes everyone who
// arrived in the meantime.

import { triggerSequencesForUn1tAccountCreated } from '@/lib/sequences/triggers'
import { logInfo, logError } from '@/lib/log'

const MODULE = 'un1t-welcome'
const PAGE = 500
const MAX_PAGES = 10
export const NO_CONTACT_WAIT_MS = 48 * 3_600_000
export const CRM_EMAIL_GRACE_MS = 30 * 60_000

function emptyCounts() {
  return { ok: true, skipped_no_sequence: false, checked: 0, enrolled: 0, crm_made: 0, waiting: 0, no_contact: 0, no_email: 0, failed: 0 }
}

export async function sweepUn1tWelcomes(db, locationId, { now = () => new Date(), trigger = triggerSequencesForUn1tAccountCreated } = {}) {
  const out = emptyCounts()

  const { count, error: seqErr } = await db
    .from('email_sequences')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .eq('trigger_type', 'un1t_account_created')
    .eq('status', 'active')
  if (seqErr) {
    logError(MODULE, 'sequence lookup failed', { locationId, code: seqErr.code ?? null })
    out.ok = false
    return out
  }
  if (!count) {
    out.skipped_no_sequence = true
    return out
  }

  // Stamped rows leave the welcome_checked_at IS NULL filter, so the offset is
  // only the rows left unstamped (waiting, or a stamp that failed).
  let unstamped = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data: rows, error: readErr } = await db
      .from('un1t_clients')
      .select('id, un1t_user_id, contact_id, first_seen_at, account_email_sent_at, crm_written_at')
      .eq('location_id', locationId)
      .is('welcome_checked_at', null)
      .order('first_seen_at', { ascending: true })
      .order('id', { ascending: true })
      .range(unstamped, unstamped + PAGE - 1)
    if (readErr) {
      logError(MODULE, 'client read failed', { locationId, code: readErr.code ?? null })
      out.ok = false
      break
    }
    const batch = rows || []
    if (batch.length === 0) break

    const contactIds = [...new Set(batch.map((r) => r.contact_id).filter(Boolean))]
    const emailById = new Map()
    if (contactIds.length > 0) {
      const { data: contacts, error: cErr } = await db.from('contacts').select('id, email').in('id', contactIds)
      if (cErr) {
        logError(MODULE, 'contact read failed', { locationId, code: cErr.code ?? null })
        out.ok = false
        break
      }
      for (const c of contacts || []) emailById.set(c.id, c.email)
    }

    for (const row of batch) {
      out.checked++
      const nowMs = now().getTime()
      const age = nowMs - new Date(row.first_seen_at).getTime()

      let stampIt = true
      if (!row.contact_id) {
        if (age < NO_CONTACT_WAIT_MS) {
          out.waiting++
          stampIt = false
        } else {
          out.no_contact++
        }
      } else if (!String(emailById.get(row.contact_id) ?? '').trim()) {
        out.no_email++
      } else if (row.crm_written_at && !row.account_email_sent_at && age < CRM_EMAIL_GRACE_MS) {
        out.waiting++
        stampIt = false
      } else {
        const crmMade = !!row.account_email_sent_at
        let res
        try {
          res = await trigger(db, { contactId: row.contact_id, locationId, crmMade, un1tUserId: row.un1t_user_id })
        } catch (err) {
          res = { ok: false, reason: err?.name || 'threw' }
        }
        if (res?.ok) {
          out.enrolled += res.enrolled || 0
          if (crmMade) out.crm_made++
        } else {
          out.failed++
          // The reason can carry DB error text: log a short code only.
          logError(MODULE, 'enrol refused', { locationId, code: 'trigger_failed' })
          // A young client is retried next tick; an old one is given up on so a
          // permanently refused client cannot hold the queue.
          if (age < NO_CONTACT_WAIT_MS) stampIt = false
        }
      }

      if (!stampIt) {
        unstamped++
        continue
      }
      const { error: stampErr } = await db
        .from('un1t_clients')
        .update({ welcome_checked_at: now().toISOString() })
        .eq('id', row.id)
        .is('welcome_checked_at', null)
      if (stampErr) {
        out.ok = false
        unstamped++
        logError(MODULE, 'stamp failed', { locationId, code: stampErr.code ?? null })
      }
    }

    if (batch.length < PAGE) break
  }

  logInfo(MODULE, 'sweep done', { locationId, ...out })
  return out
}
