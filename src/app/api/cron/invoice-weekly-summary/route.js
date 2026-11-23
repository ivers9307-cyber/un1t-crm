// INVWEEKLY.1 — the weekly invoices email, Monday 08:00 in each studio's own
// zone (hourly schedule; the daily-slot gate claims one Monday slot per
// studio, local-anchored like receipt-coverage-weekly).
//
// For each studio whose slot this tick took: count what is waiting in its
// invoice queue and, when anything is, email the people who send invoices
// there (masters and bookkeepers assigned to the studio). A studio with
// nothing waiting, or nobody to email, is skipped. Nothing is changed and
// nothing is sent to Xero.
//
// defineCron owns the CRON_SECRET check, the error boundary and the heartbeat.
// A quiet tick (no slot due) never stamps; a tick that took a slot stamps
// unless the gate faulted or every studio it tried failed.

import { defineCron } from '@/lib/define-cron'
import { sendTransactionalEmail } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import { gateDailySlot, slotFor } from '@/lib/cron-daily-slot'
import {
  loadAwaitingRows, summariseAwaiting, countNotInvoiceSince,
  weeklySummaryRecipients, buildWeeklySummaryEmail,
} from '@/lib/invoices-queue/weekly-summary'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export const GET = defineCron({ heartbeat: 'invoice-weekly-summary' }, async ({ db }) => {
  const nowMs = Date.now()
  const gate = await gateDailySlot(db, 'invoice-weekly-summary', { nowMs, module: 'invoice-weekly-summary' })
  if (!gate.ok) return { ok: false, body: { error: 'locations unreadable', slot: gate.summary } }
  if (gate.slots.size === 0) {
    return { ok: !gate.faulted, stamp: false, body: { emails_sent: 0, perLocation: [], slot: gate.summary } }
  }

  const { data: locations, error: locErr } = await db
    .from('locations')
    .select('id, name')
    .eq('active', true)
  if (locErr) {
    logError('invoice-weekly-summary', 'failed to list locations', { err: locErr })
    return { ok: false, body: { error: 'Could not list locations' } }
  }

  const appUrl = getAppUrl()
  const sinceIso = new Date(nowMs - WEEK_MS).toISOString()
  let emailsSent = 0
  const perLocation = []

  for (const loc of locations || []) {
    if (!slotFor(gate.slots, loc.id)) continue // not this studio's Monday 08:00
    try {
      const summary = summariseAwaiting(await loadAwaitingRows(db, loc.id))
      if (summary.waiting === 0) {
        perLocation.push({ location_id: loc.id, ok: true, skipped: 'nothing_waiting' })
        continue
      }
      const recipients = await weeklySummaryRecipients(db, loc.id)
      if (recipients.length === 0) {
        logWarn('invoice-weekly-summary', 'invoices are waiting but nobody at the studio receives the summary', { locationId: loc.id, waiting: summary.waiting })
        perLocation.push({ location_id: loc.id, ok: true, skipped: 'no_recipients', waiting: summary.waiting })
        continue
      }
      const notInvoiceThisWeek = await countNotInvoiceSince(db, loc.id, sinceIso)
      const { subject, html } = buildWeeklySummaryEmail({ locationName: loc.name, summary, notInvoiceThisWeek, appUrl })
      let sent = 0
      for (const to of recipients) {
        try {
          await sendTransactionalEmail({ to, subject, htmlBody: html, locationId: loc.id, tag: 'invoice-weekly-summary' })
          sent++
        } catch (err) {
          logWarn('invoice-weekly-summary', 'send failed', { locationId: loc.id, err })
        }
      }
      emailsSent += sent
      perLocation.push({ location_id: loc.id, ok: sent > 0, waiting: summary.waiting, ready: summary.ready, recipients: recipients.length, sent })
    } catch (err) {
      logWarn('invoice-weekly-summary', 'summary failed for location', { locationId: loc.id, err })
      perLocation.push({ location_id: loc.id, ok: false, error: 'summary failed' })
    }
  }

  const allFailed = perLocation.length > 0 && perLocation.every((p) => !p.ok)
  if (allFailed) return { ok: false, body: { error: 'Every location failed', emails_sent: emailsSent, perLocation } }
  return { ok: !gate.faulted, body: { emails_sent: emailsSent, perLocation } }
})
