import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { generateReport, calculatePeriodForSchedule, calculateNextRun, buildReportEmailHtml } from '@/lib/report-generator'
import { sendTransactionalEmail } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logWarn } from '@/lib/log'
import { isRateReportType } from '@/lib/report-access'
import { filterRateReportRecipients } from '@/lib/report-recipients'
import { gateDailySlot, slotFor, slotTickStampable } from '@/lib/cron-daily-slot'
import { getLocationZones, DEFAULT_TZ } from '@/lib/location-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/run-scheduled-reports
 * Called by Vercel Cron (or manually) to execute any scheduled reports that are due.
 * Secured by CRON_SECRET header check.
 *
 * TZ.6 — the schedule is hourly. A schedule's location runs its due reports
 * (next_run_at <= now, unchanged) at its daily slot: 07:00 UTC for a
 * Europe/Dublin studio (as before), 07:00 local for any other zone, once per
 * local day (src/lib/cron-daily-slot.js). Computing next_run_at in the
 * studio's zone is TZ.11a's.
 */
export async function GET(request) {
  // Verify the request is from Vercel Cron or an authorized caller
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const now = new Date().toISOString()

  // TZ.6 — which locations are at their daily slot this tick (claimed, so
  // never twice in one local day). An unreadable zone acts for nobody.
  const gate = await gateDailySlot(db, 'run-scheduled-reports', { nowMs: Date.parse(now), module: 'run-scheduled-reports' })
  if (!gate.ok) return NextResponse.json({ success: false, error: 'locations unreadable', slot: gate.summary }, { status: 500 })
  if (gate.slots.size === 0) {
    // TZ.6: a quiet tick (no slot taken) never stamps, so the row keeps the legacy
    // clock; a faulted one (a claim write failed) answers 500 and the slot pages.
    return NextResponse.json({ success: !gate.faulted, message: 'No location at its daily slot', processed: 0, slot: gate.summary }, { status: gate.faulted ? 500 : 200 })
  }

  // Find all active scheduled reports where next_run_at <= now
  const { data: dueReports, error: fetchError } = await db.from('scheduled_reports')
    .select('*')
    .eq('active', true)
    .not('next_run_at', 'is', null)
    .lte('next_run_at', now)
    .order('next_run_at')

  if (fetchError) {
    return NextResponse.json({ success: false, error: fetchError.message }, { status: 500 })
  }

  // REPORTS.2 — a paused schedule is skipped. Filtered here rather than with
  // .eq('paused', false) on purpose: `select('*')` still works if this code
  // deploys before mig 617 adds the column, where a filter on it would 400
  // and stop EVERY schedule. A row without the field is not paused.
  const runnable = (dueReports || []).filter(r => r.paused !== true && slotFor(gate.slots, r.location_id))

  if (runnable.length === 0) {
    if (slotTickStampable(gate)) {
      await stampHeartbeat('run-scheduled-reports')
    }
    return NextResponse.json({ success: !gate.faulted, message: 'No reports due', processed: 0 }, { status: gate.faulted ? 500 : 200 })
  }

  // TZ.11a — each schedule's period and next run are its studio's calendar.
  // Zones are read once per tick. A failed read is a DB outage: no report runs
  // on a guessed zone; next_run_at is untouched, so the next tick retries.
  let zones
  try {
    zones = await getLocationZones(db, runnable.map((r) => r.location_id))
  } catch (err) {
    logError('run-scheduled-reports', 'locations.timezone unreadable; no schedule runs this tick', { err })
    return NextResponse.json({ success: false, error: 'locations unreadable' }, { status: 500 })
  }

  const results = []

  for (const schedule of runnable) {
    try {
      const zone = zones.get(schedule.location_id) ?? DEFAULT_TZ
      // Calculate the reporting period based on frequency
      const { period_start, period_end } = calculatePeriodForSchedule(schedule.frequency, zone)

      // Generate the report
      const result = await generateReport({
        report_type: schedule.report_type,
        period_start,
        period_end,
        location_id: schedule.location_id,
        generated_by: schedule.created_by,
        scheduled_report_id: schedule.id,
      })

      if (result.success) {
        // Calculate next run time
        const nextRun = calculateNextRun(schedule.frequency, schedule.day_of_week, schedule.day_of_month, zone)

        // Update the schedule: set last_run_at, advance next_run_at (or deactivate if 'once')
        const updateData = {
          last_run_at: now,
          updated_at: now,
        }

        if (schedule.frequency === 'once') {
          updateData.active = false
          updateData.next_run_at = null
        } else if (nextRun) {
          updateData.next_run_at = nextRun
        }

        await db.from('scheduled_reports')
          .update(updateData)
          .eq('id', schedule.id)

        const resultEntry = {
          id: schedule.id,
          report_type: schedule.report_type,
          report_name: schedule.report_name,
          status: 'generated',
          period: `${period_start} to ${period_end}`,
          next_run: nextRun || 'none (one-time)',
        }
        results.push(resultEntry)

        // If email delivery is enabled, send the summary to the recipient list.
        // Best-effort: a Postmark failure must not fail the cron tick or undo
        // the report we already generated — we stamp email_sent honestly
        // (true only on a confirmed send) and surface the outcome in `results`.
        //
        // STAFFCOST.1 — a rate-bearing report (staff_cost) is emailed only to
        // addresses allowed to see pay at this location; a head coach on the
        // list is dropped. See src/lib/report-recipients.js for the rule.
        let recipients = schedule.deliver_email ? (schedule.email_recipients || []) : []
        if (recipients.length > 0 && isRateReportType(schedule.report_type)) {
          // REPORTS.2 — an address matching no staff profile is sent only if
          // the owner confirmed it as external when saving the schedule.
          const { allowed, dropped } = await filterRateReportRecipients({
            db, locationId: schedule.location_id, recipients,
            confirmedExternal: schedule.confirmed_external_recipients,
          })
          recipients = allowed
          // Counts only — the addresses are staff PII and this body is logged.
          if (dropped.length > 0) resultEntry.recipients_withheld = dropped.length
        }
        if (recipients.length > 0) {
          let emailSent = false
          let emailError = null
          try {
            // getAppUrl() throws if NEXT_PUBLIC_APP_URL is unset — the CTA link
            // is optional, so fall back to a link-less email rather than erroring.
            let appUrl = null
            try { appUrl = getAppUrl() } catch { appUrl = null }

            const periodLabel = period_start === period_end
              ? period_start
              : `${period_start} to ${period_end}`

            await sendTransactionalEmail({
              // Recipients are staff email addresses (not CRM contacts), so one
              // transactional email to the comma-joined list — no contactId, so
              // it isn't logged to email_sends (which is keyed to contacts).
              to: recipients.join(', '),
              subject: `${schedule.report_name || result.data.report_name} — ${periodLabel}`,
              htmlBody: buildReportEmailHtml(result.data, { appUrl }),
              tag: 'scheduled-report',
            })
            emailSent = true
          } catch (e) {
            emailError = e?.message || String(e)
            console.error(`[run-scheduled-reports] email send failed for schedule ${schedule.id}: ${emailError}`)
          }

          await db.from('generated_reports')
            .update({ email_sent: emailSent })
            .eq('id', result.data.id)

          resultEntry.email = emailSent ? 'sent' : `failed: ${emailError}`
        } else if (resultEntry.recipients_withheld) {
          // Every address was withheld — say so rather than reading as "email off".
          resultEntry.email = 'withheld'
          // Schedule id and count only, never the addresses.
          logWarn('run-scheduled-reports', 'rate report email withheld from every recipient', {
            scheduleId: schedule.id, reportType: schedule.report_type, withheld: resultEntry.recipients_withheld,
          })
        }

        // REPORTS.2 — the "in-app notification" delivery option is gone. It
        // only ever stamped generated_reports.notification_sent = true; no
        // notification was created, and the report appears in Report History
        // whatever the flag says. No schedule in prod had it on (17 Sep), and
        // the save routes now refuse it.
      } else {
        results.push({
          id: schedule.id,
          report_type: schedule.report_type,
          status: 'error',
          error: result.error,
        })
      }
    } catch (err) {
      results.push({
        id: schedule.id,
        report_type: schedule.report_type,
        status: 'error',
        error: err.message,
      })
    }
  }

  // Heartbeat after the loop — even if individual reports errored, the cron
  // tick itself ran end-to-end. Per-report errors are surfaced in `results`.
  if (slotTickStampable(gate)) {
    await stampHeartbeat('run-scheduled-reports')
  }

  return NextResponse.json({
    success: !gate.faulted,
    processed: results.length,
    results,
  }, { status: gate.faulted ? 500 : 200 })
}
