import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { generateReport, calculatePeriodForSchedule, calculateNextRun, buildReportEmailHtml } from '@/lib/report-generator'
import { sendTransactionalEmail } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/run-scheduled-reports
 * Called by Vercel Cron (or manually) to execute any scheduled reports that are due.
 * Secured by CRON_SECRET header check.
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

  if (!dueReports || dueReports.length === 0) {
    await stampHeartbeat('run-scheduled-reports')
    return NextResponse.json({ success: true, message: 'No reports due', processed: 0 })
  }

  const results = []

  for (const schedule of dueReports) {
    try {
      // Calculate the reporting period based on frequency
      const { period_start, period_end } = calculatePeriodForSchedule(schedule.frequency)

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
        const nextRun = calculateNextRun(schedule.frequency, schedule.day_of_week, schedule.day_of_month)

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
        if (schedule.deliver_email && schedule.email_recipients?.length > 0) {
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
              to: schedule.email_recipients.join(', '),
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
        }

        // If notification delivery is enabled, create an in-app notification
        if (schedule.deliver_notification) {
          await db.from('generated_reports')
            .update({ notification_sent: true })
            .eq('id', result.data.id)
          // The UI already shows generated reports in the Report History tab,
          // so "notification" = the report appearing in the list
        }
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
  await stampHeartbeat('run-scheduled-reports')

  return NextResponse.json({
    success: true,
    processed: results.length,
    results,
  })
}
